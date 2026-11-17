// tests/round21-r10c.spec.ts — r10c 暫停／繼續、幻覺偵測併入待確認、顯示卡自動試用
//   P-01  暫停 → 目前這段做完才停、存斷點、顯示「已暫停」；繼續 → 不重載模型，字幕完整不重不漏
//   P-02  暫停中關掉網頁 → 重開出現「恢復任務」→ 選同一檔案從斷點接續，字幕完整不重不漏
//   H-01  可疑字幕（套話／孤立短句、字速異常、只有括號）→ 預設在預覽「待確認」標出、匯出字幕無 ⚠；老師重述不誤判
//   H-02  勾選進階「匯出時在可疑字幕前加 ⚠」才寫 ⚠
import { test, expect, type Page } from '@playwright/test';
import { newCtx, openWithHook, installScriptedWorker, exposeInternals, BASE_URL, type Seg } from './harness';
import { setToggles, downloadText } from './helpers';

function wav(sec: number): Buffer {
  const n = 16000 * sec, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 10)), 44 + i * 2);
  return b;
}
// 100 秒、不開 VAD → 視窗 [0,30] [25,55] [50,80] [75,100]；每窗字都在非重疊區，加上接縫區各一個兩窗都聽到的字
const SEGS: Seg[] = [
  [{ text: '甲一', timestamp: [2, 3] }, { text: '甲二', timestamp: [12, 13] }, { text: '接縫一', timestamp: [26.5, 27.2] }],
  [{ text: '接縫一', timestamp: [1.5, 2.2] }, { text: '乙一', timestamp: [10, 11] }, { text: '乙二', timestamp: [20, 21] }, { text: '接縫二', timestamp: [26.5, 27.2] }],
  [{ text: '接縫二', timestamp: [1.5, 2.2] }, { text: '丙一', timestamp: [10, 11] }, { text: '丙二', timestamp: [20, 21] }, { text: '接縫三', timestamp: [26.5, 27.2] }],
  [{ text: '接縫三', timestamp: [1.5, 2.2] }, { text: '丁一', timestamp: [10, 11] }, { text: '丁尾', timestamp: [22, 23] }],
];
const ALL = ['甲一', '甲二', '接縫一', '乙一', '乙二', '接縫二', '丙一', '丙二', '接縫三', '丁一', '丁尾'];
function expectComplete(txt: string) {
  for (const k of ALL) expect(txt.split(k).length - 1, `「${k}」應出現 1 次`).toBe(1);
}
async function runs(page: Page) {
  return page.evaluate(() => (window as any).__workerLog.filter((x: any) => x.type === 'RUN_CHUNK').map((x: any) => x.segIdx));
}

test.describe('r10c 暫停／繼續', () => {
  test('P-01 暫停 → 這段做完才停、存斷點；繼續 → 不重載模型、字幕完整不重不漏', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    await installScriptedWorker(page, { segments: SEGS, rules: [{ segIdx: 1, delay: 1500 }] });
    await page.goto(BASE_URL);
    await page.locator('.model-btn[data-model="Xenova/whisper-base"]').click();
    await setToggles(page, [], ['tog_vad', 'tog_uvr', 'tog_diarization', 'tog_hallucination']);
    await page.locator('#fileInput').setInputFiles({ name: 'pause.wav', mimeType: 'audio/wav', buffer: wav(100) });
    await expect(page.locator('#pauseBtn')).toBeHidden();
    await page.locator('#startBtn').click();
    const pb = page.locator('#pauseBtn');
    await expect(pb).toBeVisible();
    await expect(pb).toHaveText('⏸ 暫停');
    // 介面：字級 ≥0.9rem、高 ≥40px，和紅色「取消」分開
    const fs = await pb.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fs).toBeGreaterThanOrEqual(0.9 * 16 - 0.01);
    expect((await pb.boundingBox())!.height).toBeGreaterThanOrEqual(40);
    expect((await page.locator('#cancelBtn').boundingBox())!.height).toBeGreaterThanOrEqual(40);
    // 第 2 段辨識中按暫停
    await page.waitForFunction(() => (window as any).__workerLog.some((x: any) => x.type === 'RUN_CHUNK' && x.segIdx === 1));
    await pb.click();
    await expect(pb).toContainText('這一段辨識完就暫停');
    await expect(pb).toHaveText('▶ 繼續辨識', { timeout: 10_000 });
    await expect(page.locator('#pauseNote')).toContainText('已暫停，進度已存好');
    await expect(page.locator('#progLabel')).toHaveText('已暫停');
    await page.waitForTimeout(800);
    expect(await runs(page)).toEqual([0, 1]);   // 沒有再往下跑
    // 斷點已存（以秒對齊）
    const saved = await page.evaluate(() => new Promise<any>((res) => {
      const rq = indexedDB.open('whisper-audio-cache');
      rq.onsuccess = () => { try { const db = rq.result; const name = [...db.objectStoreNames].find((n) => /task/i.test(n))!; const g = db.transaction(name).objectStore(name).getAll(); g.onsuccess = () => res(g.result); g.onerror = () => res(null); } catch (e) { res(String(e)); } };
      rq.onerror = () => res(null);
    }));
    expect(JSON.stringify(saved)).toContain('pause.wav');
    expect(saved.find((t: any) => t.fileName === 'pause.wav').resumeSec).toBeGreaterThanOrEqual(30);
    await pb.click();   // 繼續
    await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 60_000 });
    expect(await runs(page)).toEqual([0, 1, 2, 3]);
    const loads = await page.evaluate(() => (window as any).__workerLog.filter((x: any) => x.type === 'LOAD_MODEL').length);
    expect(loads).toBe(1);   // 不重載模型
    expectComplete(await downloadText(page));
    await expect(pb).toBeHidden();
    const log = await page.locator('#logBox').innerText();
    expect(log).toContain('⏸ 已暫停'); expect(log).toContain('▶ 繼續辨識');
    await ctx.close();
  });

  test('P-02 暫停中關掉網頁 → 重開「恢復任務」→ 選同一檔案從斷點接續，不重不漏', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    await installScriptedWorker(page, { segments: SEGS, rules: [{ segIdx: 1, delay: 1500 }] });
    const b64 = wav(100).toString('base64');
    const pick = (p: Page) => p.evaluate((b64) => {
      const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const dt = new DataTransfer(); dt.items.add(new File([u], 'lecture.wav', { type: 'audio/wav', lastModified: 1700000000000 }));
      const inp = document.getElementById('fileInput') as HTMLInputElement; inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
    }, b64);
    await page.goto(BASE_URL);
    await page.locator('.model-btn[data-model="Xenova/whisper-base"]').click();
    await setToggles(page, [], ['tog_vad', 'tog_uvr', 'tog_diarization', 'tog_hallucination']);
    await pick(page);
    await page.locator('#startBtn').click();
    await page.waitForFunction(() => (window as any).__workerLog.some((x: any) => x.type === 'RUN_CHUNK' && x.segIdx === 1));
    await page.locator('#pauseBtn').click();
    await expect(page.locator('#pauseBtn')).toHaveText('▶ 繼續辨識', { timeout: 10_000 });
    await page.close();   // 暫停中關掉網頁

    const p2 = await ctx.newPage();
    await installScriptedWorker(p2, { segments: SEGS });
    await p2.goto(BASE_URL);
    await expect(p2.locator('#resumeBanner')).toBeVisible();
    await expect(p2.locator('#resumeInfo')).toContainText('lecture.wav');
    await p2.locator('#btnResume').click();
    await p2.locator('.model-btn[data-model="Xenova/whisper-base"]').click();
    await setToggles(p2, [], ['tog_vad', 'tog_uvr', 'tog_diarization', 'tog_hallucination']);
    await pick(p2);
    await p2.locator('#startBtn').click();
    await expect(p2.locator('.batch-item.done')).toHaveCount(1, { timeout: 60_000 });
    const ran = await runs(p2);
    expect(ran[0]).toBeGreaterThanOrEqual(1);   // 沒有從頭重跑
    expect(await p2.locator('#logBox').innerText()).toContain('斷點續傳');
    expectComplete(await downloadText(p2));
    await ctx.close();
  });
});

// 60 秒：一般句子＋「謝謝觀看」（套話）＋孤立短句＋字速異常＋只有括號＋老師重述
const HSEGS: Seg[] = [
  [{ text: '抗體的結構，抗體的功能', timestamp: [1, 4] }, { text: '今天講補體', timestamp: [4.5, 6] }, { text: '〔音樂〕', timestamp: [7, 8] },
   { text: '補體系統有三條路徑', timestamp: [9, 11] }, { text: '巨噬細胞巨噬細胞巨噬細胞吞噬作用', timestamp: [12, 12.6] }, { text: '然後我們看下一張', timestamp: [13.5, 15] },
   { text: '謝謝觀看', timestamp: [21, 22] }],
  [{ text: '好那我們繼續', timestamp: [10, 12] }, { text: '嗯', timestamp: [17, 17.5] }, { text: '最後一句', timestamp: [24, 26] }],
];
async function runH(page: Page, on: string[]) {
  await installScriptedWorker(page, { segments: HSEGS });
  await page.goto(BASE_URL);
  await page.locator('.model-btn[data-model="Xenova/whisper-base"]').click();
  await setToggles(page, on, ['tog_vad', 'tog_uvr', 'tog_diarization', 'tog_merge', 'tog_split', 'tog_mindur', 'tog_overlap'].concat(on.includes('tog_hallucination') ? [] : ['tog_hallucination']));
  await page.locator('#fileInput').setInputFiles({ name: 'h.wav', mimeType: 'audio/wav', buffer: wav(50) });
  await page.locator('#startBtn').click();
  await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 60_000 });
}

test.describe('r10c 可疑字幕併入待確認', () => {
  test('H-00 純函式：舊的重複詞組判定已拿掉；三項＋套話仍偵測', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await openWithHook(ctx, ['detectHallucinations', 'hallucinationMarks'], 'new');
    const r = await page.evaluate(() => {
      const T = (window as any).__t;
      const subs = [
        { start: 0, end: 3, text: '抗體的結構，抗體的功能' },
        { start: 3.2, end: 5, text: 'IgG IgG 是最多的' },
        { start: 5.2, end: 7, text: '〔音樂〕' },
        { start: 7.2, end: 7.5, text: '補體補體補體補體補體' },
        { start: 20, end: 21, text: '嗯好' },
        { start: 30, end: 33, text: '停了很久之後老師開始講新的一章內容' },
        { start: 33.2, end: 35, text: '請不吝點贊訂閱' },
      ];
      return T.detectHallucinations(subs).map((s: any) => (s._halluReasons || []).map((x: any) => x.code).join(','));
    });
    expect(r).toEqual(['', '', 'bracket', 'speed', 'isolated', '', 'phrase']);
    await ctx.close();
  });

  test('H-01 預設：預覽有待確認標記（可疑字幕）、匯出字幕無 ⚠、完成畫面一句話', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    await runH(page, []);
    await expect(page.locator('#tog_hallucination')).not.toBeChecked();
    const txt = await downloadText(page);
    expect(txt).not.toContain('⚠');
    for (const k of ['抗體的結構，抗體的功能', '謝謝觀看', '最後一句']) expect(txt).toContain(k);
    await expect(page.locator('#uvrNotice')).toContainText('句字幕可能有誤');
    const id = await page.locator('.batch-item.done').first().getAttribute('data-id');
    await page.locator(`.batch-item-preview-btn[data-id="${id}"]`).click();
    const panel = page.locator(`.item-preview-panel[data-id="${id}"]`);
    await expect(panel.locator('.preview-review-title')).toContainText('字幕可能有誤');
    await expect(panel.locator('.preview-review-title')).toContainText('字幕檔裡不會有任何記號');
    const items = await panel.locator('.preview-review-item').allInnerTexts();
    const all = items.join('\n');
    expect(all).toContain('只有括號');
    expect(all).toContain('套話');
    expect(all).toContain('每秒');
    expect(all).toContain('前後都很久沒有字幕');
    expect(all).not.toMatch(/0:0[0-4].*(套話|前後)/);   // 老師重述「抗體…抗體」不標
    const times = items.map((t) => t.slice(0, 8));
    expect([...times].sort()).toEqual(times);   // 依時間排序
    await ctx.close();
  });

  test('H-02 勾選進階「匯出時在可疑字幕前加 ⚠」才寫 ⚠', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    await runH(page, ['tog_hallucination']);
    const txt = await downloadText(page);
    expect(txt).toContain('⚠ 謝謝觀看');
    expect(txt).not.toContain('⚠ 抗體的結構');
    await ctx.close();
  });
});

// ── r10c (b)：顯示卡 vs CPU 自動試用（替身 Worker；沙盒沒有顯示卡，真機速度要使用者實測）
async function runTrial(page: Page, cpuMs: number) {
  await page.addInitScript(() => { if (!(navigator as any).gpu) Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: async () => ({}) }, configurable: true }); });
  const st = (ms: number) => ({ ms, audioSec: 30, enc: 1, dec: 100, newTokens: 98, loop: null, mode: 'fast', retried: false, flagged: false });
  await installScriptedWorker(page, { segments: SEGS, backend: 'webgpu', rules: [
    { segIdx: 0, stats: st(20000) }, { segIdx: 1, stats: st(6000) }, { segIdx: 2, stats: st(cpuMs) }, { segIdx: 3, stats: st(5000) }] });
  await page.goto(BASE_URL);
  await page.locator('.model-btn[data-model="Xenova/whisper-base"]').click();
  await setToggles(page, [], ['tog_vad', 'tog_uvr', 'tog_diarization', 'tog_hallucination']);
  await page.locator('#fileInput').setInputFiles({ name: 'g.wav', mimeType: 'audio/wav', buffer: wav(100) });
  await page.locator('#startBtn').click();
  await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 60_000 });
}
const loadsOf = (page: Page) => page.evaluate(() => (window as any).__workerLog.filter((x: any) => x.type === 'LOAD_MODEL').map((x: any) => x.preferGpu));
const chunkWorkers = (page: Page) => page.evaluate(() => (window as any).__workerLog.filter((x: any) => x.type === 'RUN_CHUNK').map((x: any) => x.w));

test.describe('r10c 顯示卡 vs CPU 自動試用', () => {
  test('G-01 CPU 比較快 → 後面改用 CPU、記住；下次直接用 CPU；字幕完整', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    await runTrial(page, 3000);
    expect(await loadsOf(page)).toEqual([true, false]);   // 先顯示卡，第 2 段後換 CPU，不再換回
    const ws = await chunkWorkers(page);
    expect(ws[0]).toBe(ws[1]); expect(ws[2]).not.toBe(ws[1]); expect(ws[3]).toBe(ws[2]);
    const log = await page.locator('#logBox').innerText();
    expect(log).toContain('正在比較顯示卡和 CPU 哪個比較快');
    expect(log).toContain('這台電腦用 CPU 比較快（每 1 分鐘音訊：CPU 約 6 秒、顯示卡約 12 秒）');
    expect(log).not.toMatch(/token|WASM\b/);
    expectComplete(await downloadText(page));
    const pick = await page.evaluate(() => JSON.parse(localStorage.getItem('whisper-backend-pick') || '{}')['Xenova/whisper-base']);
    expect(pick.pick).toBe('wasm');
    // 下次：直接用 CPU，不再比
    const p2 = await ctx.newPage();
    await runTrial(p2, 3000);
    expect(await loadsOf(p2)).toEqual([false]);
    expect(await p2.locator('#logBox').innerText()).not.toContain('正在比較');
    await ctx.close();
  });

  test('G-02 顯示卡比較快 → 換回顯示卡、記住；字幕完整不重不漏', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    await runTrial(page, 15000);
    expect(await loadsOf(page)).toEqual([true, false, true]);
    expect(await page.locator('#logBox').innerText()).toContain('這台電腦用顯示卡比較快');
    expectComplete(await downloadText(page));
    const pick = await page.evaluate(() => JSON.parse(localStorage.getItem('whisper-backend-pick') || '{}')['Xenova/whisper-base']);
    expect(pick.pick).toBe('webgpu');
    const p2 = await ctx.newPage();
    await runTrial(p2, 15000);
    expect(await loadsOf(p2)).toEqual([true]);
    await ctx.close();
  });
});

// ── r10c 第 1 輪覆核修正（M1–M3、S1、S2、S6、S9）
test.describe('r10c 覆核修正', () => {
  test('F-M1 暫停中切回前景不會重新開啟螢幕常亮；繼續後才開', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    await page.addInitScript(() => {
      const w = window as any; w.__wl = 0;
      Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => {
        w.__wl++; const s = new EventTarget() as any; s.release = async () => { s.dispatchEvent(new Event('release')); }; return s; } } });
    });
    await installScriptedWorker(page, { segments: SEGS, rules: [{ segIdx: 1, delay: 1500 }] });
    await page.goto(BASE_URL);
    await page.locator('.model-btn[data-model="Xenova/whisper-base"]').click();
    await setToggles(page, [], ['tog_vad', 'tog_uvr', 'tog_diarization', 'tog_hallucination']);
    await page.locator('#fileInput').setInputFiles({ name: 'wl.wav', mimeType: 'audio/wav', buffer: wav(100) });
    await page.locator('#startBtn').click();
    await page.waitForFunction(() => (window as any).__workerLog.some((x: any) => x.type === 'RUN_CHUNK' && x.segIdx === 1));
    const pb = page.locator('#pauseBtn');
    await pb.click();
    await expect(pb).toHaveText('▶ 繼續辨識', { timeout: 10_000 });
    const before = await page.evaluate(() => (window as any).__wl);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as any).__wl)).toBe(before);   // 暫停中不重開
    await pb.click();
    await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 60_000 });
    expect(await page.evaluate(() => (window as any).__wl)).toBeGreaterThan(before);   // 繼續後有重開
    await ctx.close();
  });

  test('F-M2 試用時 CPU 那段逾時 → 不記成「CPU 比較快」，留在顯示卡', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    await page.addInitScript(() => { if (!(navigator as any).gpu) Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: async () => ({}) }, configurable: true }); });
    const st = (ms: number) => ({ ms, audioSec: 30, enc: 1, dec: 100, newTokens: 98, loop: null, mode: 'fast', retried: false, flagged: false });
    await installScriptedWorker(page, { segments: SEGS, backend: 'webgpu', rules: [
      { segIdx: 0, stats: st(20000) }, { segIdx: 1, stats: st(6000) },
      { segIdx: 2, attempt: 0, silent: true }, { segIdx: 2, attempt: 1, stats: st(3000) }, { segIdx: 3, stats: st(5000) }] });
    await exposeInternals(page, [], 'new');
    await page.goto(BASE_URL);
    await page.waitForFunction(() => !!(window as any).__t);
    await page.evaluate(() => (window as any).__t.evalIn('CHUNK_TIMEOUT_MS = 800'));
    await page.locator('.model-btn[data-model="Xenova/whisper-base"]').click();
    await setToggles(page, [], ['tog_vad', 'tog_uvr', 'tog_diarization', 'tog_hallucination']);
    await page.locator('#fileInput').setInputFiles({ name: 'g.wav', mimeType: 'audio/wav', buffer: wav(100) });
    await page.locator('#startBtn').click();
    await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 60_000 });
    const log = await page.locator('#logBox').innerText();
    expect(log).not.toContain('用 CPU 比較快');
    expect(log).toContain('CPU 太慢');
    const pick = await page.evaluate(() => JSON.parse(localStorage.getItem('whisper-backend-pick') || '{}')['Xenova/whisper-base']);
    expect(pick.pick).toBe('webgpu');
    expectComplete(await downloadText(page));
    await ctx.close();
  });

  test('F-M3/S1/S2 醫學英文名詞不算字速太快；結尾短句、停頓後開講不標；⚠ 不影響判斷', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await openWithHook(ctx, ['detectHallucinations', 'speechUnits'], 'new');
    const r = await page.evaluate(() => {
      const T = (window as any).__t;
      const codes = (subs: any[]) => T.detectHallucinations(subs).map((s: any) => (s._halluReasons || []).map((x: any) => x.code).join(','));
      return {
        units: [T.speechUnits('Mycobacterium tuberculosis'), T.speechUnits('IgG、IgM 跟 IgA'), T.speechUnits('好，有沒有問題？')],
        med: codes([{ start: 0, end: 1.8, text: 'Mycobacterium tuberculosis' }, { start: 2, end: 3.5, text: 'Staphylococcus aureus 的 coagulase' }, { start: 3.6, end: 4, text: '補體補體補體補體補體' }]),
        tail: codes([{ start: 0, end: 3, text: '今天的課就到這裡' }, { start: 10, end: 12, text: '我們休息十分鐘。' }]),
        resume: codes([{ start: 0, end: 3, text: '先講到這裡' }, { start: 10, end: 13, text: '接下來看 T cell 的活化' }, { start: 20, end: 22, text: '然後抗原呈現' }]),
        warn: codes([{ start: 0, end: 2, text: '⚠ 〔音樂〕' }]),
      };
    });
    expect(r.units).toEqual([2, 4, 6]);
    expect(r.med).toEqual(['', '', 'speed']);
    expect(r.tail).toEqual(['', '']);
    expect(r.resume).toEqual(['', '', '']);
    expect(r.warn).toEqual(['bracket']);
    await ctx.close();
  });

  test('F-S9 開關名稱不重複 ⚠', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    await page.goto(BASE_URL);
    const html = await page.content();
    expect(html).toContain('匯出時在可疑字幕前加 ⚠（進階）');
    expect(html).not.toContain('⚠ 匯出時在可疑字幕前加');
    await ctx.close();
  });
});
