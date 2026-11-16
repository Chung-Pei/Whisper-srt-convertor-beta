// tests/round21-r10c.spec.ts — r10c 暫停／繼續、幻覺偵測併入待確認、顯示卡自動試用
//   P-01  暫停 → 目前這段做完才停、存斷點、顯示「已暫停」；繼續 → 不重載模型，字幕完整不重不漏
//   P-02  暫停中關掉網頁 → 重開出現「恢復任務」→ 選同一檔案從斷點接續，字幕完整不重不漏
import { test, expect, type Page } from '@playwright/test';
import { newCtx, installScriptedWorker, BASE_URL, type Seg } from './harness';
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
