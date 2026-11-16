// tests/round20-r10b-speed.spec.ts — r10b 一般模式加速＋鬼打牆處理
//   S-01  detectTokenLoop／trimRepeatTail：真的鬼打牆才停；老師真的重複（對、對、對／IgG、IgG）不誤判
//   S-02  planChunkWindows：VAD 語音段打包成 ≤30 秒；長段重疊切；沒 VAD 時與原本切法相同
//   S-03  estimateRemaining／plainDuration：最近幾段平均、不算第一段暖機；白話時間
//   S-04  真實 Worker 程式：給滿 max_new_tokens（跳過 seek）＋停止條件；太密才用完整模式重跑；鬼打牆 → 截尾 → 不帶提示詞重試一次
//   S-05  主程式：重疊區中點切邊界、量測日誌、剩餘時間白話；鬼打牆仍可疑 → 預覽待確認清單（可點跳轉）、匯出字幕無 ⚠、完成畫面一句話
//   S-06  介面：語言選單沒有「自動偵測」；短提示詞選項（預設關）只在一般模式生效
//   S-07  覆核 r1 M1：接縫文字對齊（stitchSeam）／逐字成句；M3 續傳秒數（resumeSecOf）
//   S-08  覆核 r1 M3／S6：舊格式續傳紀錄（只有段數）→ 以秒對齊、跨過的視窗照跑、待確認清單保留
//   S-09  覆核 r1 S9c：同一個打包視窗裡的多個語音段，每段段首字都在
//   S-10  覆核 r2 N1／N3／S-a／S-b：接縫共同片段要時間相符；老師的「對、對、對」不判成鬼打牆；長句迴圈；接縫空白判斷
//   S-11  覆核 r2 N2：接縫兩窗都沒輸出的空白 → 補聽一次補回；補聽失敗 → 待確認清單
import { test, expect, type Page } from '@playwright/test';
import { newCtx, openWithHook, installScriptedWorker, BASE_URL, type Seg } from './harness';
import { setToggles, downloadText } from './helpers';

const NAMES = ['WORKER_CODE', 'spawnWorker', 'detectTokenLoop', 'trimRepeatTail', 'planChunkWindows', 'estimateRemaining', 'plainDuration', 'WHISPER_MAX_TARGET', 'stitchSeam', 'wordsToLines', 'resumeSecOf', 'clockText', 'tailLoopLike', 'seamGapRange', 'mostlyVoiced'];

async function runInWorker(page: Page, body: string) {
  return page.evaluate(async (body) => {
    const code = (window as any).__t.WORKER_CODE + '\n;(async () => { try { const out = await (async () => {' + body + '})(); self.postMessage({ type: "T_OK", out }); } catch (err) { self.postMessage({ type: "T_ERR", err: String(err && err.message || err) }); } })();';
    const w = (window as any).__t.spawnWorker(code);
    return await new Promise<any>((res) => {
      const t = setTimeout(() => { w.terminate(); res({ type: 'TIMEOUT' }); }, 60_000);
      w.addEventListener('message', (e: any) => { if (e.data?.type === 'T_OK' || e.data?.type === 'T_ERR') { clearTimeout(t); w.terminate(); res(e.data); } });
    });
  }, body);
}

function wav(sec: number): Buffer {
  const n = 16000 * sec, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 10)), 44 + i * 2);
  return b;
}

test.describe('r10b 純函式', () => {
  test('S-01 鬼打牆判斷只看新 token；正常重複不誤判；截尾只留第一次', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await openWithHook(ctx, NAMES, 'new');
    const r = await page.evaluate(() => {
      const T = (window as any).__t; const d = T.detectTokenLoop;
      const seq = (unit: number[], n: number, head: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) => head.concat(...Array(n).fill(unit));
      return {
        normal: d([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 30),
        dui3: d(seq([500, 501], 3), 30),            // 對、對、對
        igg4: d(seq([600, 601, 602], 4), 30),        // IgG、IgG、IgG、IgG（3 token 單位重複 4 次）
        same11: d(seq([7], 11), 30),
        same12: d(seq([7], 12, [1, 2]), 30),
        k2x5: d(seq([800, 801], 5), 30),             // 射音，×5 還不算
        k2x6: d(seq([800, 801], 6), 30),             // 射音，×6 → 鬼打牆
        k4x4: d(seq([1, 2, 3, 4], 4, [9]), 30),
        k4x5: d(seq([1, 2, 3, 4], 5, [9]), 30),
        // 覆核 r1 S9d：whisper-base tokenizer 實際切法（覆核實測）：「對、對、對、對、對」= [2855,1231]×4＋2855；「對對對對對」= [44268,44268,2855]
        dui5real: d([1, 2, 3].concat([2855, 1231, 2855, 1231, 2855, 1231, 2855, 1231, 2855]), 30),
        dui6real: d([1, 2, 3].concat([2855, 1231, 2855, 1231, 2855, 1231, 2855, 1231, 2855, 1231, 2855]), 30),
        dui7real: d([1, 2, 3].concat([2855, 1231, 2855, 1231, 2855, 1231, 2855, 1231, 2855, 1231, 2855, 1231, 2855]), 30),
        duiNoSep: d([1, 2, 3, 44268, 44268, 2855], 30),
        igg4real: d(seq([600, 601, 602, 603], 4), 30),   // 「IgG、」= 4 個單位，連說 4 次不誤判
        sent12x3: d(seq([300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311], 3), 30),   // 整句（12 個單位）重複 3 次
        sent12x2: d(seq([300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311], 2), 30),
        budget: d([1, 2, 3], 30, 361), budgetOk: d([1, 2, 3], 30, 360), budgetShort: d([1, 2, 3], 1, 49),
        trim: T.trimRepeatTail(['今天', '講', '射音', '，', '射音', '，', '射音', '，', '射音', '，'].map((t) => ({ text: t, timestamp: [0, 1] }))),
        keep: T.trimRepeatTail(['對', '、', '對', '、', '我們', '開始'].map((t) => ({ text: t, timestamp: [0, 1] }))),
      };
    });
    expect(r.normal).toBeNull(); expect(r.dui3).toBeNull(); expect(r.igg4).toBeNull(); expect(r.same11).toBeNull();
    expect(r.same12).toBe('repeat1'); expect(r.k2x5).toBeNull(); expect(r.k2x6).toBe('repeat2'); expect(r.k4x4).toBeNull(); expect(r.k4x5).toBe('repeat4');
    expect(r.dui5real).toBeNull(); expect(r.dui6real).toBeNull(); expect(r.dui7real).toBe('repeat2'); expect(r.duiNoSep).toBeNull(); expect(r.igg4real).toBeNull();
    expect(r.sent12x3).toBe('repeat12'); expect(r.sent12x2).toBeNull();
    expect(r.budget).toBe('budget'); expect(r.budgetOk).toBeNull(); expect(r.budgetShort).toBe('budget');
    expect(r.trim.chunks.map((c: any) => c.text).join('')).toBe('今天講射音，'); expect(r.trim.removed).toBe(6);
    expect(r.keep.removed).toBe(0);
    await ctx.close();
  });

  test('S-02 視窗規劃：VAD 語音段打包成 ≤30 秒；長段重疊切；沒有 VAD 時與原本相同', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await openWithHook(ctx, NAMES, 'new');
    const r = await page.evaluate(() => {
      const P = (window as any).__t.planChunkWindows;
      return {
        none: P(70, null, 30, 5),
        vad: P(100, [{ start: 1, end: 4 }, { start: 8, end: 12 }, { start: 20, end: 23 }, { start: 40, end: 75 }, { start: 90, end: 91 }], 30, 5),
        tiny: P(10, [{ start: 0.5, end: 1 }, { start: 2, end: 3 }, { start: 9, end: 12 }], 30, 5),
        empty: P(0, null, 30, 5),
        short: P(30, [{ start: 1, end: 5 }, { start: 6.5, end: 10 }, { start: 11, end: 12.5 }, { start: 15, end: 20 }], 30, 5),   // 1.5、1 秒停頓合併；2.5 秒不合併
        cap: P(40, [{ start: 0, end: 14 }, { start: 15, end: 28 }, { start: 29, end: 40 }], 30, 5),   // 停頓短但超過 30 秒 → 另起一窗
      };
    });
    expect(r.none).toEqual([{ startSec: 0, endSec: 30, leadSec: 0 }, { startSec: 25, endSec: 55, leadSec: 5 }, { startSec: 50, endSec: 70, leadSec: 5 }]);
    // 覆核 r1 M4：停頓 >2 秒不合併（長靜音不送進模型）
    expect(r.vad).toEqual([{ startSec: 1, endSec: 4, leadSec: 0 }, { startSec: 8, endSec: 12, leadSec: 0 }, { startSec: 20, endSec: 23, leadSec: 0 }, { startSec: 40, endSec: 70, leadSec: 0 }, { startSec: 65, endSec: 75, leadSec: 5 }, { startSec: 90, endSec: 91, leadSec: 0 }]);
    expect(r.tiny).toEqual([{ startSec: 0.5, endSec: 3, leadSec: 0 }, { startSec: 9, endSec: 10, leadSec: 0 }]);   // 停頓 1 秒合併；超出音訊長度的語音段被截到結尾
    expect(r.short).toEqual([{ startSec: 1, endSec: 12.5, leadSec: 0 }, { startSec: 15, endSec: 20, leadSec: 0 }]);
    expect(r.cap).toEqual([{ startSec: 0, endSec: 28, leadSec: 0 }, { startSec: 29, endSec: 40, leadSec: 0 }]);
    expect(r.empty).toEqual([]);
    await ctx.close();
  });

  test('S-03 剩餘時間：最近幾段平均（不算第一段暖機）；白話時間', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await openWithHook(ctx, NAMES, 'new');
    const r = await page.evaluate(() => {
      const T = (window as any).__t;
      const s = [{ audioSec: 30, ms: 60000 }].concat(Array(10).fill({ audioSec: 30, ms: 6000 }));
      return {
        e: T.estimateRemaining(s, 600), one: T.estimateRemaining([{ audioSec: 30, ms: 15000 }], 60), none: T.estimateRemaining([], 60),
        d: [30, 90, 600, 3600, 4800].map(T.plainDuration),
      };
    });
    expect(r.e.secPerAudioSec).toBeCloseTo(0.2, 5); expect(r.e.remainSec).toBeCloseTo(120, 5);
    expect(r.one.remainSec).toBeCloseTo(30, 5); expect(r.none).toBeNull();
    expect(r.d).toEqual(['不到 1 分鐘', '約 2 分鐘', '約 10 分鐘', '約 1 小時', '約 1 小時 20 分']);
    await ctx.close();
  });
});

test.describe('r10b Worker', () => {
  test('S-04 RUN_CHUNK：給滿 max_new_tokens＋停止條件；太密 → 完整模式重跑；鬼打牆 → 截尾、不帶提示詞重試一次', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await openWithHook(ctx, NAMES, 'new');
    const res = await runInWorker(page, `
      // 模仿 Transformers.js 的 Callable：實例本身可被呼叫
      StoppingCriteriaCls = class { constructor() { const f = function () { return f._call.apply(f, arguments); }; return Object.setPrototypeOf(f, new.target.prototype); } };
      const calls = []; let script = null;
      const INIT = [50258, 50260, 50359];
      pipe = async function (audio, opts) {
        // 與 Transformers.js 4.3.0 相同：opts.stopping_criteria 會被丟掉，停止條件只能從 model._get_stopping_criteria() 拿到
        const L = pipe.model._get_stopping_criteria(null, opts.stopping_criteria);
        const crit = L.list[0];
        const c = { max_new_tokens: opts.max_new_tokens, hasStop: !!crit, prompt: !!opts.decoder_input_ids };
        calls.push(c);
        const r = script(c, calls.length);
        // 依腳本一個一個吐 token，交給停止條件判斷
        const ids = (opts.decoder_input_ids || INIT).slice();
        const lim = opts.max_new_tokens || 999;
        for (let i = 0; i < r.tokens.length && i < lim; i++) {
          ids.push(BigInt(r.tokens[i]));
          if (crit && crit([ids])[0]) break;
        }
        return { text: r.chunks.map(function (x) { return x.text; }).join(''), chunks: r.chunks };
      };
      pipe.tokenizer = { encode: function () { return [11, 12, 13]; }, convert_tokens_to_ids: function (t) { return t === '<|startofprev|>' ? 50361 : null; } };
      pipe.model = {
        generation_config: { eos_token_id: 50257, no_timestamps_token_id: 50363 },
        _get_stopping_criteria: function () { return { list: [], push: function (x) { this.list.push(x); } }; },
        _prepare_generation_config: function (g, k) { return { eos_token_id: 50257, decoder_start_token_id: 50258, return_timestamps: k.return_timestamps }; },
        _retrieve_init_tokens: function () { return INIT; },
      };
      const out = []; const post = self.postMessage.bind(self);
      self.postMessage = function (m) { out.push(m); };
      const run = async function (promptText, sec) {
        self.dispatchEvent(new MessageEvent('message', { data: { type: 'RUN_CHUNK', payload: { audioData: new Float32Array(16000 * (sec || 30)).buffer, language: 'zh', task: 'transcribe', promptText: promptText, segIdx: 0, startSec: 0 } } }));
        await new Promise(function (r) { setTimeout(r, 60); });
      };
      const W = function (t, a) { return { text: t, timestamp: [a, a + 0.5] }; };
      const normal = { tokens: [100, 101, 102, 50257], chunks: [W('今天', 0), W('上課', 1)] };
      const full = { tokens: [100, 101, 102, 50257], chunks: [W('今天', 0), W('上課', 1), W('講細胞激素', 20)] };
      const loopy = { tokens: [100].concat(Array(20).fill(0).map(function (_, i) { return i % 2 ? 801 : 800; })), chunks: [W('今天', 0)].concat(Array(10).fill(0).map(function (_, i) { return W(i % 2 ? '，' : '射音', 2 + i * 0.4); })) };
      const dense = { tokens: Array(500).fill(0).map(function (_, i) { return 1000 + i; }), chunks: [W('很密', 0)] };
      const res = {};
      // 1) 正常：只跑一次、給滿 448 − 3 − 1 = 444、有停止條件、不重試
      calls.length = 0; out.length = 0; script = function () { return normal; }; await run(null);
      res.restored = !Object.prototype.hasOwnProperty.call(pipe.model, '__never'); res.normal = { ownAfter: Object.keys(pipe.model).filter(function (k) { return k === '_get_stopping_criteria'; }).length, calls: calls.slice(), stats: out.filter(function (m) { return m.type === 'CHUNK_DONE'; })[0].payload.stats };
      // 2) 太密（用完空間仍沒講完、不是鬼打牆）：同一段改用完整模式（不給 max_new_tokens＝seek）重跑一次
      calls.length = 0; out.length = 0; script = function (c) { return c.max_new_tokens ? { tokens: Array(500).fill(0).map(function (_, i) { return 1000 + (i % 97) * 3 + (i % 5); }), chunks: [W('很密', 0)] } : normal; }; await run(null, 60);
      res.dense = { calls: calls.slice(), stats: out.filter(function (m) { return m.type === 'CHUNK_DONE'; })[0].payload.stats };
      // 3) 鬼打牆＋有提示詞：截尾 → 不帶提示詞重試，重試正常 → 採用
      calls.length = 0; out.length = 0; script = function (c) { return c.prompt ? loopy : full; }; await run('短提示');
      const d3 = out.filter(function (m) { return m.type === 'CHUNK_DONE'; })[0].payload;
      res.retryOk = { calls: calls.slice(), stats: d3.stats, text: d3.result.chunks.map(function (x) { return x.text; }).join('') };
      // 4) 鬼打牆＋重試還是鬼打牆：保留截短版、標記待確認
      calls.length = 0; out.length = 0; script = function () { return loopy; }; await run('短提示');
      const d4 = out.filter(function (m) { return m.type === 'CHUNK_DONE'; })[0].payload;
      res.retryBad = { calls: calls.slice(), stats: d4.stats, text: d4.result.chunks.map(function (x) { return x.text; }).join('') };
      // 5) 鬼打牆、沒有提示詞：重試結果會一模一樣 → 不重試，直接標記
      calls.length = 0; out.length = 0; script = function () { return loopy; }; await run(null);
      res.noPrompt = { calls: calls.slice(), stats: out.filter(function (m) { return m.type === 'CHUNK_DONE'; })[0].payload.stats };
      // 6) 覆核 r1 M2：一般模式每句前後夾著遞增時間戳的迴圈（射音×N）＋有提示詞 → 濾掉時間戳後判定鬼打牆，不是「話太密」
      const tsLoop = { tokens: [100].concat.apply([100], Array(40).fill(0).map(function (_, i) { return [50364 + i * 2, 800, 801, 802, 50365 + i * 2]; })), chunks: [W('今天', 0)].concat(Array(30).fill(0).map(function (_, i) { return W(i % 3 === 2 ? '，' : (i % 3 ? '音' : '射'), 1 + i * 0.3); })) };
      calls.length = 0; out.length = 0; script = function (c) { return c.prompt ? tsLoop : full; }; await run('長提示');
      res.tsLoop = { calls: calls.slice(), stats: out.filter(function (m) { return m.type === 'CHUNK_DONE'; })[0].payload.stats };
      // 7) 覆核 r1 M2：整句很長（25 個單位）的迴圈，停止條件抓不到、用完空間 → 先看文字尾端重複 → 當鬼打牆（不改跑完整模式）
      const longUnit = Array(25).fill(0).map(function (_, i) { return 2000 + i; });
      const longLoop = { tokens: [].concat.apply([], Array(20).fill(longUnit)), chunks: [W('今天', 0)].concat([].concat.apply([], Array(5).fill(0).map(function (_, r) { return [W('細胞', 2 + r * 2), W('激素', 2.5 + r * 2), W('受體', 3 + r * 2), W('，', 3.4 + r * 2)]; }))) };
      calls.length = 0; out.length = 0; script = function (c) { return c.prompt ? longLoop : full; }; await run('長提示', 60);
      res.longLoop = { calls: calls.slice(), stats: out.filter(function (m) { return m.type === 'CHUNK_DONE'; })[0].payload.stats, extend: out.filter(function (m) { return m.type === 'CHUNK_EXTEND'; }).length };
      // 7b) 覆核 r2 S-a：比停止條件看得到的還長（60 個單位）的整句迴圈 → 用完空間 → 文字尾端整句重複 ≥3 次 → 當鬼打牆
      const u60 = Array(60).fill(0).map(function (_, i) { return 3000 + i; });
      const longLoop2 = { tokens: [].concat.apply([], Array(8).fill(u60)), chunks: [W('今天', 0)].concat([].concat.apply([], Array(5).fill(0).map(function (_, r) { return [W('細胞', 2 + r * 3), W('激素', 2.4 + r * 3), W('受體', 2.8 + r * 3), W('會', 3.2 + r * 3), W('活化', 3.5 + r * 3), W('，', 3.9 + r * 3)]; }))) };
      calls.length = 0; out.length = 0; script = function (c) { return c.prompt ? longLoop2 : full; }; await run('長提示', 60);
      res.longLoop2 = { calls: calls.slice(), stats: out.filter(function (m) { return m.type === 'CHUNK_DONE'; })[0].payload.stats };
      // 8) 覆核 r1 S3：迴圈在段尾（後面不到 1 秒）→ 只截掉、不標記
      const endLoop = { tokens: [100].concat(Array(20).fill(0).map(function (_, i) { return i % 2 ? 801 : 800; })), chunks: [W('今天', 0)].concat(Array(10).fill(0).map(function (_, i) { return W(i % 2 ? '，' : '射音', 28.5 + i * 0.1); })) };
      calls.length = 0; out.length = 0; script = function () { return endLoop; }; await run(null);
      res.endLoop = { stats: out.filter(function (m) { return m.type === 'CHUNK_DONE'; })[0].payload.stats };
      // 9) 覆核 r1 S4：字很多但沒有重複（預算觸發）→ 不算鬼打牆，照「話太密」改用完整模式（不看預算）
      calls.length = 0; out.length = 0; script = function (c) { return c.max_new_tokens ? dense : normal; }; await run(null, 10);
      res.budgetDense = { calls: calls.slice(), stats: out.filter(function (m) { return m.type === 'CHUNK_DONE'; })[0].payload.stats };
      // 10) 覆核 r1 S9a：真實情況 _get_stopping_criteria 在 prototype 上 → 呼叫完 delete 還原；fn 丟例外也要還原
      const Proto = function () {}; Proto.prototype._get_stopping_criteria = function () { return []; };
      const keep = pipe.model; pipe.model = new Proto();
      await _runWithStop({}, async function () { return 1; });
      const afterOk = Object.prototype.hasOwnProperty.call(pipe.model, '_get_stopping_criteria');
      let threw = false; try { await _runWithStop({}, async function () { throw new Error('boom'); }); } catch (_) { threw = true; }
      res.proto = { afterOk: afterOk, threw: threw, afterErr: Object.prototype.hasOwnProperty.call(pipe.model, '_get_stopping_criteria'), list: pipe.model._get_stopping_criteria().length };
      pipe.model = keep;
      self.postMessage = post;
      return res;
    `);
    expect(res.type, JSON.stringify(res)).toBe('T_OK');
    const o = res.out;
    expect(o.normal.ownAfter).toBe(1);   // 呼叫完還原成原本的函式（測試替身本來就有這個屬性）
    expect(o.normal.calls).toEqual([{ max_new_tokens: 444, hasStop: true, prompt: false }]);
    expect(o.normal.stats).toMatchObject({ loop: null, retried: false, flagged: false, mode: 'fast', newTokens: 4 });
    expect(o.normal.stats.ms).toBeGreaterThanOrEqual(0); expect(o.normal.stats.audioSec).toBe(30);
    expect(o.dense.calls.length).toBe(2); expect(o.dense.calls[1].max_new_tokens).toBeUndefined();
    expect(o.dense.stats.mode).toBe('seek-retry'); expect(o.dense.stats.flagged).toBe(false);
    // 有提示詞時起始序列 = 1 + 3 + 3 = 7 → 448 − 7 − 1 = 440
    expect(o.retryOk.calls).toEqual([{ max_new_tokens: 440, hasStop: true, prompt: true }, { max_new_tokens: 444, hasStop: true, prompt: false }]);
    expect(o.retryOk.stats).toMatchObject({ loop: 'repeat2', retried: true, retryOk: true, flagged: false });
    expect(o.retryOk.text).toBe('今天上課講細胞激素');
    expect(o.retryBad.calls.length).toBe(2);
    expect(o.retryBad.stats).toMatchObject({ loop: 'repeat2', retried: true, retryOk: false, flagged: true });
    expect(o.retryBad.text).toBe('今天射音，');
    expect(o.retryBad.stats.loopTrimmed).toBeGreaterThan(0); expect(o.retryBad.stats.lostSec).toBeGreaterThan(20);
    expect(o.noPrompt.calls.length).toBe(1);
    expect(o.noPrompt.stats).toMatchObject({ loop: 'repeat2', retried: false, flagged: true });
    expect(o.tsLoop.stats).toMatchObject({ loop: 'repeat3', mode: 'fast', retried: true, retryOk: true });
    expect(o.tsLoop.calls.length).toBe(2); expect(o.tsLoop.calls[1].prompt).toBe(false);
    expect(o.longLoop.stats).toMatchObject({ loop: 'repeat25', mode: 'fast', retried: true, retryOk: true });   // 覆核 r2 S-a：停止條件已能抓 25 個單位的整句
    expect(o.longLoop2.stats).toMatchObject({ loop: 'repeatText', mode: 'fast', retried: true, retryOk: true });
    expect(o.longLoop2.calls.every((c: any) => c.max_new_tokens)).toBe(true);
    expect(o.longLoop.calls.every((c: any) => c.max_new_tokens)).toBe(true);   // 沒有改跑完整模式
    expect(o.longLoop.extend).toBe(1);   // 重試前通知主執行緒重設逾時（S13）
    expect(o.endLoop.stats).toMatchObject({ loop: 'repeat2', flagged: false }); expect(o.endLoop.stats.lostSec).toBeLessThan(1);
    expect(o.budgetDense.stats).toMatchObject({ loop: null, mode: 'seek-retry', flagged: false });
    expect(o.proto).toEqual({ afterOk: false, threw: true, afterErr: false, list: 0 });
    await ctx.close();
  });
});

test.describe('r10b 主程式與畫面', () => {
  test('S-05 接縫文字對齊（不漏不重）、量測日誌、剩餘時間；鬼打牆仍可疑 → 預覽待確認（可點跳轉）、字幕檔無 ⚠、完成畫面一句話', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    // 60 秒、不開 VAD → 視窗 [0,30] [25,55] [50,60]，重疊區 [25,30]、[50,55]
    //  接縫 1：兩窗都聽到「丙丁戊己」→ 文字對齊，只出現一次
    //  接縫 2（覆核 r1 M1 的漏字情境）：後一窗跳過開頭半句（第一個字在 54.5 秒），前一窗中點（52.5）之後的「乙尾句」不可丟
    const segs: Seg[] = [
      [{ text: 'A開頭', timestamp: [0.5, 1] }, { text: '甲乙丙丁', timestamp: [26.0, 27.0] }, { text: '戊己', timestamp: [28.0, 28.6] }],
      [{ text: '丙丁', timestamp: [1.2, 1.8] }, { text: '戊己', timestamp: [3.0, 3.6] }, { text: 'B中', timestamp: [10, 10.5] }, { text: '乙尾句', timestamp: [28.0, 28.8] }],
      [{ text: 'C後半', timestamp: [4.5, 5.2] }, { text: 'C中', timestamp: [7.0, 7.5] }],
    ];
    const st = (o: any) => ({ ms: 6000, audioSec: 30, enc: 1, dec: 120, newTokens: 118, loop: null, loopTrimmed: 0, mode: 'fast', retried: false, retryOk: false, flagged: false, lostSec: 0, keptEnd: 10, ...o });
    await installScriptedWorker(page, { segments: segs, rules: [
      { segIdx: 0, stats: st({}) },
      { segIdx: 1, stats: st({ loop: 'repeat2', loopTrimmed: 12, retried: true, retryOk: false, flagged: true, lostSec: 19.5, keptEnd: 10.5 }) },
      { segIdx: 2, stats: st({ audioSec: 10, ms: 2000 }) },
    ] });
    await page.goto(BASE_URL);
    await page.locator('.model-btn[data-model="Xenova/whisper-base"]').click();
    await setToggles(page, [], ['tog_vad', 'tog_uvr', 'tog_diarization', 'tog_hallucination']);
    await page.locator('#fileInput').setInputFiles({ name: 'mid.wav', mimeType: 'audio/wav', buffer: wav(60) });
    await page.locator('#startBtn').click();
    await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 60_000 });
    const txt = await downloadText(page);
    for (const k of ['A開頭', '甲乙丙丁', '戊己', 'B中', '乙尾句', 'C後半', 'C中']) expect(txt, `缺少 ${k}`).toContain(k);
    expect(txt.split('丙丁').length - 1, '丙丁 重複').toBe(1);
    expect(txt.split('戊己').length - 1, '戊己 重複').toBe(1);
    expect(txt).not.toContain('⚠');
    const log = await page.locator('#logBox').innerText();
    expect(log).toContain('⏲ 段落 1：30.0 秒音訊花 6.0 秒（模型讀音訊 1 次、產生 118 個字詞單位）');
    expect(log).toContain('這段一直重複同一句話或同一個詞，已提早停止、截掉 12 個重複字詞；不帶提示詞重試一次：仍不理想，保留截短後的版本；已標記待確認（後面約 19.5 秒可能漏字）');
    expect(log).toContain('其中 1 段出現重複迴圈（1 段標記待確認）');
    expect(log).not.toMatch(/token|n-gram/i);
    await expect(page.locator('#uvrNotice')).toContainText('有 1 段可能漏字');
    // 預覽：待確認清單，點一下跳到該時間
    const id = await page.locator('.batch-item.done').first().getAttribute('data-id');
    await page.locator(`.batch-item-preview-btn[data-id="${id}"]`).click();
    const panel = page.locator(`.item-preview-panel[data-id="${id}"]`);
    await expect(panel.locator('.preview-review-title')).toContainText('有 1 段可能漏字');
    await expect(panel.locator('.preview-review-item')).toHaveCount(1);
    await expect(panel.locator('.preview-review-item')).toContainText('這段一直重複同一句話或同一個詞，已自動截掉，可能漏字');
    const box = await panel.locator('.preview-review-item').boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(24);
    await panel.locator('.preview-review-item').click();
    const t = await panel.locator('.preview-media-el').evaluate((m: HTMLMediaElement) => m.currentTime);
    expect(t).toBeGreaterThanOrEqual(25); expect(t).toBeLessThan(40);
    await ctx.close();
  });

  test('S-06 語言選單沒有「自動偵測」；短提示詞選項預設關、開啟後一般模式送 80、顯示卡模式仍送 200', async ({ browser }) => {
    test.setTimeout(120_000);
    for (const backend of ['wasm', 'webgpu'] as const) {
      const ctx = await newCtx(browser); const page = await ctx.newPage();
      await installScriptedWorker(page, { segments: [[{ text: '好', timestamp: [0, 1] }]], backend });
      await page.addInitScript(() => {
        const W = (window as any).Worker;
        // 記錄送給 Worker 的 promptMaxTokens
        (window as any).__pmt = [];
        (window as any).Worker = class extends W { postMessage(m: any) { if (m && m.type === 'RUN_CHUNK') (window as any).__pmt.push(m.payload.promptMaxTokens); return super.postMessage(m); } };
      });
      await page.goto(BASE_URL);
      const opts = await page.locator('#language option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
      expect(opts).not.toContain('');
      expect(await page.locator('#language option').allInnerTexts()).not.toContain('自動偵測');
      expect(await page.locator('#tog_short_prompt').isChecked()).toBe(false);
      await expect(page.locator('#shortPromptRow')).toContainText('沒有顯示卡時用短提示詞');
      await page.locator('.model-btn[data-model="Xenova/whisper-base"]').click();
      await setToggles(page, [], ['tog_vad', 'tog_uvr', 'tog_medical']);
      await page.locator('#initialPrompt').fill('MHC 與 T 細胞');
      await page.locator('#tog_short_prompt').check();
      await page.locator('#fileInput').setInputFiles({ name: 'p.wav', mimeType: 'audio/wav', buffer: wav(5) });
      await page.locator('#startBtn').click();
      await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 60_000 });
      const pmt = await page.evaluate(() => (window as any).__pmt);
      expect(pmt.length).toBeGreaterThan(0);
      expect(pmt[0]).toBe(backend === 'wasm' ? 80 : 200);
      await ctx.close();
    }
  });
});

test.describe('r10b 第 1 輪覆核修正', () => {
  test('S-07 接縫文字對齊（M1）、逐字成句、續傳秒數（M3）', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await openWithHook(ctx, NAMES, 'new');
    const r = await page.evaluate(() => {
      const T = (window as any).__t; const S = T.stitchSeam;
      const w = (text: string, s: number, e?: number) => ({ text, s, e: e ?? s + 0.4 });
      const join = (A: any[], B: any[], ovEnd: number) => { const m = S(A, B, ovEnd); return { how: m.how, text: A.slice(0, m.keepPrev).concat(B.slice(m.nextFrom)).map((x: any) => x.text).join('') }; };
      return {
        // 兩窗都聽到同一句（標點不同、逐字切法不同）→ 對齊後只出現一次
        same: join([w('第4.5節', 50.5), w('鳥類', 51.5), w('第4.6節', 52.6), w('假科', 53.6)], [w('鳥類', 51.4), w('，', 51.9), w('第4.6', 52.5), w('節', 53.0), w('假科', 53.6), w('動物', 54.4), w('下一句', 56)], 55),
        // 覆核 r1 實例（79.5 秒）：後一窗跳過開頭半句 → 前一窗的「覆模由盤光鍵」不可丟
        skip: join([w('有其正中任的', 78.4), w('覆模由盤光鍵', 79.6, 80.8)], [w('顏深製覆壁形成', 81.2)], 80),
        // 後一窗在重疊區沒有字 → 前一窗全留
        nextEmpty: join([w('甲', 76), w('乙', 77)], [w('丙', 81)], 80),
        // 前一窗在重疊區沒有字 → 後一窗全留（不再丟前 2.5 秒）
        prevEmpty: join([], [w('丙', 75.3), w('丁', 77)], 80),
        // 對不上（同一段話兩窗聽成不同字）→ 前一窗全留、後一窗只留更晚的字（寧重勿漏）
        // 覆核 r1 實例（154.5 秒）：數字兩窗聽法不同 → 用共同的「五毫米」接起來，數字不重複
        num: join([w('三制五毫米', 153.0, 154.2)], [w('三點五', 153.1), w('毫米', 153.9), w('厚度', 154.4)], 155),
        noMatch: join([w('甲乙', 78, 79)], [w('丙丁', 78.2), w('戊', 79.5)], 80),
        lines: T.wordsToLines([w('a', 0, 0.3), w('b', 0.5, 0.8), w('c', 2, 2.3)], 0.5, 35),
        rs: [T.resumeSecOf(42.5, [], 3), T.resumeSecOf(undefined, [{ text: 'x', timestamp: [10, 61.2] }, { text: 'y', timestamp: [62, null] }], 3), T.resumeSecOf(undefined, [], 4), T.resumeSecOf(undefined, [], 0)],
        clock: [T.clockText(750), T.clockText(3725), T.clockText(5)],
      };
    });
    expect(r.same).toEqual({ how: 'text', text: '第4.5節鳥類第4.6節假科動物下一句' });
    expect(r.skip.text).toBe('有其正中任的覆模由盤光鍵顏深製覆壁形成');
    expect(r.nextEmpty).toEqual({ how: 'next-empty', text: '甲乙丙' });
    expect(r.prevEmpty).toEqual({ how: 'prev-empty', text: '丙丁' });
    expect(r.num).toEqual({ how: 'text', text: '三制五毫米厚度' });
    expect(r.noMatch).toEqual({ how: 'time', text: '甲乙戊' });
    expect(r.lines).toEqual([{ text: 'ab', timestamp: [0, 0.8] }, { text: 'c', timestamp: [2, 2.3] }]);
    expect(r.rs).toEqual([42.5, 62, 0, null]);
    expect(r.clock).toEqual(['12:30', '1:02:05', '0:05']);
    await ctx.close();
  });

  test('S-08 舊格式續傳紀錄（只有段數）→ 以秒對齊、跨過的視窗照跑只丟之前的字；待確認清單保留', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    // 100 秒、不開 VAD → 視窗 [0,30] [25,55] [50,80] [75,100]。舊紀錄寫「做完 3 段」，但字幕只到 40 秒（舊切法不同）
    const segs: Seg[] = [
      [{ text: 'W0', timestamp: [1, 2] }],
      [{ text: 'W1已做', timestamp: [10, 11] }, { text: 'W1接續', timestamp: [16, 17] }, { text: 'W1尾', timestamp: [28, 29] }],
      [{ text: 'W2中', timestamp: [10, 11] }],
      [{ text: 'W3中', timestamp: [10, 11] }],
    ];
    await installScriptedWorker(page, { segments: segs });
    await page.goto(BASE_URL);
    await page.locator('.model-btn[data-model="Xenova/whisper-base"]').click();
    await setToggles(page, [], ['tog_vad', 'tog_uvr', 'tog_diarization', 'tog_hallucination']);
    await page.evaluate(() => document.addEventListener('change', (e: any) => { if (e.target?.id === 'fileInput') (window as any).__f = e.target.files[0]; }, true));
    await page.locator('#fileInput').setInputFiles({ name: 'resume.wav', mimeType: 'audio/wav', buffer: wav(100) });
    await page.evaluate(() => {
      const f = (window as any).__f;
      (window as any)._resumeTask = { fileName: f.name, fileSize: f.size, fileLastModified: f.lastModified, lastChunkIdx: 3, startedAt: Date.now(),
        chunks: [{ text: '舊字幕', timestamp: [20, 40] }], reviewMarks: [{ startSec: 12, endSec: 30, reason: '這段一直重複同一句話或同一個詞，已自動截掉，可能漏字' }] };
    });
    await page.locator('#startBtn').click();
    await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 60_000 });
    const ran = await page.evaluate(() => (window as any).__workerLog.filter((x: any) => x.type === 'RUN_CHUNK').map((x: any) => x.segIdx));
    expect(ran).toEqual([1, 2, 3]);   // 舊做法會直接從第 4 段（idx 3）開始，40～75 秒整段消失
    const txt = await downloadText(page);
    for (const k of ['舊字幕', 'W1接續', 'W1尾', 'W2中', 'W3中']) expect(txt, `缺少 ${k}`).toContain(k);
    for (const k of ['W0', 'W1已做']) expect(txt, `${k} 在續傳點之前`).not.toContain(k);
    expect(await page.locator('#logBox').innerText()).toContain('斷點續傳：從 0:40 繼續');
    const id = await page.locator('.batch-item.done').first().getAttribute('data-id');
    await page.locator(`.batch-item-preview-btn[data-id="${id}"]`).click();
    await expect(page.locator(`.item-preview-panel[data-id="${id}"] .preview-review-item`)).toHaveCount(1);
    await ctx.close();
  });

  test('S-09 同一個打包視窗裡的多個語音段，每段段首字都在；長停頓另起一窗（M4）', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    await page.route(/cdn\.jsdelivr\.net|unpkg\.com/, (r) => r.abort());   // 走 RMS 備援 VAD
    const n = 16000 * 40, b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
    for (const [a, e] of [[1, 4], [5, 8], [9, 12], [30, 33]]) for (let i = a * 16000; i < e * 16000; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * i / 16000) * 0.15 * 32767), 44 + i * 2);
    b.writeInt16LE(32767, 44 + 1.5 * 16000 * 2);
    // 打包視窗從約 1 秒開始：三段語音的段首字在視窗內約 0.2、4.2、8.2 秒
    await installScriptedWorker(page, { segments: [
      [{ text: 'P1頭', timestamp: [0.2, 0.6] }, { text: 'P2頭', timestamp: [4.2, 4.6] }, { text: 'P3頭', timestamp: [8.2, 8.6] }],
      [{ text: 'P4頭', timestamp: [0.2, 0.6] }],
    ] });
    await page.goto(BASE_URL);
    await page.locator('.model-btn[data-model="Xenova/whisper-base"]').click();
    await setToggles(page, ['tog_vad'], ['tog_uvr', 'tog_diarization', 'tog_hallucination']);
    await page.evaluate(() => { (document.getElementById('p_vad_threshold') as HTMLInputElement).value = '0.02'; });
    await page.locator('#fileInput').setInputFiles({ name: 'pack.wav', mimeType: 'audio/wav', buffer: b });
    await page.locator('#startBtn').click();
    await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 60_000 });
    const log = await page.locator('#logBox').innerText();
    expect(log).toContain('共 2 段要辨識');
    const txt = await downloadText(page);
    for (const k of ['P1頭', 'P2頭', 'P3頭', 'P4頭']) expect(txt, `缺少 ${k}`).toContain(k);
    await ctx.close();
  });
});

test.describe('r10b 第 2 輪覆核修正', () => {
  test('S-10 接縫共同片段要時間相符（N1）；判定用保守門檻（N3）；長句迴圈（S-a）；接縫空白（N2）', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await openWithHook(ctx, NAMES, 'new');
    const r = await page.evaluate(() => {
      const T = (window as any).__t; const S = T.stitchSeam;
      const w = (text: string, s: number, e?: number) => ({ text, s, e: e ?? s + 0.3 });
      const join = (A: any[], B: any[], ovEnd: number) => { const m = S(A, B, ovEnd); return { how: m.how, text: A.slice(0, m.keepPrev).concat(B.slice(m.nextFrom)).map((x: any) => x.text).join('') }; };
      const ch = (arr: string[]) => arr.map((t) => ({ text: t, timestamp: [0, 1] }));
      const rep = (u: string[], n: number, head: string[] = ['今天', '講']) => ch(head.concat(...Array(n).fill(u)));
      const sent = '這個抗原呈現細胞會把抗原片段放到MHC分子上給T細胞看'.split('');
      return {
        // 覆核 r2 N1 實例 1：IgG 在兩窗不同時間（25.0 vs 28.0 秒）→ 不可在 IgG 接起來吞掉「跟IgM都是抗體其中」
        igg: join([w('I', 25.0), w('gG', 25.2), w('跟', 25.5), w('I', 25.7), w('gM', 25.9), w('都是', 26.1)],
                  [w('抗體', 26.9), w('其中', 27.5), w('I', 28.0), w('gG', 28.2), w('最多', 28.5)], 30),
        // 實例 2：「這個」在前一窗 25.0 秒、後一窗 26.8 秒 → 不可吞掉「抗體」
        zhege: join([w('這', 25.0), w('個', 25.2), w('抗', 25.6), w('體', 26.0, 26.6)],
                    [w('這', 26.8), w('個', 27.0), w('時候', 27.3), w('我們', 27.8), w('看', 28.2)], 30),
        // 時間相符的共同片段仍照常接（不重複）
        ok: join([w('抗', 25.0), w('原', 25.3), w('呈', 25.6), w('現', 25.9)], [w('抗', 25.1), w('原', 25.4), w('呈', 25.7), w('現', 26.0), w('細胞', 26.4)], 30),
        // 只有 2 個字的片段時間差 0.8 秒（>0.5）→ 不接
        two: join([w('我', 25.0), w('們', 25.2), w('甲', 25.5)], [w('我', 25.8), w('們', 26.0), w('乙', 26.3)], 30).how,
        // N3：真實切法「對、」「I」「gG、」在尾端
        dui3: T.tailLoopLike(rep(['對、'], 3, ['老師', '說'])), dui11: T.tailLoopLike(rep(['對、'], 11)), dui12: T.tailLoopLike(rep(['對、'], 12)),
        igg3: T.tailLoopLike(rep(['I', 'gG、'], 3)), igg5: T.tailLoopLike(rep(['I', 'gG、'], 5)), igg6: T.tailLoopLike(rep(['I', 'gG、'], 6)),
        hao3: T.tailLoopLike(ch(['好', '好', '好'])),
        sent2: T.tailLoopLike(rep(sent, 2)), sent3: T.tailLoopLike(rep(sent, 3)),
        // S-a：長句（30 個單位）重複 3 次停止條件抓得到
        tok30: T.detectTokenLoop([1, 2, 3].concat(...Array(3).fill(Array.from({ length: 30 }, (_, i) => 1000 + i))), 30),
        trim30: T.trimRepeatTail(rep(sent, 3)).removed,
        // N2：接縫空白
        gapA: T.seamGapRange(20.8, 27, 25, 5, 0),     // 前一窗 20.8 秒後沒字、後一窗 27 秒才有字
        gapB: T.seamGapRange(26.5, 27.2, 25, 5, 0),   // 0.7 秒 → 不算
        gapC: T.seamGapRange(3, 27, 25, 5, 0),        // 只看起點前 10 秒
        gapD: T.seamGapRange(null, null, 25, 5, 0),
        gapE: T.seamGapRange(5, 8, 25, 5, 0),         // 空白不在接縫附近
        voiced: T.mostlyVoiced(Float32Array.from({ length: 32000 }, (_, i) => 0.2 * Math.sin(i / 10)), 16000),
        silent: T.mostlyVoiced(new Float32Array(32000), 16000),
      };
    });
    expect(r.igg.text).toContain('跟IgM都是抗體其中');
    expect(r.zhege.text).toContain('抗體');
    expect(r.ok).toEqual({ how: 'text', text: '抗原呈現細胞' });
    expect(r.two).toBe('time');
    expect([r.dui3, r.dui11, r.igg3, r.igg5, r.hao3, r.sent2]).toEqual([false, false, false, false, false, false]);
    expect([r.dui12, r.igg6, r.sent3]).toEqual([true, true, true]);
    expect(r.tok30).toBe('repeat30');
    expect(r.trim30).toBe(54);   // 整句 27 個單位，重複 3 次 → 截掉後 2 次
    expect(r.gapA).toEqual({ from: 20.8, to: 27 });
    expect(r.gapB).toBeNull();
    expect(r.gapC).toEqual({ from: 15, to: 27 });
    expect(r.gapD).toBeNull(); expect(r.gapE).toBeNull();
    expect(r.voiced).toBe(true); expect(r.silent).toBe(false);
    await ctx.close();
  });

  test('S-04b 真實 Worker：重試結果尾端是老師的「對、對、對」→ 仍採用重試（N3）', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await openWithHook(ctx, NAMES, 'new');
    const out = await runInWorker(page, `
      const ch = (arr) => arr.map((t, i) => ({ text: t, timestamp: [i * 0.3, i * 0.3 + 0.3] }));
      const tail = ['好', '那', '我們', '說', '對、', '對、', '對、'];
      const r = tailLoopLike(ch(tail));
      const r2 = tailLoopLike(ch(['甲'].concat(Array(12).fill('對、'))));
      return { r, r2 };
    `);
    expect(out.type).toBe('T_OK');
    expect(out.out).toEqual({ r: false, r2: true });
    await ctx.close();
  });

  test('S-11 接縫兩窗都沒輸出 → 補聽一次補回；補聽失敗 → 待確認清單（N2）', async ({ browser }) => {
    test.setTimeout(120_000);
    for (const mode of ['fill', 'fail'] as const) {
      const ctx = await newCtx(browser); const page = await ctx.newPage();
      // 60 秒、不開 VAD → 視窗 [0,30] [25,55] [50,60]
      await installScriptedWorker(page, {
        segments: [
          [{ text: 'A1', timestamp: [1, 2] }, { text: 'A2', timestamp: [20, 21.5] }],
          [{ text: 'B1', timestamp: [2, 2.5] }, { text: 'B2', timestamp: [25.5, 26] }],
          [{ text: 'C1', timestamp: [2, 3] }],
        ],
        gapSegments: { 1: mode === 'fill' ? [{ text: '補字', timestamp: [2, 3] }] : 'error' },
      });
      await page.goto(BASE_URL);
      await page.locator('.model-btn[data-model="Xenova/whisper-base"]').click();
      await setToggles(page, [], ['tog_vad', 'tog_uvr', 'tog_diarization', 'tog_hallucination']);
      await page.locator('#fileInput').setInputFiles({ name: 'gap.wav', mimeType: 'audio/wav', buffer: wav(60) });
      await page.locator('#startBtn').click();
      await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 60_000 });
      const gaps = await page.evaluate(() => (window as any).__workerLog.filter((x: any) => x.type === 'GAP_RUN'));
      expect(gaps.length).toBe(1);
      expect(gaps[0].segIdx).toBe(1);
      expect(gaps[0].startSec).toBeCloseTo(19.8, 1);   // 空白 20.8～27 秒，前後各多聽 1 秒
      expect(gaps[0].sec).toBeGreaterThan(7); expect(gaps[0].sec).toBeLessThan(8.5);
      const txt = await downloadText(page);
      const log = await page.locator('#logBox').innerText();
      if (mode === 'fill') {
        expect(txt.indexOf('A2')).toBeLessThan(txt.indexOf('補字'));
        expect(txt.indexOf('補字')).toBeLessThan(txt.indexOf('B1'));
        expect(log).toContain('補回 1 個字');
      } else {
        for (const k of ['A1', 'A2', 'B1', 'B2', 'C1']) expect(txt).toContain(k);
        expect(txt).not.toContain('⚠');
        const id = await page.locator('.batch-item.done').first().getAttribute('data-id');
        await page.locator(`.batch-item-preview-btn[data-id="${id}"]`).click();
        await expect(page.locator(`.item-preview-panel[data-id="${id}"] .preview-review-item`)).toHaveCount(1);
        await expect(page.locator(`.item-preview-panel[data-id="${id}"] .preview-review-item`)).toContainText('接縫');
      }
      await ctx.close();
    }
  });
});
