// tests/round19-r10-threads.spec.ts — r10：多核心運算（使用者 2026-11-14：一般模式 base 轉 55 分鐘課預估 220 分鐘以上，慢到不堪用）
//   根因：GitHub Pages 不送 COOP/COEP → 頁面不是 crossOriginIsolated → 沒有 SharedArrayBuffer → onnxruntime-web 只用 1 條執行緒。
//   修正：sw.js 在頁面回應補 COOP: same-origin＋COEP: credentialless；第一次開啟／SW 更新時自動重新載入一次；Worker 明確設定執行緒數。
//   MT-01  真的 Service Worker：開啟後自動重新載入一次 → 頁面已隔離、有 SharedArrayBuffer；頁面回應帶兩個標頭；本地字型照常載入；記號清除
//   MT-02  離線（SW 從快取回應頁面）仍帶標頭、仍隔離
//   MT-03  瀏覽器不支援（模擬：SW 不補標頭）→ 最多重新載入一次，不會無限重載，頁面照常可用
//   MT-04  已選檔案時 SW 更新 → 不自動重新載入（不打斷使用者）
//   MT-05  執行緒數規則：未隔離＝1；2 核以下全用；其餘＝核心數−1，最多 8
//   MT-06  隔離後真實 onnxruntime-web 在 Worker 內以 2 條執行緒建立 session 並推論成功（跨站載入的 WASM／執行緒 Worker 不被擋）
import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { BASE_URL, routeRealOrt, REAL_ORT_AVAILABLE, HALF_MODEL_PATH, ROOT_HTML } from './harness';
import { SAMPLE_AUDIO } from './helpers';

async function openIsolated(page: Page) {
  await page.goto(BASE_URL);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => self.crossOriginIsolated === true, null, { timeout: 15_000 });
  await page.waitForLoadState('load');
}

test.describe('r10 多核心運算（跨來源隔離）', () => {
  test('MT-01 SW 補標頭＋自動重新載入一次 → 已隔離、字型正常', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    let navs = 0;
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs++; });
    await openIsolated(page);
    expect(navs).toBe(2);                                                    // 原本那次＋自動重新載入一次
    const st = await page.evaluate(async () => ({
      sab: typeof SharedArrayBuffer !== 'undefined',
      flag: sessionStorage.getItem('whisper-coi-reload'),
      fonts: (await document.fonts.ready, [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family)),
    }));
    expect(st.sab).toBe(true);
    expect(st.flag).toBeNull();
    // 頁面回應的標頭（第二次以後由 SW 回應）
    const resp = await page.reload();
    expect(resp!.headers()['cross-origin-opener-policy']).toBe('same-origin');
    expect(resp!.headers()['cross-origin-embedder-policy']).toBe('credentialless');
    await page.waitForFunction(() => self.crossOriginIsolated === true);
    expect(navs).toBe(3);                                                    // 已隔離後不再自動重新載入
    const fonts = await page.evaluate(async () => { await document.fonts.ready; await document.fonts.load('16px "IBM Plex Mono"'); return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family); });
    expect(fonts).toContain('IBM Plex Mono');
    await ctx.close();
  });

  test('MT-02 離線開啟：SW 快取的頁面仍帶標頭、仍隔離', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await openIsolated(page);
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForLoadState('load');
    expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
    await expect(page.locator('#startBtn')).toBeVisible();
    await ctx.close();
  });

  test('MT-03 瀏覽器不支援隔離：最多重新載入一次，不會無限重載', async ({ browser }) => {
    const ctx = await browser.newContext();
    // 模擬 Safari：SW 不補標頭（withIsolationHeaders 原樣回傳）
    const sw = fs.readFileSync(path.join(path.dirname(ROOT_HTML), 'sw.js'), 'utf8')
      .replace('function withIsolationHeaders(response) {', 'function withIsolationHeaders(response) { return response;');
    await ctx.route(/\/sw\.js$/, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: sw }));
    const page = await ctx.newPage();
    let navs = 0;
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs++; });
    await page.goto(BASE_URL);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForTimeout(4000);
    expect(navs).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(false);
    await page.reload(); await page.waitForTimeout(1500);
    expect(navs).toBeLessThanOrEqual(3);                                     // 同一分頁不再自動重載
    await expect(page.locator('#startBtn')).toBeVisible();
    await ctx.close();
  });

  test('MT-04 已選檔案時 SW 接管 → 不自動重新載入', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    let navs = 0;
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs++; });
    // SW 註冊延後到選好檔案之後：攔下 register 直到測試放行
    await page.addInitScript(() => {
      const orig = navigator.serviceWorker.register.bind(navigator.serviceWorker);
      (navigator.serviceWorker as any).register = (u: string, o: any) => new Promise((res) => { (window as any).__goSW = () => res(orig(u, o)); });
    });
    await page.goto(BASE_URL);
    await page.waitForFunction(() => typeof (window as any).__goSW === 'function');
    await page.locator('#fileInput').setInputFiles(SAMPLE_AUDIO);
    await expect(page.locator('.batch-item')).toHaveCount(1);
    await page.evaluate(() => (window as any).__goSW());
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10_000 });
    await page.waitForTimeout(1500);
    expect(navs).toBe(1);
    await expect(page.locator('.batch-item')).toHaveCount(1);              // 使用者選的檔案還在
    await ctx.close();
  });

  test('MT-05 執行緒數規則', async () => {
    const html = fs.readFileSync(ROOT_HTML, 'utf8');
    const src = html.match(/function wasmThreadCount\(\) \{[\s\S]*?\n\}/)![0];
    const calc = (iso: boolean, hc: number | undefined, sab = true) => {
      const fakeSelf = { crossOriginIsolated: iso, navigator: { hardwareConcurrency: hc } };
      return new Function('self', 'SharedArrayBuffer', `${src}; return wasmThreadCount();`)(fakeSelf, sab ? SharedArrayBuffer : undefined);
    };
    expect(calc(false, 16)).toBe(1);
    expect(calc(true, 16, false)).toBe(1);
    expect(calc(true, undefined)).toBe(1);
    expect(calc(true, 1)).toBe(1);
    expect(calc(true, 2)).toBe(2);
    expect(calc(true, 4)).toBe(3);
    expect(calc(true, 8)).toBe(7);
    expect(calc(true, 12)).toBe(8);
    expect(calc(true, 32)).toBe(8);
    // 辨識 Worker 與人聲分離共用同一規則，且設在 Transformers.js 的 onnx wasm 設定上
    expect(html).toContain('envRef.backends.onnx.wasm.numThreads = wasmThreads');
    expect(html).toContain('const threads = wasmThreadCount();');
    expect(html).not.toContain('self.crossOriginIsolated ? Math.min(4');
  });

  test('MT-06 隔離後真實 onnxruntime-web 在 Worker 內用 2 條執行緒推論成功', async ({ browser }) => {
    test.skip(!REAL_ORT_AVAILABLE, '需要 node_modules/onnxruntime-web 與 half-model.onnx');
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const served: string[] = [];
    await routeRealOrt(page, served);
    await openIsolated(page);
    const model = Array.from(fs.readFileSync(HALF_MODEL_PATH));
    const r = await page.evaluate(async (bytes) => {
      const code = `
        self.onmessage = async (e) => {
          try {
            importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.all.min.js');
            ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
            ort.env.wasm.numThreads = 2;
            const s = await ort.InferenceSession.create(new Uint8Array(e.data), { executionProviders: ['wasm'] });
            const name = s.inputNames[0];
            const dims = [1, 4, 3072, 256], n = dims.reduce((a, b) => a * b, 1);
            const x = new Float32Array(n).map((_, i) => (i % 7) - 3);
            const out = await s.run({ [name]: new ort.Tensor('float32', x, dims) });
            const y = out[s.outputNames[0]].data;
            self.postMessage({ ok: true, iso: self.crossOriginIsolated, threads: ort.env.wasm.numThreads, y0: y[1], x0: x[1] });
          } catch (err) { self.postMessage({ ok: false, err: String(err && err.message || err), iso: self.crossOriginIsolated }); }
        };`;
      const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
      const res: any = await new Promise((resolve) => { w.onmessage = (e) => resolve(e.data); w.onerror = (e) => resolve({ ok: false, err: e.message }); w.postMessage(new Uint8Array(bytes).buffer); });
      w.terminate();
      return res;
    }, model);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.iso).toBe(true);
    expect(r.threads).toBe(2);
    expect(r.y0).toBeCloseTo(r.x0 * 0.5, 5);
    expect(served.some((f) => /threaded.*\.wasm$/.test(f)), served.join(', ')).toBe(true);
    await ctx.close();
  });
});
