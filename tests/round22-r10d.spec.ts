// tests/round22-r10d.spec.ts — r10d 診斷版
//   D-01  純函式：燈號邊界、取樣片段、顯示卡分類、開工前檢查、階段百分比
//   D-02  一鍵自測（替身 Worker）：綠燈、未隔離排第一條且寫「1 條」、複製內容含 rtf=/threads=/isolated=/燈=
//   D-03  自測中切到背景 → 結果作廢（invalid-bg）
//   D-04  離線且沒下載過 base → 自測按鈕停用並說明原因
//   D-05  未插電 → 開始時顯示提醒、不擋人，照常轉完
//   D-06  完成後日誌有「⏱ 總計」三階段百分比加總 100；效能資訊可複製
//   D-07  內建顯示卡（Intel UHD）＋base → 直接用 CPU，不試顯示卡；獨立顯示卡照舊先試
//   D-08  顯示卡第 1 段就比即時慢 → 第 1 段後立刻換 CPU 比較
//   D-09  轉檔中切到別的分頁 >3 秒再回來 → 黃字提醒＋日誌
//   D-10  （r10c 上線後覆核 S-A）換回顯示卡失敗 → 重建 CPU Worker，下一段不會卡到逾時
//   D-11  介面：按鈕字級 ≥0.9rem、高 ≥40px；手機寬 375 不出現橫向捲動；運算線路選單
import { test, expect, type Page, type Browser } from '@playwright/test';
import { newCtx, openWithHook, installScriptedWorker, BASE_URL, type Seg } from './harness';
import { setToggles, downloadText } from './helpers';

function wav(sec: number): Buffer {
  const n = 16000 * sec, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 10)), 44 + i * 2);
  return b;
}
const SEGS: Seg[] = [
  [{ text: '甲一', timestamp: [2, 3] }, { text: '甲二', timestamp: [12, 13] }, { text: '接縫一', timestamp: [26.5, 27.2] }],
  [{ text: '接縫一', timestamp: [1.5, 2.2] }, { text: '乙一', timestamp: [10, 11] }, { text: '乙二', timestamp: [20, 21] }, { text: '接縫二', timestamp: [26.5, 27.2] }],
  [{ text: '接縫二', timestamp: [1.5, 2.2] }, { text: '丙一', timestamp: [10, 11] }, { text: '丙二', timestamp: [20, 21] }, { text: '接縫三', timestamp: [26.5, 27.2] }],
  [{ text: '接縫三', timestamp: [1.5, 2.2] }, { text: '丁一', timestamp: [10, 11] }, { text: '丁尾', timestamp: [22, 23] }],
];
const ALL = ['甲一', '甲二', '接縫一', '乙一', '乙二', '接縫二', '丙一', '丙二', '接縫三', '丁一', '丁尾'];
function expectComplete(txt: string) { for (const k of ALL) expect(txt.split(k).length - 1, `「${k}」應出現 1 次`).toBe(1); }
const st = (ms: number, extra: any = {}) => ({ ms, audioSec: 30, enc: 1, dec: 100, encMs: Math.round(ms * 0.3), decMs: Math.round(ms * 0.6), newTokens: 98, loop: null, mode: 'fast', retried: false, flagged: false, ...extra });
const loadsOf = (page: Page) => page.evaluate(() => (window as any).__workerLog.filter((x: any) => x.type === 'LOAD_MODEL').map((x: any) => x.preferGpu));
const chunkWorkers = (page: Page) => page.evaluate(() => (window as any).__workerLog.filter((x: any) => x.type === 'RUN_CHUNK').map((x: any) => x.w));

async function ctxWith(browser: Browser, extra: any = {}) {
  return browser.newContext({ serviceWorkers: 'block', ...extra });
}
async function mockEnv(page: Page, o: { hc?: number; battery?: boolean | null; gpu?: any }) {
  await page.addInitScript((o: any) => {
    if (o.hc) Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, get: () => o.hc });
    if (o.battery !== undefined) Object.defineProperty(navigator, 'getBattery', { configurable: true, value: o.battery === null ? undefined : async () => ({ charging: o.battery }) });
    if (o.gpu) Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => o.gpu === 'empty' ? ({}) : ({ info: o.gpu }) } });
  }, o);
}
async function prep(page: Page, sec = 100, name = 'd.wav') {
  await page.goto(BASE_URL);
  await page.locator('.model-btn[data-model="Xenova/whisper-base"]').click();
  await setToggles(page, [], ['tog_vad', 'tog_uvr', 'tog_diarization', 'tog_hallucination']);
  await page.locator('#fileInput').setInputFiles({ name, mimeType: 'audio/wav', buffer: wav(sec) });
}

test.describe('r10d 純函式', () => {
  test('D-01 燈號、取樣片段、顯示卡分類、開工前檢查、階段百分比', async ({ browser }) => {
    const ctx = await newCtx(browser);
    const p = await openWithHook(ctx, ['selfTestLight', 'selfTestSlice', 'classifyGpu', 'preflightChecks', 'perfShares', 'addPerfSeg', 'newPerfStats', 'selfTestReport'], 'new');
    const r = await p.evaluate(() => {
      const t = (window as any).__t;
      const perf = t.newPerfStats();
      t.addPerfSeg(perf, { ms: 10000, audioSec: 30, encMs: 2900, decMs: 5600 });
      t.addPerfSeg(perf, { ms: 9000, audioSec: 30, encMs: 3000, decMs: 5000, retried: true });
      t.addPerfSeg(perf, { ms: 0 });
      return {
        l: [0.5, 0.8, 0.81, 1.0, 1.01].map(t.selfTestLight),
        s: [t.selfTestSlice(3300), t.selfTestSlice(90), t.selfTestSlice(40)],
        g: [
          t.classifyGpu({ vendor: 'intel', architecture: 'gen-12lp', description: '' }),
          t.classifyGpu({ vendor: 'intel', architecture: 'xe-hpg', description: '' }),
          t.classifyGpu({ vendor: 'nvidia', architecture: 'ampere', description: '' }),
          t.classifyGpu({ vendor: 'amd', architecture: 'rdna-3', description: '' }),
          t.classifyGpu({ vendor: '', architecture: '', description: '', fallback: true }),
          t.classifyGpu(null),
        ],
        pf: [
          t.preflightChecks({ threads: 1, hc: 8, power: '未插電', isIOS: false }).map((x: any) => x.key),
          t.preflightChecks({ threads: 6, hc: 12, power: '插電', isIOS: false }).length,
          t.preflightChecks({ threads: 1, hc: 1, power: '不明', isIOS: false }).length,
        ],
        sh: t.perfShares(perf), segs: perf.segs, retries: perf.retries,
        rep: t.selfTestReport({ rtf: 1.3, isolated: false, threads: 1, hc: 8, power: '未插電', gpu: 'integrated' }),
      };
    });
    expect(r.l).toEqual(['green', 'green', 'yellow', 'yellow', 'red']);
    expect(r.s).toEqual([{ from: 60, len: 60 }, { from: 30, len: 60 }, { from: 0, len: 40 }]);
    expect(r.g).toEqual(['integrated', 'discrete', 'discrete', 'unknown', 'integrated', 'unknown']);
    expect(r.pf).toEqual([['threads', 'power'], 0, 0]);
    expect(r.sh.reduce((a: number, b: number) => a + b, 0)).toBe(100);
    expect(r.segs).toBe(2); expect(r.retries).toBe(1);
    expect(r.rep.light).toBe('red');
    expect(r.rep.causes.map((c: any) => c.key)).toEqual(['no-isolation', 'on-battery', 'gpu-slower']);
    expect(r.rep.causes[0].text).toContain('1 條');
    expect(r.rep.summary).toMatch(/50 分鐘的課約需 \d+–\d+ 分鐘/);
    await ctx.close();
  });
});

test.describe('r10d 一鍵自測', () => {
  test('D-02 自測：結果卡、未隔離排第一、複製內容', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await ctxWith(browser, { permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await ctx.newPage();
    await mockEnv(page, { hc: 8, battery: true });
    await installScriptedWorker(page, { segments: SEGS, rules: [{ segIdx: 0, stats: st(12000) }, { segIdx: 1, stats: st(12000) }] });
    await page.goto(BASE_URL);
    const btn = page.locator('#btnSelfTest');
    await expect(btn).toHaveAttribute('data-state', 'idle');
    // 沒選檔 → 白話說明，不跑
    await btn.click();
    await expect(page.locator('#selfTestHint')).toContainText('請先在下方選一個錄音檔');
    await page.locator('#fileInput').setInputFiles({ name: 'st.wav', mimeType: 'audio/wav', buffer: wav(130) });
    await expect(page.locator('#selfTestPrompt')).toBeVisible();   // 第一次：提示列
    await page.locator('#btnSelfTestGo').click();
    const card = page.locator('#selfTestResult');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#selfTestPrompt')).toBeHidden();
    await expect(card).toHaveAttribute('data-state', 'green');   // 12 s / 30 s = 0.4
    await expect(page.locator('#selfTestTitle')).toContainText('這台電腦夠快');
    await expect(page.locator('#selfTestSummary')).toContainText('50 分鐘的課約需 20–26 分鐘');
    const first = page.locator('#selfTestCauses li').first();
    await expect(first).toHaveAttribute('data-cause', 'no-isolation');   // 測試環境沒有隔離
    await expect(first).toContainText('1 條');
    // 只測 2 段（第 2 分鐘起 60 秒），用 CPU
    const runs = await page.evaluate(() => (window as any).__workerLog.filter((x: any) => x.type === 'RUN_CHUNK').map((x: any) => x.segIdx));
    expect(runs).toEqual([0, 1]);
    expect(await loadsOf(page)).toEqual([false]);
    await page.locator('#btnCopySelfTest').click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    for (const k of ['[Whisper 自測]', 'rtf=0.40', 'threads=', 'isolated=false', '燈=綠', 'hc=8', '電源=插電']) expect(clip).toContain(k);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('whisper-selftest') || 'null'));
    expect(saved.light).toBe('green');
    // 測完開始鈕可按、不會沿用自測的 Worker
    await expect(page.locator('#startBtn')).toBeEnabled();
    await ctx.close();
  });

  test('D-03 自測中切到背景 → 結果作廢', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    await installScriptedWorker(page, { segments: SEGS, rules: [{ segIdx: 0, stats: st(9000), delay: 1500 }, { segIdx: 1, stats: st(9000) }] });
    await page.goto(BASE_URL);
    await page.locator('#fileInput').setInputFiles({ name: 'bg.wav', mimeType: 'audio/wav', buffer: wav(130) });
    await page.locator('#btnSelfTest').click();
    await expect(page.locator('#btnSelfTest')).toHaveAttribute('data-state', /running|downloading/);
    await page.waitForFunction(() => (window as any).__workerLog.some((x: any) => x.type === 'RUN_CHUNK'));
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      setTimeout(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); }, 200);
    });
    await expect(page.locator('#selfTestResult')).toHaveAttribute('data-state', 'invalid-bg', { timeout: 30_000 });
    await expect(page.locator('#selfTestTitle')).toContainText('切到別的頁面');
    await expect(page.locator('#btnSelfTest')).toHaveAttribute('data-state', 'idle');
    await ctx.close();
  });

  test('D-04 離線且沒下載過 base → 自測停用並說明', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    await page.goto(BASE_URL);
    await ctx.setOffline(true);
    await expect(page.locator('#btnSelfTest')).toHaveAttribute('data-state', 'disabled-offline', { timeout: 10_000 });
    await expect(page.locator('#btnSelfTest')).toBeDisabled();
    await expect(page.locator('#selfTestHint')).toContainText('沒有網路');
    await ctx.setOffline(false);
    await expect(page.locator('#btnSelfTest')).toHaveAttribute('data-state', 'idle', { timeout: 10_000 });
    await ctx.close();
  });
});

test.describe('r10d 開工前檢查與計時', () => {
  test('D-05 未插電／單線路 → 開始時提醒、不擋人', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    await mockEnv(page, { hc: 8, battery: false });
    await installScriptedWorker(page, { segments: SEGS });
    await prep(page);
    await expect(page.locator('#preflight')).toBeHidden();
    await page.locator('#startBtn').click();
    await expect(page.locator('#preflight [data-check=power]')).toBeVisible();
    await expect(page.locator('#preflight [data-check=threads]')).toContainText('1 條運算線路');
    await expect(page.locator('#keepAwakeNote')).toContainText('請接上電源');
    await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 60_000 });   // 照常轉完
    expectComplete(await downloadText(page));
    await expect(page.locator('#keepAwakeNote')).toBeHidden();
    await page.locator('#btnPreflightOk').click();
    await expect(page.locator('#preflight')).toBeHidden();
    await ctx.close();
  });

  test('D-06 完成時「⏱ 總計」三階段百分比加總 100；效能資訊可複製', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await ctxWith(browser, { permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await ctx.newPage();
    await mockEnv(page, { battery: true });
    await installScriptedWorker(page, { segments: SEGS, rules: [0, 1, 2, 3].map((i) => ({ segIdx: i, stats: st(6000 + i * 1000) })) });
    await prep(page);
    await page.locator('#startBtn').click();
    await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator('#preflight [data-check=power]')).toHaveCount(0);
    const log = await page.locator('#logBox').innerText();
    expect(log).toMatch(/⏲ 段落 1：30\.0 秒音訊花 6\.0 秒（.*）｜聽 1\.8s・寫 3\.6s・整理 0\.6s/);
    const m = log.match(/⏱ 總計 .*聽音訊 .*（(\d+)%）｜寫字 .*（(\d+)%）｜整理字幕 .*（(\d+)%）｜重試 0 次｜補聽接縫 0 次｜CPU・\d+ 條線路、未隔離/);
    expect(m, log).not.toBeNull();
    expect(Number(m![1]) + Number(m![2]) + Number(m![3])).toBe(100);
    expect(Number(m![1])).toBe(30); expect(Number(m![2])).toBe(60);
    await expect(page.locator('#perfDetails')).toBeVisible();
    await page.locator('#perfDetails summary').click();
    await expect(page.locator('#perfText')).toContainText('[Whisper 轉檔]');
    await page.locator('#btnCopyPerf').click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    for (const k of ['rtf=0.25', '段數=4', 'encoder=9.0s', 'decoder=18.0s', 'threads=', 'isolated=false']) expect(clip).toContain(k);
    await ctx.close();
  });

  test('D-09 轉檔中切到別的分頁 >3 秒 → 黃字提醒＋日誌', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    await installScriptedWorker(page, { segments: SEGS, rules: [{ segIdx: 1, delay: 5000 }] });
    await prep(page);
    await page.locator('#startBtn').click();
    await page.waitForFunction(() => (window as any).__workerLog.some((x: any) => x.type === 'RUN_CHUNK' && x.segIdx === 1));
    const flip = (v: string) => page.evaluate((v) => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v }); document.dispatchEvent(new Event('visibilitychange')); }, v);
    await flip('hidden'); await page.waitForTimeout(500); await flip('visible');
    await expect(page.locator('#bgWarn')).toBeHidden();   // 不到 3 秒不提醒
    await flip('hidden'); await page.waitForTimeout(3300); await flip('visible');
    await expect(page.locator('#bgWarn')).toBeVisible();
    await expect(page.locator('#bgWarn')).toContainText('剛才切到別的頁面');
    await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 60_000 });
    expect(await page.locator('#logBox').innerText()).toMatch(/剛才切到別的頁面.*離開約/);
    await ctx.close();
  });
});

test.describe('r10d 顯示卡選擇', () => {
  async function run(page: Page, gpu: any, rules: any[], loadErrors?: (string | null)[]) {
    await mockEnv(page, { gpu });
    await installScriptedWorker(page, { segments: SEGS, backend: 'webgpu', rules, loadErrors });
    await prep(page);
    await page.locator('#startBtn').click();
    await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 60_000 });
  }
  test('D-07 內建顯示卡＋base → 直接 CPU；獨立顯示卡照舊先試', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    await run(page, { vendor: 'intel', architecture: 'gen-12lp', description: '' }, [0, 1, 2, 3].map((i) => ({ segIdx: i, stats: st(3000) })));
    expect(await loadsOf(page)).toEqual([false]);
    const log = await page.locator('#logBox').innerText();
    expect(log).toContain('只有內建顯示卡');
    expect(log).not.toContain('正在比較');
    expectComplete(await downloadText(page));
    const ctx2 = await newCtx(browser); const p2 = await ctx2.newPage();
    await run(p2, { vendor: 'nvidia', architecture: 'ampere', description: '' }, [0, 1, 2, 3].map((i) => ({ segIdx: i, stats: st(3000) })));
    expect((await loadsOf(p2))[0]).toBe(true);
    expect(await p2.locator('#logBox').innerText()).not.toContain('只有內建顯示卡');
    await ctx.close(); await ctx2.close();
  });

  test('D-08 顯示卡第 1 段就比即時慢 → 第 1 段後立刻換 CPU', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    await run(page, 'empty', [{ segIdx: 0, stats: st(45000) }, { segIdx: 1, stats: st(4000) }, { segIdx: 2, stats: st(4000) }, { segIdx: 3, stats: st(4000) }]);
    expect(await loadsOf(page)).toEqual([true, false]);
    const ws = await chunkWorkers(page);
    expect(ws[1]).not.toBe(ws[0]); expect(ws[2]).toBe(ws[1]);
    expect(await page.locator('#logBox').innerText()).toContain('這台電腦用 CPU 比較快');
    expectComplete(await downloadText(page));
    await ctx.close();
  });

  test('D-10 換回顯示卡失敗 → 重建 CPU Worker，下一段照常（S-A）', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    const t0 = Date.now();
    await run(page, 'empty', [{ segIdx: 0, stats: st(20000) }, { segIdx: 1, stats: st(6000) }, { segIdx: 2, stats: st(15000) }, { segIdx: 3, stats: st(5000) }],
      [null, null, 'MODEL_WEIGHTS_MISSING: {"files":["x"],"stage":"gpu"}']);
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(await loadsOf(page)).toEqual([true, false, true, false]);
    const ws = await chunkWorkers(page);
    expect(ws[3]).not.toBe(ws[2]);
    expect(await page.locator('#logBox').innerText()).toContain('換回顯示卡失敗');
    expectComplete(await downloadText(page));
    await ctx.close();
  });
});

test.describe('r10d 介面', () => {
  test('D-11 按鈕字級與高度、手機不橫向捲動、運算線路選單', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(BASE_URL);
    await page.locator('#fileInput').setInputFiles({ name: 'ui.wav', mimeType: 'audio/wav', buffer: wav(5) });
    for (const id of ['#btnSelfTest', '#btnSelfTestGo', '#btnSelfTestLater']) {
      const el = page.locator(id);
      await expect(el).toBeVisible();
      expect(await el.evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(14.4 - 0.01);
      expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(40);
    }
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(375);
    await page.locator('#btnSelfTestLater').click();
    await expect(page.locator('#selfTestPrompt')).toBeHidden();
    await page.reload();
    await page.locator('#fileInput').setInputFiles({ name: 'ui.wav', mimeType: 'audio/wav', buffer: wav(5) });
    await expect(page.locator('#selfTestPrompt')).toBeHidden();   // 選過「以後再說」不再出現
    const opts = await page.locator('#advThreads option').allTextContents();
    expect(opts[0]).toMatch(/^自動（\d+ 條，建議）$/);
    expect(opts).toContain('6 條');
    await expect(page.locator('#advThreads')).toBeDisabled();   // 未隔離：只能 1 條
    // 去靜音文案
    await expect(page.locator('#tog_vad').locator('xpath=ancestor::div[contains(@class,"post-toggle-row")]')).toContainText('5–15%');
    await ctx.close();
  });
});
