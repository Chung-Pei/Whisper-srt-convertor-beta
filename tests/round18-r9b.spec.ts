// tests/round18-r9b.spec.ts — r9 第二批
//   P-01～P-05  初始提示詞：Transformers.js 4.3.0 會忽略 generate_kwargs／prompt_ids → 改自組 decoder_input_ids
//              （真實 whisper-tiny 驗證見 tests/manual/verify-prompt-whisper-tiny.mjs，需要網路，不在 functional 內）
import { test, expect, type Page } from '@playwright/test';
import { newCtx, openWithHook, installScriptedWorker, buildSegments, BASE_URL } from './harness';
import { setToggles } from './helpers';

const NAMES = ['WORKER_CODE', 'spawnWorker', 'composeWhisperPrompt', 'buildPromptDecoderIds', 'stripPromptLeak', 'PROMPT_MAX_TOKENS', 'DEFAULT_MEDICAL_DICT'];

/** 用頁面的 WORKER_CODE（真實 Worker 程式）＋測試尾段建立 Worker，等 T_OK／T_ERR。 */
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

test.describe('r9 初始提示詞（decoder_input_ids）', () => {
  test('P-01 composeWhisperPrompt：詞典開啟時英文名詞在前（去重）、使用者提示詞在最後；都沒有時回 null', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await openWithHook(ctx, NAMES, 'new');
    const r = await page.evaluate(() => {
      const T = (window as any).__t;
      const d = [{ en: 'Hypertension' }, { en: ' hypertension ' }, { en: 'Stroke' }, { en: '' }, {}];
      return {
        off: T.composeWhisperPrompt('  微生物學  ', d, false),
        on: T.composeWhisperPrompt('微生物學', d, true),
        onlyDict: T.composeWhisperPrompt('', d, true),
        none: T.composeWhisperPrompt('  ', d, false),
        full: T.composeWhisperPrompt('我的提示', T.DEFAULT_MEDICAL_DICT, true),
      };
    });
    expect(r.off).toBe('微生物學');
    expect(r.on).toBe('Hypertension, Stroke. 微生物學');
    expect(r.onlyDict).toBe('Hypertension, Stroke.');
    expect(r.none).toBeNull();
    expect(r.full.endsWith('. 我的提示')).toBe(true);
    expect(r.full).toContain('Myocardial Infarction');
    await ctx.close();
  });

  test('P-02 buildPromptDecoderIds：[startofprev, 提示詞（最多 200，保留最後面）, 起始 token]；去除特殊 token；空提示回 null', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await openWithHook(ctx, NAMES, 'new');
    const r = await page.evaluate(() => {
      const T = (window as any).__t;
      const many = Array.from({ length: 250 }, (_, i) => i + 1);
      const ids = T.buildPromptDecoderIds(many, [50258, 50260, 50359], 50361, T.PROMPT_MAX_TOKENS, 50257);
      return {
        max: T.PROMPT_MAX_TOKENS, len: ids.length, head: ids.slice(0, 3), tail: ids.slice(-4),
        special: T.buildPromptDecoderIds([5, 50257, 50300, 6], [50258], 50361, 200, 50257),
        empty: T.buildPromptDecoderIds([], [50258], 50361, 200, 50257),
        onlySpecial: T.buildPromptDecoderIds([50258], [50258], 50361, 200, 50257),
        noPrev: T.buildPromptDecoderIds([1], [50258], null, 200, 50257),
      };
    });
    expect(r.max).toBe(200);
    expect(r.len).toBe(1 + 200 + 3);
    expect(r.head).toEqual([50361, 51, 52]);            // 保留最後 200 個（51～250）
    expect(r.tail).toEqual([250, 50258, 50260, 50359]);
    expect(r.special).toEqual([50361, 5, 6, 50258]);
    expect(r.empty).toBeNull(); expect(r.onlySpecial).toBeNull(); expect(r.noPrev).toBeNull();
    await ctx.close();
  });

  test('P-03 stripPromptLeak：整段照抄提示詞（多個詞條連著）才移除；單獨講到某個醫學名詞不移除', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await openWithHook(ctx, NAMES, 'new');
    const r = await page.evaluate(() => {
      const T = (window as any).__t;
      const prompt = 'Myocardial Infarction, Angina Pectoris, Atrial Fibrillation, Coronary Artery Disease, Hypertension. 本課程討論細菌、病毒、黴菌與免疫反應';
      const w = (s: string) => s.split(/(?= )/).map((t) => ({ text: t, timestamp: [0, 1] }));
      const zh = (s: string) => [...s].map((t) => ({ text: t, timestamp: [0, 1] }));
      const leakEn = [...w(' 今天 我們'), ...w(' Myocardial Infarction, Angina Pectoris, Atrial Fibrillation,'), ...w(' 開始 上課')];
      const leakZh = [...zh('好'), ...zh('本課程討論細菌、病毒、黴菌與免疫反應'), ...zh('同學')];
      const single = [...w(' 這是 Hypertension 和 Coronary Artery Disease')];
      const a = T.stripPromptLeak(leakEn, prompt), b = T.stripPromptLeak(leakZh, prompt), c = T.stripPromptLeak(single, prompt);
      const j = (x: any) => x.chunks.map((k: any) => k.text).join('');
      return { a: j(a), ar: a.removed, b: j(b), br: b.removed, c: j(c), cr: c.removed, none: T.stripPromptLeak(single, null).removed };
    });
    expect(r.a).toBe(' 今天 我們 開始 上課'); expect(r.ar).toBeGreaterThan(0);
    expect(r.b).toBe('好同學'); expect(r.br).toBe(18);
    expect(r.c).toBe(' 這是 Hypertension 和 Coronary Artery Disease'); expect(r.cr).toBe(0);
    expect(r.none).toBe(0);
    await ctx.close();
  });

  test('P-04 真實 Worker 程式：RUN_CHUNK 把 decoder_input_ids 傳給 pipeline（不再用 generate_kwargs）；照抄的提示詞被移除並回報', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await openWithHook(ctx, NAMES, 'new');
    const res = await runInWorker(page, `
      const calls = []; let reply = null;
      pipe = async function (audio, opts) { calls.push(JSON.parse(JSON.stringify(opts))); return reply; };
      pipe.tokenizer = {
        encode: function (t, o) { if (!o || o.add_special_tokens !== false) throw new Error('需要 add_special_tokens:false'); return t.indexOf('LONG') >= 0 ? Array.from({ length: 250 }, function (_, i) { return i + 1; }) : [11, 12, 13]; },
        convert_tokens_to_ids: function (t) { return t === '<|startofprev|>' ? 50361 : null; },
      };
      pipe.model = {
        _prepare_generation_config: function (g, k) { return { eos_token_id: 50257, decoder_start_token_id: 50258, language: k.language, task: k.task, return_timestamps: k.return_timestamps }; },
        _retrieve_init_tokens: function (gc) { return gc.return_timestamps ? [50258, 50260, 50359] : [50258, 50260, 50359, 50363]; },
      };
      const out = []; const post = self.postMessage.bind(self);
      self.postMessage = function (m) { out.push(m); };
      const run = async function (promptText) {
        self.dispatchEvent(new MessageEvent('message', { data: { type: 'RUN_CHUNK', payload: { audioData: new Float32Array(16).buffer, language: 'zh', task: 'transcribe', promptText: promptText, segIdx: 0, startSec: 0 } } }));
        await new Promise(function (r) { setTimeout(r, 50); });
      };
      reply = { text: '今天上課', chunks: [{ text: '今天', timestamp: [0, 1] }, { text: '上課', timestamp: [1, 2] }] };
      await run(null);
      await run('短提示');
      await run('LONG');
      const P = '本課程討論細菌、病毒、黴菌與免疫反應';
      reply = { text: 'x', chunks: [{ text: '好', timestamp: [0, 1] }].concat(P.split('').map(function (c) { return { text: c, timestamp: [1, 2] }; })) };
      await run(P);
      self.postMessage = post;
      return { calls: calls, out: out.map(function (m) { return { type: m.type, payload: m.payload }; }) };
    `);
    expect(res.type, JSON.stringify(res)).toBe('T_OK');
    const { calls, out } = res.out;
    expect(calls.length).toBe(4);
    expect(calls[0].decoder_input_ids).toBeUndefined();
    for (const c of calls) { expect(c.generate_kwargs).toBeUndefined(); expect(c.return_timestamps).toBe('word'); expect(c.language).toBe('zh'); }
    expect(calls[1].decoder_input_ids).toEqual([50361, 11, 12, 13, 50258, 50260, 50359]);
    expect(calls[2].decoder_input_ids.length).toBe(1 + 200 + 3);
    expect(calls[2].decoder_input_ids[1]).toBe(51);
    const infos = out.filter((m: any) => m.type === 'PROMPT_INFO').map((m: any) => m.payload);
    expect(infos[0]).toMatchObject({ used: 3, total: 3, reason: null });
    expect(infos[1]).toMatchObject({ used: 200, total: 250 });
    const leak = out.find((m: any) => m.type === 'PROMPT_LEAK_REMOVED');
    expect(leak?.payload.removed).toBe(18);
    const done = out.filter((m: any) => m.type === 'CHUNK_DONE');
    expect(done.at(-1).payload.result.chunks.map((c: any) => c.text).join('')).toBe('好');
    expect(done.at(-1).payload.result.text).toBe('好');
    await ctx.close();
  });

  test('P-05 主程式：開啟「醫學專有名詞標注」→ 送給 Worker 的提示詞含詞典英文名詞，使用者提示詞在最後；日誌白話說明', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    const segs = await buildSegments(ctx, { segments: 2, linesPerSegment: 2, charsPerLine: 10, termRate: 0.1, seed: 5 });
    await installScriptedWorker(page, { segments: segs });
    await page.goto(BASE_URL);
    await page.locator('.model-btn[data-model="Xenova/whisper-base"]').click();
    const wav = (sec: number) => { const n = 16000 * sec, b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 10)), 44 + i * 2); return b; };
    const runOnce = async (name: string) => {
      await page.locator('#fileInput').setInputFiles({ name, mimeType: 'audio/wav', buffer: wav(8) });
      await page.locator('#startBtn').click();
      await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 60_000 });
    };
    await page.locator('#initialPrompt').fill('本課程是微生物與免疫學');
    await setToggles(page, ['tog_medical'], ['tog_vad', 'tog_uvr']);
    await runOnce('a.wav');
    const p1 = await page.evaluate(() => (window as any).__workerLog.filter((x: any) => x.type === 'RUN_CHUNK').map((x: any) => x.prompt));
    expect(p1.length).toBeGreaterThan(0);
    expect(p1[0]).toContain('Myocardial Infarction');
    expect(p1[0].endsWith('. 本課程是微生物與免疫學')).toBe(true);
    expect(await page.locator('#logBox').textContent()).toContain('初始提示詞已啟用（你的提示詞＋醫學詞典英文名詞）');
    await ctx.close();
  });
});
