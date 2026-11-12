// One AI image on flat green -> transparent PNG (green-difference key, keeps dark parts solid).
// Usage: node builder/make-image.mjs <out.png> "<prompt>" [aspect]
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const env = Object.fromEntries(fs.readFileSync(process.env.FX_ENV || new URL('../../.env', import.meta.url), 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const [out, prompt, aspect] = process.argv.slice(2);
const full = `${prompt} Isolated on a perfectly flat, uniform pure chroma-key green (#00FF00) background, no shadow, no floor, no text. The object must not contain any green.`;
const j = await (await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: env.FX_IMAGE_MODEL || 'google/gemini-3-pro-image', modalities: ['image', 'text'], image_config: { aspect_ratio: aspect || '1:1' }, messages: [{ role: 'user', content: full }] }) })).json();
const url = j?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
if (!url) { console.error(JSON.stringify(j).slice(0, 400)); process.exit(1); }
const raw = out.replace(/\.png$/, '.raw.png'); fs.writeFileSync(raw, Buffer.from(url.split(',')[1], 'base64'));
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-vf', "format=rgba,geq=r='r(X,Y)':g='min(g(X,Y),max(r(X,Y),b(X,Y))+8)':b='b(X,Y)':a='clip(255-(g(X,Y)-max(r(X,Y),b(X,Y))-28)*5,0,255)'", '-frames:v', '1', out]);
console.log('saved', out, 'cost', j.usage?.cost);
