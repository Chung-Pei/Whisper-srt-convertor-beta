// tests/round20-r10b-speed.spec.ts — r10b 一般模式加速＋鬼打牆處理
//   S-01  detectTokenLoop／trimRepeatTail：真的鬼打牆才停；老師真的重複（對、對、對／IgG、IgG）不誤判
//   S-02  planChunkWindows：VAD 語音段打包成 ≤30 秒；長段重疊切；沒 VAD 時與原本切法相同
//   S-03  estimateRemaining／plainDuration：最近幾段平均、不算第一段暖機；白話時間
//   S-04  真實 Worker 程式：給滿 max_new_tokens（跳過 seek）＋停止條件；太密才用完整模式重跑；鬼打牆 → 截尾 → 不帶提示詞重試一次
//   S-05  主程式：重疊區中點切邊界、量測日誌、剩餘時間白話；鬼打牆仍可疑 → 預覽待確認清單（可點跳轉）、匯出字幕無 ⚠、完成畫面一句話
//   S-06  介面：語言選單沒有「自動偵測」；短提示詞選項（預設關）只在一般模式生效
import { test, expect, type Page } from '@playwright/test';
import { newCtx, openWithHook, installScriptedWorker, BASE_URL, type Seg } from './harness';
import { setToggles, downloadText } from './helpers';

const NAMES = ['WORKER_CODE', 'spawnWorker', 'detectTokenLoop', 'trimRepeatTail', 'planChunkWindows', 'estimateRemaining', 'plainDuration', 'WHISPER_MAX_TARGET'];

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
        k2x5: d(seq([800, 801], 5), 30),             // 射音，射音，…
        k4x4: d(seq([1, 2, 3, 4], 4, [9]), 30),
        budget: d([1, 2, 3], 30, 361), budgetOk: d([1, 2, 3], 30, 360), budgetShort: d([1, 2, 3], 1, 49),
        trim: T.trimRepeatTail(['今天', '講', '射音', '，', '射音', '，', '射音', '，', '射音', '，'].map((t) => ({ text: t, timestamp: [0, 1] }))),
        keep: T.trimRepeatTail(['對', '、', '對', '、', '我們', '開始'].map((t) => ({ text: t, timestamp: [0, 1] }))),
      };
    });
    expect(r.normal).toBeNull(); expect(r.dui3).toBeNull(); expect(r.igg4).toBeNull(); expect(r.same11).toBeNull();
    expect(r.same12).toBe('repeat1'); expect(r.k2x5).toBe('repeat2'); expect(r.k4x4).toBe('repeat4');
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
      };
    });
    expect(r.none).toEqual([{ startSec: 0, endSec: 30, leadSec: 0 }, { startSec: 25, endSec: 55, leadSec: 5 }, { startSec: 50, endSec: 70, leadSec: 5 }]);
    expect(r.vad).toEqual([{ startSec: 1, endSec: 23, leadSec: 0 }, { startSec: 40, endSec: 70, leadSec: 0 }, { startSec: 65, endSec: 75, leadSec: 5 }, { startSec: 90, endSec: 91, leadSec: 0 }]);
    expect(r.tiny).toEqual([{ startSec: 0.5, endSec: 10, leadSec: 0 }]);   // 超出音訊長度的語音段被截到結尾
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
        generation_config: { eos_token_id: 50257 },
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
      calls.length = 0; out.length = 0; script = function (c) { return c.prompt ? loopy : normal; }; await run('短提示');
      const d3 = out.filter(function (m) { return m.type === 'CHUNK_DONE'; })[0].payload;
      res.retryOk = { calls: calls.slice(), stats: d3.stats, text: d3.result.chunks.map(function (x) { return x.text; }).join('') };
      // 4) 鬼打牆＋重試還是鬼打牆：保留截短版、標記待確認
      calls.length = 0; out.length = 0; script = function () { return loopy; }; await run('短提示');
      const d4 = out.filter(function (m) { return m.type === 'CHUNK_DONE'; })[0].payload;
      res.retryBad = { calls: calls.slice(), stats: d4.stats, text: d4.result.chunks.map(function (x) { return x.text; }).join('') };
      // 5) 鬼打牆、沒有提示詞：重試結果會一模一樣 → 不重試，直接標記
      calls.length = 0; out.length = 0; script = function () { return loopy; }; await run(null);
      res.noPrompt = { calls: calls.slice(), stats: out.filter(function (m) { return m.type === 'CHUNK_DONE'; })[0].payload.stats };
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
    expect(o.retryOk.text).toBe('今天上課');
    expect(o.retryBad.calls.length).toBe(2);
    expect(o.retryBad.stats).toMatchObject({ loop: 'repeat2', retried: true, retryOk: false, flagged: true });
    expect(o.retryBad.text).toBe('今天射音，');
    expect(o.retryBad.stats.loopTrimmed).toBeGreaterThan(0); expect(o.retryBad.stats.lostSec).toBeGreaterThan(20);
    expect(o.noPrompt.calls.length).toBe(1);
    expect(o.noPrompt.stats).toMatchObject({ loop: 'repeat2', retried: false, flagged: true });
    await ctx.close();
  });
});

test.describe('r10b 主程式與畫面', () => {
  test('S-05 中點切邊界、量測日誌、剩餘時間；鬼打牆仍可疑 → 預覽待確認（可點跳轉）、字幕檔無 ⚠、完成畫面一句話', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    // 60 秒、不開 VAD → 視窗 [0,30] [25,55] [50,60]；重疊區中點 27.5、52.5
    const segs: Seg[] = [
      [{ text: 'A開頭', timestamp: [0.5, 1] }, { text: 'A保留', timestamp: [27.0, 27.4] }, { text: 'A尾巴丟', timestamp: [28.0, 28.5] }],
      [{ text: 'B頭丟', timestamp: [1.0, 1.5] }, { text: 'B保留', timestamp: [3.0, 3.5] }, { text: 'B中', timestamp: [10, 10.5] }],
      [{ text: 'C保留', timestamp: [3.0, 3.5] }],
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
    for (const k of ['A開頭', 'A保留', 'B保留', 'B中', 'C保留']) expect(txt, `缺少 ${k}`).toContain(k);
    for (const k of ['A尾巴丟', 'B頭丟']) expect(txt, `${k} 應由另一個視窗負責`).not.toContain(k);
    expect(txt).not.toContain('⚠');
    const log = await page.locator('#logBox').innerText();
    expect(log).toContain('⏲ 段落 1：30.0 秒音訊花 6.0 秒（模型讀音訊 1 次、產生 118 個字詞單位）');
    expect(log).toContain('這段一直重複同一個詞，已提早停止、截掉 12 個重複字詞；不帶提示詞重試一次：仍不理想，保留截短後的版本；已標記待確認（後面約 19.5 秒可能漏字）');
    expect(log).toContain('其中 1 段出現重複迴圈（1 段標記待確認）');
    expect(log).not.toMatch(/token|n-gram/i);
    await expect(page.locator('#uvrNotice')).toContainText('有 1 段可能漏字');
    // 預覽：待確認清單，點一下跳到該時間
    const id = await page.locator('.batch-item.done').first().getAttribute('data-id');
    await page.locator(`.batch-item-preview-btn[data-id="${id}"]`).click();
    const panel = page.locator(`.item-preview-panel[data-id="${id}"]`);
    await expect(panel.locator('.preview-review-title')).toContainText('有 1 段可能漏字');
    await expect(panel.locator('.preview-review-item')).toHaveCount(1);
    await expect(panel.locator('.preview-review-item')).toContainText('這段一直重複同一個詞，已自動截掉，可能漏字');
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
