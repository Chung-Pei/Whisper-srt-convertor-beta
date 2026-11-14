// tests/round17-cache-fix.spec.ts — 使用者實測 bug（2026-11-14）：預設值＋whisper-base 一開始就失敗
//   日誌：「顯示卡加速無法使用」＋ Expected property name or '}' in JSON at position 1，接著 Cannot read properties of null (reading 'getReader')。
//   根因：
//     (1) 模型資料夾攔截器把 transformers.js 的「Range: bytes=0-0」（只取 1 個位元組查大小）回應當成完整檔寫入資料夾 → config.json 只剩 "{"；
//         從資料夾讀出的內容又被 transformers.js 存入瀏覽器快取（transformers-cache），毀損一直留著。
//     (2) 空內容（中斷的下載）存進 Cache Storage 後，match() 回傳 body=null → transformers.js readResponse() 的 getReader 崩潰。
//     (3) 以上錯誤被當成 GPU 失敗，改走一般模式（WASM）重載，仍讀到同樣的壞檔。
//   CF-00  重現：真實 transformers.js 4.3.0、未加防護 → 正是使用者看到的兩個錯誤
//   CF-01  加防護後：快取裡的壞 JSON／空內容 → 自動刪除、重新下載、載入成功
//   CF-02  資料夾攔截器：Range 請求不寫檔；有本機檔時回正確 206；壞 JSON／0 位元組檔讀取時自動刪除
//   CF-03  主執行緒：模型檔損壞（JSON／getReader）不當成 GPU 失敗；清除後換新 Worker 重新下載一次並完成
//   CF-04  清除後仍損壞 → 白話錯誤訊息（不再顯示「顯示卡加速無法使用」）
// 全部離線：transformers.js 用 node_modules 內的同版本檔案，Hugging Face 檔案以 context.route 提供。
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { newCtx, openWithHook } from './harness';
import { SAMPLE_AUDIO, setToggles, recognize } from './helpers';

const TJS_FILE = path.join(__dirname, '..', 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.min.js');
const TJS_AVAILABLE = fs.existsSync(TJS_FILE);
const TJS_RE = [/cdn\.jsdelivr\.net\/npm\/@huggingface\/transformers@[^/]+\/dist\/transformers\.min\.js/, /unpkg\.com\/@huggingface\/transformers@[^/]+\/dist\/transformers\.min\.js/];
const CFG_URL = 'https://huggingface.co/Xenova/whisper-base/resolve/main/config.json';
const CFG_BODY = JSON.stringify({ model_type: 'whisper', d_model: 512, architectures: ['WhisperForConditionalGeneration'], pad: 'x'.repeat(2000) });
const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-length, content-range, etag' };

async function routeHf(ctx: BrowserContext) {
  const hits = { full: 0, range: 0 };
  await ctx.route('https://huggingface.co/**', async (r) => {
    const req = r.request();
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { ...CORS, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET' } });
    if (!req.url().endsWith('/config.json')) return r.fulfill({ status: 404, headers: CORS, body: 'not found' });
    const range = (await req.allHeaders())['range'];
    if (range) { hits.range++; return r.fulfill({ status: 206, headers: { ...CORS, 'content-type': 'application/json', 'content-range': `bytes 0-0/${Buffer.byteLength(CFG_BODY)}` }, body: CFG_BODY.slice(0, 1) }); }
    hits.full++;
    return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: CFG_BODY });
  });
  for (const re of TJS_RE) await ctx.route(re, (r) => r.fulfill({ contentType: 'application/javascript', headers: CORS, body: fs.readFileSync(TJS_FILE, 'utf8') }));
  return hits;
}

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

// 預先放進瀏覽器快取的壞內容：bad='brace' → 只有 "{"；bad='empty' → 空內容（match 時 body=null）
const seed = (bad: 'brace' | 'empty') => `
  const c = await caches.open('transformers-cache');
  await c.put(${JSON.stringify(CFG_URL)}, new Response(${bad === 'brace' ? "'{'" : 'new Uint8Array(0)'}, { headers: { 'content-type': 'application/json' } }));
  const repaired = []; _reportRepair = (f, why) => repaired.push(f + ':' + why);`;

test.describe('r9-fix：損壞的模型快取（真實 transformers.js 4.3.0）', () => {
  test.skip(!TJS_AVAILABLE, 'node_modules 內沒有 @huggingface/transformers（請先 npm install）');
  test.setTimeout(120_000);

  for (const bad of ['brace', 'empty'] as const) {
    test(`CF-00 重現（未加防護）：快取內 config.json 為「${bad}」→ ${bad === 'brace' ? 'JSON 解析錯誤' : 'getReader of null'}`, async ({ browser }) => {
      const ctx = await newCtx(browser); await routeHf(ctx);
      const page = await openWithHook(ctx, ['WORKER_CODE', 'spawnWorker'], 'new');
      const r = await runInWorker(page, seed(bad) + `
        await loadLib(); envRef.useCustomCache = false; envRef.customCache = null;   // 拿掉 r9 防護 ＝ 修正前的行為
        const { mod } = await importTransformers();
        await mod.AutoConfig.from_pretrained('Xenova/whisper-base', { progress_callback: () => {} });
        return 'loaded';`);
      expect(r.type).toBe('T_ERR');
      expect(r.err).toContain(bad === 'brace' ? "Expected property name or '}' in JSON at position 1" : "reading 'getReader'");
      await ctx.close();
    });

    test(`CF-01 加防護：快取內 config.json 為「${bad}」→ 自動刪除、重新下載一次、載入成功並存入正確內容`, async ({ browser }) => {
      const ctx = await newCtx(browser); const hits = await routeHf(ctx);
      const page = await openWithHook(ctx, ['WORKER_CODE', 'spawnWorker'], 'new');
      const r = await runInWorker(page, seed(bad) + `
        await loadLib();
        const { mod } = await importTransformers();
        const cfg = await mod.AutoConfig.from_pretrained('Xenova/whisper-base', { progress_callback: () => {} });
        const again = await (await (await caches.open('transformers-cache')).match(${JSON.stringify(CFG_URL)})).text();
        return { type: cfg.model_type, repaired, cachedOk: JSON.parse(again).model_type === 'whisper' };`);
      expect(r.type, JSON.stringify(r)).toBe('T_OK');
      expect(r.out.type).toBe('whisper');
      expect(r.out.cachedOk).toBe(true);
      expect(r.out.repaired.length).toBeGreaterThanOrEqual(1);
      expect(r.out.repaired[0]).toContain('config.json');
      expect(hits.full).toBe(1);
      await ctx.close();
    });
  }

  test('CF-01b 加防護：壞內容不會被寫入快取（put 拒收）', async ({ browser }) => {
    const ctx = await newCtx(browser); await routeHf(ctx);
    const page = await openWithHook(ctx, ['WORKER_CODE', 'spawnWorker'], 'new');
    const r = await runInWorker(page, `
      await guardedCache.put(${JSON.stringify(CFG_URL)}, new Response('{'));
      await guardedCache.put('https://huggingface.co/Xenova/whisper-base/resolve/main/onnx/model.onnx', new Response(new Uint8Array(0), { headers: { 'content-length': '0' } }));   // transformers.js 存檔時一律帶 content-length
      await guardedCache.put('https://huggingface.co/Xenova/whisper-base/resolve/main/tokenizer.json', new Response('{"a":1}'));
      const keys = (await (await caches.open('transformers-cache')).keys()).map((k) => k.url.split('/').pop());
      return keys;`);
    expect(r.out).toEqual(['tokenizer.json']);
    await ctx.close();
  });
});

test('CF-02 模型資料夾：Range 請求不寫檔、有本機檔時回 206；壞 JSON 與 0 位元組檔讀取時自動刪除', async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await newCtx(browser); const hits = await routeHf(ctx);
  const page = await openWithHook(ctx, ['WORKER_CODE', 'spawnWorker'], 'new');
  const r = await runInWorker(page, `
    const root = await navigator.storage.getDirectory();
    modelFolderHandle = root; installFolderFetchInterceptor();
    const repaired = []; _reportRepair = (f, why) => repaired.push(f);
    const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
    const exists = async (p) => { try { const loc = await _folderDirAndName(p, false); await loc.dir.getFileHandle(loc.name); return true; } catch (_) { return false; } };
    const U = ${JSON.stringify(CFG_URL)}, P = 'Xenova/whisper-base/config.json';
    const r1 = await fetch(U, { headers: { Range: 'bytes=0-0' } }); const t1 = await r1.text(); await sleep(400);
    const afterRange = await exists(P);
    const r2 = await fetch(U); const t2 = await r2.text(); await sleep(600);
    const f = await readFromModelFolder(P); const t3 = f ? await f.text() : null;
    const r3 = await fetch(U, { headers: { Range: 'bytes=0-0' } });
    const local206 = { status: r3.status, body: await r3.text(), range: r3.headers.get('content-range') };
    // 人為弄壞：只有 "{" 的 JSON、0 位元組的 onnx
    const loc = await _folderDirAndName(P, true);
    let w = await (await loc.dir.getFileHandle(loc.name, { create: true })).createWritable(); await w.write('{'); await w.close();
    const badJson = await readFromModelFolder(P); const badJsonExists = await exists(P);
    const loc2 = await _folderDirAndName('Xenova/whisper-base/onnx/model.onnx', true);
    w = await (await loc2.dir.getFileHandle(loc2.name, { create: true })).createWritable(); await w.close();
    const empty = await readFromModelFolder('Xenova/whisper-base/onnx/model.onnx'); const emptyExists = await exists('Xenova/whisper-base/onnx/model.onnx');
    return { r1: [r1.status, t1], afterRange, t2ok: t2 === t3, local206, badJson: badJson === null, badJsonExists, empty: empty === null, emptyExists, repaired };`);
  expect(r.type, JSON.stringify(r)).toBe('T_OK');
  const o = r.out;
  expect(o.r1).toEqual([206, '{']);
  expect(o.afterRange).toBe(false);                       // 修正前：這裡會寫出只有 "{" 的 config.json
  expect(o.t2ok).toBe(true);                              // 完整下載才寫入資料夾，內容一致
  expect(o.local206).toEqual({ status: 206, body: '{', range: `bytes 0-0/${Buffer.byteLength(CFG_BODY)}` });
  expect(o.badJson).toBe(true); expect(o.badJsonExists).toBe(false);
  expect(o.empty).toBe(true); expect(o.emptyExists).toBe(false);
  expect(o.repaired.length).toBe(2);
  expect(hits.range).toBe(1);                             // 第 2 次 Range 由本機檔回答，未連網
  expect(hits.full).toBe(1);
  await ctx.close();
});

// ── 主執行緒：損壞 ≠ GPU 失敗 ──────────────────────────────────────────
async function corruptLoad(page: Page, errMsg: string, fails: number) {
  const stubLib = `
    try { Object.defineProperty(WorkerNavigator.prototype, 'gpu', { get: () => ({ requestAdapter: async () => ({}) }), configurable: true }); } catch (_) {}
    export const env = {};
    export const ModelRegistry = { get_available_dtypes: async () => ['fp32', 'q8', 'q4'] };
    export async function pipeline(task, id, opts) {
      const c = await caches.open('stub-counter'); const n = (await c.keys()).length;
      await c.put('https://stub.invalid/n' + n, new Response('x'));
      if (n < ${fails}) throw new Error(${JSON.stringify(errMsg)});
      const fn = async () => ({ chunks: [{ text: '測試', timestamp: [0, 1] }] });
      fn.dispose = async () => {};
      return fn;
    }`;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { get: () => ({ requestAdapter: async () => ({}) }), configurable: true });
    const w = window as any; w.__loads = []; w.__workers = [];
    const RealWorker = window.Worker;
    w.Worker = class extends RealWorker {
      constructor(u: any, o: any) {
        super(u, o); const rec = { terminated: false }; w.__workers.push(rec);
        const t = this.terminate.bind(this); this.terminate = () => { rec.terminated = true; t(); };
      }
      postMessage(m: any, tr?: any) { if (m?.type === 'LOAD_MODEL') w.__loads.push({ worker: w.__workers.length, preferGpu: m.payload.preferGpu, bypassFolder: m.payload.bypassFolder }); return tr ? super.postMessage(m, tr) : super.postMessage(m); }
    };
  });
  for (const re of TJS_RE) await page.route(re, (r) => r.fulfill({ contentType: 'application/javascript', body: stubLib }));
  await page.route('**/opencc-js@*/dist/umd/cn2t.js', (r) => r.fulfill({ contentType: 'application/javascript', body: 'window.OpenCC = { Converter: () => (t) => t };' }));
  await recognize(page);
  // 快取裡放一個此模型的檔案：損壞時 Worker 應清掉它（下次重新下載）
  await page.evaluate(async () => { const c = await caches.open('transformers-cache'); await c.put('https://huggingface.co/Xenova/whisper-base/resolve/main/config.json', new Response('{"a":1}')); });
  await setToggles(page, [], ['tog_vad', 'tog_uvr', 'tog_diarization']);
  await page.locator('#fileInput').setInputFiles(SAMPLE_AUDIO);
  await page.locator('#startBtn').click();
  if (fails >= 2) await expect(page.locator('.batch-item.error')).toHaveCount(1, { timeout: 90_000 });
  else await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 90_000 });
  return page.evaluate(async () => ({
    loads: (window as any).__loads, workers: (window as any).__workers,
    log: document.getElementById('logBox')!.textContent,
    cacheLeft: (await (await caches.open('transformers-cache')).keys()).length,
  }));
}

for (const msg of ["Expected property name or '}' in JSON at position 1 (line 1 column 2)", "Cannot read properties of null (reading 'getReader')"]) {
  test(`CF-03 載入遇到「${msg.slice(0, 40)}…」→ 不當成 GPU 失敗；清除快取、換新 Worker 重新下載一次並完成`, async ({ page }) => {
    test.setTimeout(120_000);
    const r = await corruptLoad(page, msg, 1);
    expect(r.loads).toEqual([{ worker: 1, preferGpu: true, bypassFolder: false }, { worker: 2, preferGpu: true, bypassFolder: true }]);
    expect(r.workers[0].terminated).toBe(true);
    expect(r.log).not.toContain('顯示卡加速無法使用');
    expect(r.log).toContain('已自動清除，正在重新下載');
    expect(r.cacheLeft).toBe(0);
  });
}

test('CF-04 清除並重新下載後仍損壞 → 白話錯誤訊息，不顯示「顯示卡加速無法使用」', async ({ page }) => {
  test.setTimeout(120_000);
  const r = await corruptLoad(page, "Expected property name or '}' in JSON at position 1 (line 1 column 2)", 2);
  expect(r.loads.length).toBe(2);
  expect(r.log).toContain('模型檔案無法正確讀取');
  expect(r.log).toContain('重新整理頁面再試');
  expect(r.log).not.toContain('顯示卡加速無法使用');
});
