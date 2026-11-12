// A short shouted voice line -> audio file (OpenRouter openai/gpt-audio).
// Usage: node builder/make-voice.mjs <out.mp3> "<what to say>" "<how to say it>" [voice]
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const env = Object.fromEntries(fs.readFileSync(process.env.FX_ENV || new URL('../../.env', import.meta.url), 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const [out, line, style, voice] = process.argv.slice(2);
const body = { model: 'openai/gpt-audio', modalities: ['text', 'audio'], audio: { voice: voice || 'ash', format: 'pcm16' }, stream: true,
  messages: [{ role: 'system', content: `You are a voice actor. Say ONLY the exact line the user gives, nothing before or after. Delivery: ${style}` }, { role: 'user', content: line }] };
const r = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
if (!r.ok) { console.error(r.status, (await r.text()).slice(0, 400)); process.exit(1); }
// streamed SSE: collect base64 pcm16 chunks (24 kHz mono)
const chunks = []; let buf = '';
for await (const part of r.body) { buf += Buffer.from(part).toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l.startsWith('data:') || l.includes('[DONE]')) continue; try { const a = JSON.parse(l.slice(5)).choices?.[0]?.delta?.audio; if (a?.data) chunks.push(Buffer.from(a.data, 'base64')); } catch {} } }
if (!chunks.length) { console.error('no audio returned'); process.exit(1); }
const pcm = out.replace(/\.\w+$/, '.pcm'); fs.writeFileSync(pcm, Buffer.concat(chunks));
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcm, '-af', 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,loudnorm=I=-12:TP=-1', '-b:a', '160k', out]);
fs.unlinkSync(pcm); console.log('saved', out, execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString().trim() + 's');
