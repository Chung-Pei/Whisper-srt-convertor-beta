// tests/round18-r9b.spec.ts — r9 第二批
//   P-01～P-05  初始提示詞：Transformers.js 4.3.0 會忽略 generate_kwargs／prompt_ids → 改自組 decoder_input_ids
//              （真實 whisper-tiny 驗證見 tests/manual/verify-prompt-whisper-tiny.mjs，需要網路，不在 functional 內）
//   W-01～W-02  人聲 WAV 改 16 kHz 單聲道；下載連結點擊後即撤銷、再點重建
//   R-01～R-02  斷點續傳每 5 段寫一次；取消時補寫最後進度
//   P-06        覆核 M1：照順序念的名詞不可被當成照抄刪掉
//   D-05        覆核 N4：外部權重 *.onnx_data 也列入預檢
//   D-01～D-04  離線權重預檢：載入前（含顯示卡失敗改一般模式前）確認該 dtype 需要的 .onnx 在本機；缺檔立即白話說明
import { test, expect, type Page } from '@playwright/test';
import { newCtx, openWithHook, installScriptedWorker, buildSegments, BASE_URL } from './harness';
import { setToggles } from './helpers';

const NAMES = ['encodeWavMono16', 'showVocalDownload', 'resetVocalDownload', 'RESUME_SAVE_EVERY', 'PROMPT_CORE_TERMS', 'WORKER_CODE', 'spawnWorker', 'composeWhisperPrompt', 'buildPromptDecoderIds', 'stripPromptLeak', 'PROMPT_MAX_TOKENS', 'DEFAULT_MEDICAL_DICT'];

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
  test('P-01 composeWhisperPrompt：詞典其他名詞在前（去重）→ 免疫／微生物核心名詞 → 使用者提示詞在最後；都沒有時回 null', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await openWithHook(ctx, NAMES, 'new');
    const r = await page.evaluate(() => {
      const T = (window as any).__t;
      const d = [{ en: 'Hypertension' }, { en: ' hypertension ' }, { en: 'Stroke' }, { en: 'antigen' }, { en: '' }, {}];
      const core = ['antigen', 'IgG'];
      return {
        off: T.composeWhisperPrompt('  微生物學  ', d, false, core),
        on: T.composeWhisperPrompt('微生物學', d, true, core),
        onlyDict: T.composeWhisperPrompt('', d, true, core),
        none: T.composeWhisperPrompt('  ', d, false, core),
        full: T.composeWhisperPrompt('我的提示', T.DEFAULT_MEDICAL_DICT, true),
        core: T.PROMPT_CORE_TERMS,
      };
    });
    expect(r.off).toBe('微生物學');
    expect(r.on).toBe('Hypertension, Stroke, antigen, IgG. 以下是微生物免疫學課程的繁體中文逐字稿。 微生物學');   // 核心名詞不重複、放在詞典其他名詞之後
    expect(r.onlyDict).toBe('Hypertension, Stroke, antigen, IgG. 以下是微生物免疫學課程的繁體中文逐字稿。');
    expect(r.none).toBeNull();
    // 預設：核心名詞（使用者指定的免疫學／微生物學名詞）緊接在使用者提示詞之前 → 截斷時優先保留
    expect(r.full.endsWith(r.core.join(', ') + '. 以下是微生物免疫學課程的繁體中文逐字稿。 我的提示')).toBe(true);   // 覆核 N2：詞彙表後接一句繁體中文
    for (const t of ['antigen', 'antibody', 'IgG', 'IgM', 'IgA', 'IgE', 'MHC class I', 'MHC class II', 'T cell', 'B cell', 'CD4', 'CD8', 'cytokine',
      'interleukin', 'complement', 'Gram-positive', 'Gram-negative', 'Staphylococcus aureus', 'Streptococcus', 'E. coli', 'Mycobacterium tuberculosis', 'endotoxin', 'virulence'])
      expect(r.core).toContain(t);
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

  test('P-03 stripPromptLeak：長串照抄（≥8 個詞條連著）才移除；單獨或幾個醫學名詞、使用者提示詞裡的一句話都不移除', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await openWithHook(ctx, NAMES, 'new');
    const r = await page.evaluate(() => {
      const T = (window as any).__t;
      const prompt = 'Myocardial Infarction, Angina Pectoris, Atrial Fibrillation, Coronary Artery Disease, Hypertension, Stroke, Asthma, Diabetes, Sepsis, Anemia. 本課程討論細菌、病毒、黴菌與免疫反應';
      const w = (s: string) => s.split(/(?= )/).map((t) => ({ text: t, timestamp: [0, 1] }));
      const zh = (s: string) => [...s].map((t) => ({ text: t, timestamp: [0, 1] }));
      const leakEn = [...w(' 今天 我們'), ...w(' Myocardial Infarction, Angina Pectoris, Atrial Fibrillation, Coronary Artery Disease, Hypertension, Stroke, Asthma, Diabetes,'), ...w(' 開始 上課')];
      const three = [...w(' 今天 我們'), ...w(' Myocardial Infarction, Angina Pectoris, Atrial Fibrillation,'), ...w(' 開始 上課')];
      const zhSent = [...zh('好'), ...zh('本課程討論細菌、病毒、黴菌與免疫反應'), ...zh('同學')];
      const single = [...w(' 這是 Hypertension 和 Coronary Artery Disease')];
      const a = T.stripPromptLeak(leakEn, prompt), t3 = T.stripPromptLeak(three, prompt), b = T.stripPromptLeak(zhSent, prompt), c = T.stripPromptLeak(single, prompt);
      const j = (x: any) => x.chunks.map((k: any) => k.text).join('');
      return { a: j(a), ar: a.removed, t3: j(t3), t3r: t3.removed, b: j(b), br: b.removed, c: j(c), cr: c.removed, none: T.stripPromptLeak(single, null).removed };
    });
    expect(r.a).toBe(' 今天 我們 開始 上課'); expect(r.ar).toBeGreaterThan(0);
    expect(r.t3).toBe(' 今天 我們 Myocardial Infarction, Angina Pectoris, Atrial Fibrillation, 開始 上課'); expect(r.t3r).toBe(0);
    expect(r.b).toBe('好本課程討論細菌、病毒、黴菌與免疫反應同學'); expect(r.br).toBe(0);
    expect(r.c).toBe(' 這是 Hypertension 和 Coronary Artery Disease'); expect(r.cr).toBe(0);
    expect(r.none).toBe(0);
    await ctx.close();
  });

  test('P-06 覆核 M1：老師照順序念的免疫／微生物名詞（真實預設提示詞）原樣保留；真的整份照抄、照抄開頭那句中文才移除', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await openWithHook(ctx, NAMES, 'new');
    const r = await page.evaluate(() => {
      const T = (window as any).__t;
      const prompt = T.composeWhisperPrompt('', T.DEFAULT_MEDICAL_DICT, true);          // 預設：詞典＋核心名詞＋中文開頭句
      const promptU = T.composeWhisperPrompt('今天講第五章', T.DEFAULT_MEDICAL_DICT, true);
      // Whisper 逐字輸出：中文一字一個 chunk、英文一詞一個 chunk（前面帶空白）
      const toks = (s: string) => (s.match(/ ?[A-Za-z0-9α+\-.,]+|[^ A-Za-z0-9α+\-.,]/g) || []).map((t) => ({ text: t, timestamp: [0, 1] }));
      const j = (x: any) => x.chunks.map((k: any) => k.text).join('');
      const keep = ['抗體分成 IgG, IgM, IgA, IgE 四種', 'T cell, B cell, CD4, CD8', '金黃色葡萄球菌是 Gram-positive, coagulase-positive 的球菌',
        '包括 CD4, CD8 T cell', 'antigen, antibody, IgG, IgM, IgA, IgE, MHC class I 都會考', 'cytokine, interleukin, complement'];
      const kept = keep.map((t) => { const out: any = {}; for (const [k, P] of [['p', prompt], ['u', promptU]]) { const x = T.stripPromptLeak(toks(t), P); out[k] = { text: j(x), removed: x.removed }; } return { want: t, ...out }; });
      const core = T.PROMPT_CORE_TERMS.join(', ');
      const fullLeak = T.stripPromptLeak(toks('好 ' + core + '. 以下是微生物免疫學課程的繁體中文逐字稿。 同學'), prompt);
      const segLeak = T.stripPromptLeak(toks(T.PROMPT_CORE_TERMS.slice(24, 30).join(', ')), prompt);   // 整段（≥95%）都是照抄的 6 個詞條
      const leadLeak = T.stripPromptLeak(toks('以下是微生物免疫學課程的繁體中文逐字稿。 我們開始'), promptU);
      return { kept, full: j(fullLeak), fullR: fullLeak.removed, seg: j(segLeak), segR: segLeak.removed, lead: j(leadLeak), leadR: leadLeak.removed };
    });
    for (const k of r.kept) {
      expect(k.p.text.replace(/ /g, ''), k.want).toBe(k.want.replace(/ /g, '')); expect(k.p.removed, k.want).toBe(0);
      expect(k.u.text.replace(/ /g, ''), k.want).toBe(k.want.replace(/ /g, '')); expect(k.u.removed, k.want).toBe(0);
    }
    expect(r.full.replace(/ /g, '')).toBe('好同學'); expect(r.fullR).toBeGreaterThan(20);
    expect(r.seg).toBe(''); expect(r.segR).toBeGreaterThan(5);
    expect(r.lead.replace(/ /g, '')).toBe('我們開始'); expect(r.leadR).toBeGreaterThan(0);
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
      const P = '本課程討論細菌、病毒、黴菌與免疫反應以及疫苗的作用';   // 整份提示詞（≥20 字）原樣照抄
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
    expect(leak?.payload.removed).toBe(25);
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
    expect(p1[0]).toContain('Mycobacterium tuberculosis, endotoxin, virulence. 以下是微生物免疫學課程的繁體中文逐字稿。 本課程是微生物與免疫學');
    expect(p1[0].endsWith('逐字稿。 本課程是微生物與免疫學')).toBe(true);
    expect(await page.locator('#logBox').textContent()).toContain('初始提示詞已啟用（你的提示詞＋免疫／微生物等醫學英文名詞）');
    await ctx.close();
  });
});

test.describe('r9 覆核第 1 輪：畫面', () => {
  test('P-07 覆核 N12／N11：照抄提示詞被移除 → 完成畫面白話說明段數與字詞數（不只日誌）；提示詞說明主畫面一句、細節收在「？」', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    const segs = await buildSegments(ctx, { segments: 3, linesPerSegment: 2, charsPerLine: 10, termRate: 0.1, seed: 7 });
    await installScriptedWorker(page, { segments: segs, rules: [
      { segIdx: 0, pre: [{ type: 'PROMPT_LEAK_REMOVED', payload: { removed: 30 } }] },
      { segIdx: 1, pre: [{ type: 'PROMPT_LEAK_REMOVED', payload: { removed: 12 } }] },
    ] });
    await page.goto(BASE_URL);
    // 說明：主畫面只有一句，細節預設收起
    await expect(page.locator('#promptHelp')).toContainText('寫幾個這堂課會講到的詞');
    await expect(page.locator('#promptHelpMore')).not.toHaveAttribute('open', '');
    await expect(page.locator('#promptHelpMore > div')).toBeHidden();
    await page.locator('#promptHelpMore > summary').click();
    await expect(page.locator('#promptHelpMore > div')).toBeVisible();
    await expect(page.locator('#promptHelpMore > div')).toContainText('免疫學、微生物學');
    await page.locator('.model-btn[data-model="Xenova/whisper-base"]').click();
    await page.locator('#initialPrompt').fill('今天講 MHC');
    await setToggles(page, ['tog_medical'], ['tog_vad', 'tog_uvr']);
    const n = 16000 * 65, b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 10)), 44 + i * 2);
    await page.locator('#fileInput').setInputFiles({ name: 'lec.wav', mimeType: 'audio/wav', buffer: b });
    await page.locator('#startBtn').click();
    await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 60_000 });
    const notice = page.locator('#uvrNotice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('「lec.wav」：有 2 處是模型把提示詞原文照抄進字幕，已自動刪除（共 42 個字詞）');
    await expect(page.locator('#logBox')).toContainText('第 1 段，約 00:00:00 起：模型把提示詞原文照抄進字幕，已自動移除（30 個字詞）');
    await ctx.close();
  });
});

// ── 離線權重預檢 ────────────────────────────────────────────────────
const WAV8 = (() => { const n = 16000 * 8, b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 10)), 44 + i * 2); return b; })();
const M = 'Xenova/whisper-base';
const seedW = (files: string[]) => `{
  const c = await caches.open('transformers-cache');
  for (const k of await c.keys()) await c.delete(k);
  for (const f of ${JSON.stringify(files)}) await c.put('https://huggingface.co/${M}/resolve/main/onnx/' + f, new Response('x'));
}`;

test.describe('r9 離線權重預檢（dtype）', () => {
  test('D-01 dtype → 需要的權重檔名；_pickOfflineDtype 先找較輕、再找較重，都沒有回 null', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await openWithHook(ctx, NAMES, 'new');
    const res = await runInWorker(page, `
      const names = { q8: _weightFilesFor('q8'), fp32: _weightFilesFor('fp32'), mix: _weightFilesFor({ encoder_model: 'fp16', decoder_model_merged: 'q4' }) };
      ${seedW(['encoder_model_quantized.onnx', 'decoder_model_merged_quantized.onnx', 'encoder_model.onnx'])}
      const a = await _pickOfflineDtype('${M}', 'fp32');       // fp32 只有 encoder → 較輕的 q8
      const b = await _pickOfflineDtype('${M}', 'q4');         // q4 沒有 → 沒有更輕的 → 較重的 q8
      const miss = await _missingWeights('${M}', 'fp32');
      ${seedW([])}
      const none = await _pickOfflineDtype('${M}', 'q8');
      return { names, a, b, miss, none };
    `);
    expect(res.type, JSON.stringify(res)).toBe('T_OK');
    expect(res.out.names.q8).toEqual(['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx']);
    expect(res.out.names.fp32).toEqual(['onnx/encoder_model.onnx', 'onnx/decoder_model_merged.onnx']);
    expect(res.out.names.mix).toEqual(['onnx/encoder_model_fp16.onnx', 'onnx/decoder_model_merged_q4.onnx']);
    expect(res.out.a).toBe('q8'); expect(res.out.b).toBe('q8');
    expect(res.out.miss).toEqual(['decoder_model_merged.onnx']);
    expect(res.out.none).toBeNull();
    await ctx.close();
  });

  test('D-05 覆核 N4：模型設定用外部權重（use_external_data_format）時，預檢也檢查 *.onnx_data；缺了就換 dtype／回報缺檔', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await openWithHook(ctx, NAMES, 'new');
    const res = await runInWorker(page, `
      const ext = { 'encoder_model_fp16.onnx': 1, decoder_model_merged: 2 };
      const names = { obj: _weightFilesFor('fp16', ext), t: _weightFilesFor('q8', true), none: _weightFilesFor('q8', null) };
      ${seedW(['encoder_model_quantized.onnx', 'decoder_model_merged_quantized.onnx', 'encoder_model.onnx', 'decoder_model_merged.onnx', 'decoder_model_merged.onnx_data'])}
      const c = await caches.open('transformers-cache');
      await c.put('https://huggingface.co/${M}/resolve/main/config.json', new Response(JSON.stringify({ 'transformers.js_config': { use_external_data_format: true } })));
      const cfg = await _localExternalDataCfg('${M}');
      const missFp32 = await _missingWeights('${M}', 'fp32');        // 缺 encoder_model.onnx_data
      const pick = await _pickOfflineDtype('${M}', 'fp32');          // q8 的 onnx_data 也沒有 → null
      await c.put('https://huggingface.co/${M}/resolve/main/onnx/encoder_model.onnx_data', new Response('x'));
      const pick2 = await _pickOfflineDtype('${M}', 'fp32');
      await c.put('https://huggingface.co/${M}/resolve/main/config.json', new Response(JSON.stringify({})));
      const pick3 = await _pickOfflineDtype('${M}', 'q8');            // 沒用外部權重 → 只看 .onnx
      return { names, cfg, missFp32, pick, pick2, pick3 };
    `);
    expect(res.type, JSON.stringify(res)).toBe('T_OK');
    expect(res.out.names.obj).toEqual(['onnx/encoder_model_fp16.onnx', 'onnx/encoder_model_fp16.onnx_data', 'onnx/decoder_model_merged_fp16.onnx', 'onnx/decoder_model_merged_fp16.onnx_data', 'onnx/decoder_model_merged_fp16.onnx_data_1']);
    expect(res.out.names.t).toEqual(['onnx/encoder_model_quantized.onnx', 'onnx/encoder_model_quantized.onnx_data', 'onnx/decoder_model_merged_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx_data']);
    expect(res.out.names.none).toEqual(['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx']);
    expect(res.out.cfg).toBe(true);
    expect(res.out.missFp32).toEqual(['encoder_model.onnx_data']);
    expect(res.out.pick).toBeNull();
    expect(res.out.pick2).toBe('fp32');
    expect(res.out.pick3).toBe('q8');
    await ctx.close();
  });

  test('D-02 真實 Worker LOAD_MODEL（離線）：缺檔 → 不呼叫 pipeline、立即回 MODEL_WEIGHTS_MISSING；有其他 dtype → 改用它；顯示卡權重缺 → 直接用本機一般模式權重', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await openWithHook(ctx, NAMES, 'new');
    const res = await runInWorker(page, `
      _isOffline = function () { return true; };
      loadLib = async function () {};
      const calls = [];
      pipelineFn = async function (task, id, o) { calls.push({ id: id, dtype: o.dtype, device: o.device }); return { dispose: async function () {} }; };
      const out = []; const post = self.postMessage.bind(self);
      self.postMessage = function (m) { out.push({ type: m.type, payload: m.payload }); };
      const load = async function (p) {
        self.dispatchEvent(new MessageEvent('message', { data: { type: 'LOAD_MODEL', payload: Object.assign({ modelId: '${M}', dtype: 'q8', preferGpu: false }, p) } }));
        await new Promise(function (r) { setTimeout(r, 300); });
      };
      ${seedW([])}
      const t0 = performance.now(); await load({}); const ms = performance.now() - t0;
      const afterEmpty = calls.length;
      await load({ afterGpuFail: true });
      ${seedW(['encoder_model_q4.onnx', 'decoder_model_merged_q4.onnx'])}
      await load({});
      Object.defineProperty(self.navigator, 'gpu', { value: { requestAdapter: async function () { return {}; } }, configurable: true });
      await load({ preferGpu: true });
      self.postMessage = post;
      return { out: out, calls: calls, afterEmpty: afterEmpty, ms: ms };
    `);
    expect(res.type, JSON.stringify(res)).toBe('T_OK');
    const { out, calls, afterEmpty } = res.out;
    const errs = out.filter((m: any) => m.type === 'ERROR').map((m: any) => String(m.payload));
    expect(afterEmpty).toBe(0);                                     // 缺檔時沒有去載入（不會等下載失敗）
    expect(errs[0]).toMatch(/^MODEL_WEIGHTS_MISSING: /);
    expect(JSON.parse(errs[0].slice('MODEL_WEIGHTS_MISSING: '.length))).toMatchObject({ modelId: M, dtype: 'q8', stage: 'wasm' });
    expect(JSON.parse(errs[1].slice('MODEL_WEIGHTS_MISSING: '.length)).stage).toBe('gpu-fallback');
    expect(calls[0]).toEqual({ id: M, dtype: 'q4', device: 'wasm' });   // 只有 q4 在本機 → 用 q4
    expect(calls[1]).toEqual({ id: M, dtype: 'q4', device: 'wasm' });   // 顯示卡要 fp32、不在本機 → 不建 GPU session
    const be = out.filter((m: any) => m.type === 'BACKEND').map((m: any) => m.payload);
    expect(be.at(-1)).toMatchObject({ backend: 'wasm-fallback', dtype: 'q4', reason: 'gpu-weights-offline' });
    await ctx.close();
  });

  const runWithLoadErrors = async (browser: any, loadErrors: (string | null)[]) => {
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    const segs = await buildSegments(ctx, { segments: 2, linesPerSegment: 2, charsPerLine: 10, termRate: 0.1, seed: 7 });
    await installScriptedWorker(page, { segments: segs, loadErrors });
    await page.goto(BASE_URL);
    await page.locator('.model-btn[data-model="Xenova/whisper-base"]').click();
    await setToggles(page, [], ['tog_vad', 'tog_uvr']);
    await page.locator('#fileInput').setInputFiles({ name: 'x.wav', mimeType: 'audio/wav', buffer: WAV8 });
    await page.locator('#startBtn').click();
    await expect(page.locator('.batch-item.error')).toHaveCount(1, { timeout: 60_000 });
    const log = (await page.locator('#logBox').textContent()) ?? '';
    const loads = await page.evaluate(() => (window as any).__workerLog.filter((x: any) => x.type === 'LOAD_MODEL'));
    const itemText = (await page.locator('.batch-item.error').textContent()) ?? '';
    return { ctx, log, loads, itemText };
  };
  const missing = (stage: string) => 'MODEL_WEIGHTS_MISSING: ' + JSON.stringify({ modelId: M, dtype: 'q8', stage, files: ['encoder_model_quantized.onnx', 'decoder_model_merged_quantized.onnx'] });

  test('D-03 主程式：Worker 回報離線缺權重 → 白話訊息（不說顯示卡、不夾檔名），檔名只在技術細節', async ({ browser }) => {
    const { ctx, log, loads } = await runWithLoadErrors(browser, [missing('wasm')]);
    expect(loads.length).toBe(1);                                   // 不重試、不降級
    expect(log).toContain('目前沒有網路，而電腦裡找不到「whisper-base」需要的模型檔');
    expect(log).not.toContain('顯示卡加速無法使用');
    expect(log).toContain('技術細節，供回報問題用：離線缺少');
    await ctx.close();
  });

  test('D-04 主程式：顯示卡失敗 → 改一般模式前 Worker 預檢缺檔 → 說明「一般模式要另一組模型檔」；第二次載入帶 afterGpuFail', async ({ browser }) => {
    const { ctx, log, loads } = await runWithLoadErrors(browser, ['GPU_LOAD_FAILED: shader compile failed', missing('wasm')]);
    expect(loads.length).toBe(2);
    expect(loads[1]).toMatchObject({ preferGpu: false, afterGpuFail: true });
    expect(log).toContain('一般模式要用另一組模型檔，目前沒有網路');
    await ctx.close();
  });
});

// ── 人聲 WAV／下載連結 ───────────────────────────────────────────────
test.describe('r9 人聲 WAV（16 kHz 單聲道）與下載連結', () => {
  test('W-01 encodeWavMono16：標頭（單聲道、16 kHz、16-bit）、削波、長度', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await openWithHook(ctx, NAMES, 'new');
    const r = await page.evaluate(async () => {
      const T = (window as any).__t;
      const b: Blob = T.encodeWavMono16(new Float32Array([0, 0.5, -0.5, 2, -2]), 16000);
      const v = new DataView(await b.arrayBuffer());
      const str = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
      return { type: b.type, size: b.size, riff: str(0), wave: str(8), data: str(36), ch: v.getUint16(22, true), rate: v.getUint32(24, true),
        byteRate: v.getUint32(28, true), align: v.getUint16(32, true), bits: v.getUint16(34, true), dataSize: v.getUint32(40, true),
        s: [0, 1, 2, 3, 4].map((i) => v.getInt16(44 + i * 2, true)) };
    });
    expect(r).toMatchObject({ type: 'audio/wav', size: 54, riff: 'RIFF', wave: 'WAVE', data: 'data', ch: 1, rate: 16000, byteRate: 32000, align: 2, bits: 16, dataSize: 10 });
    expect(r.s).toEqual([0, 16384, -16384, 32767, -32768]);
    await ctx.close();
  });

  test('W-02 下載連結：點擊後到時即撤銷 blob URL；再點一次用保留的 Blob 重建；重設時連 Blob 一起放掉', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await openWithHook(ctx, NAMES, 'new');
    const r = await page.evaluate(async () => {
      const T = (window as any).__t; T.evalIn('VOCAL_URL_TTL_MS = 80');
      document.addEventListener('click', (e) => e.preventDefault());     // 測試中不真的觸發下載
      const a = document.getElementById('dlVocalBtn') as HTMLAnchorElement;
      T.showVocalDownload(new Blob(['abc'], { type: 'audio/wav' }), 'lec');
      const u1 = a.getAttribute('href')!; const shown = a.style.display;
      a.click();
      await new Promise((res) => setTimeout(res, 250));
      const afterTtl = a.getAttribute('href');
      const u1Dead = await fetch(u1).then(() => false, () => true);
      a.click();
      const u2 = a.getAttribute('href')!;
      const u2Text = await (await fetch(u2)).text();
      T.resetVocalDownload();
      const u2Dead = await fetch(u2).then(() => false, () => true);
      a.click();                                                            // Blob 已放掉 → 不重建
      return { u1, shown, afterTtl, u1Dead, u2, u2Text, u2Dead, hidden: a.style.display, hrefAfterReset: a.getAttribute('href'), download: a.download };
    });
    expect(r.u1).toMatch(/^blob:/); expect(r.shown).toBe('flex'); expect(r.download).toBe('lec_vocals.wav');
    expect(r.afterTtl).toBe('#'); expect(r.u1Dead).toBe(true);
    expect(r.u2).toMatch(/^blob:/); expect(r.u2).not.toBe(r.u1); expect(r.u2Text).toBe('abc');
    expect(r.u2Dead).toBe(true); expect(r.hidden).toBe('none'); expect(r.hrefAfterReset).toBeNull();
    await ctx.close();
  });
});

// ── 斷點續傳寫入頻率 ─────────────────────────────────────────────────
test.describe('r9 斷點續傳每 5 段寫一次', () => {
  const longWav = (sec: number) => { const n = 16000 * sec, b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(6000 * Math.sin(i / 9)), 44 + i * 2); return b; };
  const spyPuts = (page: Page) => page.addInitScript(() => {
    const w = window as any; w.__taskPuts = [];
    const orig = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (v: any, k?: any) { if (this.name === 'task_state') w.__taskPuts.push(v?.lastChunkIdx); return orig.call(this, v, k); };
  });
  const setup = async (browser: any, rules: any[] = []) => {
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    const segs = await buildSegments(ctx, { segments: 3, linesPerSegment: 2, charsPerLine: 10, termRate: 0.1, seed: 9 });
    await installScriptedWorker(page, { segments: segs, rules });
    await spyPuts(page);
    await page.goto(BASE_URL);
    await page.locator('.model-btn[data-model="Xenova/whisper-base"]').click();
    await setToggles(page, [], ['tog_vad', 'tog_uvr']);
    await page.locator('#fileInput').setInputFiles({ name: 'long.wav', mimeType: 'audio/wav', buffer: longWav(300) });
    await page.locator('#startBtn').click();
    return { ctx, page };
  };

  test('R-01 完整跑完：只在第 0、5、10 段時寫入（原本每段都寫）', async ({ browser }) => {
    test.setTimeout(120_000);
    const { ctx, page } = await setup(browser);
    await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 90_000 });
    const n = await page.evaluate(() => (window as any).__workerLog.filter((x: any) => x.type === 'RUN_CHUNK').length);
    const puts: number[] = await page.evaluate(() => (window as any).__taskPuts);
    expect(n).toBeGreaterThanOrEqual(11);
    expect(puts[0]).toBe(0);                                                   // 開始時建立任務狀態
    expect(puts.slice(1)).toEqual(Array.from({ length: Math.floor(n / 5) }, (_, k) => (k + 1) * 5));
    await ctx.close();
  });

  test('R-02 取消：補寫最後完成的段落（第 7 段卡住時取消 → 續傳點 7）', async ({ browser }) => {
    test.setTimeout(120_000);
    const { ctx, page } = await setup(browser, [{ segIdx: 7, silent: true }]);
    await expect.poll(() => page.evaluate(() => (window as any).__workerLog.some((x: any) => x.type === 'RUN_CHUNK' && x.segIdx === 7)), { timeout: 60_000 }).toBe(true);
    await page.locator('#cancelBtn').click();
    await expect.poll(() => page.evaluate(() => (window as any).__taskPuts.at(-1)), { timeout: 30_000 }).toBe(7);
    const puts: number[] = await page.evaluate(() => (window as any).__taskPuts);
    expect(puts).toEqual([0, 5, 7]);
    await ctx.close();
  });
});
