// tests/manual/verify-prompt-whisper-tiny.mjs — 以真實 Xenova/whisper-tiny（Node、transformers.js 4.3.0）驗證初始提示詞
// 需要網路（下載模型與 jfk.wav），不在 functional 測試內。用法：
//   node tests/manual/verify-prompt-whisper-tiny.mjs
// 驗證：(1) 加了 decoder_input_ids 仍能正常產生逐字時間戳；(2) 提示詞確實影響輸出（全大寫提示 → 輸出變大寫；
//      全小寫無標點提示 → 輸出跟著變小寫無標點）；(3) 輸出不含提示詞原文照抄（stripPromptLeak 未誤刪正常句子）。
import { pipeline, env } from '@huggingface/transformers';
import fs from 'fs';
import path from 'path';
import os from 'os';

const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const grab = (name) => { const a = html.indexOf('function ' + name + '('); const b = html.indexOf('\n}\n', a); if (a < 0 || b < 0) throw new Error('找不到 ' + name); return html.slice(a, b + 2); };
const H = new Function(['composeWhisperPrompt', 'buildPromptDecoderIds', 'stripPromptLeak', 'promptDecoderIdsForPipe'].map(grab).join('\n') +
  '; return { composeWhisperPrompt, buildPromptDecoderIds, stripPromptLeak, promptDecoderIdsForPipe };')();

env.cacheDir = path.join(os.tmpdir(), 'whisper-prompt-verify');
const wavUrl = 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav';
const pipe = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', { dtype: 'fp32' });
// 讀 PCM16 WAV → 單聲道 → 線性重取樣到 16 kHz（驗證用，不追求音質）
const buf = Buffer.from(await (await fetch(wavUrl)).arrayBuffer());
let off = 12, data = null, sr = 16000, ch = 1;
while (off < buf.length) { const id = buf.toString('ascii', off, off + 4), sz = buf.readUInt32LE(off + 4);
  if (id === 'fmt ') { ch = buf.readUInt16LE(off + 10); sr = buf.readUInt32LE(off + 12); }
  if (id === 'data') { data = buf.subarray(off + 8, off + 8 + sz); break; } off += 8 + sz; }
const n = Math.floor(data.length / 2 / ch), mono = new Float32Array(n);
for (let i = 0; i < n; i++) { let v = 0; for (let c = 0; c < ch; c++) v += data.readInt16LE((i * ch + c) * 2); mono[i] = v / ch / 32768; }
const m = Math.floor(n * 16000 / sr), audio = new Float32Array(m);
for (let i = 0; i < m; i++) { const x = i * sr / 16000, k = Math.floor(x), f = x - k; audio[i] = mono[k] * (1 - f) + (mono[Math.min(k + 1, n - 1)] * f); }
const run = async (prompt) => {
  const opts = { language: 'en', task: 'transcribe', return_timestamps: 'word' };
  const info = prompt ? H.promptDecoderIdsForPipe(pipe, prompt, 'en', 'transcribe', 200) : null;
  if (info?.ids) opts.decoder_input_ids = info.ids;
  const r = await pipe(audio, opts);
  const st = prompt ? H.stripPromptLeak(r.chunks, prompt) : { removed: 0 };
  return { used: info?.used ?? 0, text: r.text.trim(), words: r.chunks.length, removed: st.removed };
};
const base = await run(null);
const caps = await run('AND SO MY FELLOW CITIZENS. ALL CAPS.');
const lower = await run('i talk like this no punctuation no capitals just lowercase words');
console.log({ base, caps, lower });
const ok = base.words > 10 && caps.used > 0 && lower.used > 0
  && /AND SO MY FELLOW/.test(caps.text) && !/AND SO MY FELLOW/.test(base.text)      // 全大寫提示 → 輸出變大寫
  && lower.text === lower.text.toLowerCase() && lower.text !== base.text            // 全小寫無標點提示 → 輸出跟著變
  && caps.removed === 0 && lower.removed === 0;                                     // 正常句子沒有被當成照抄而刪掉
console.log(ok ? 'PASS：提示詞有送進模型並影響輸出' : 'FAIL');
process.exit(ok ? 0 : 1);
