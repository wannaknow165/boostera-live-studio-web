// Make an empty-room background from a frame: AI removes the person and fills the room behind.
// Usage: node builder/empty-room.mjs <in.jpg> <out.jpg>
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync(process.env.FX_ENV || new URL('../../.env', import.meta.url), 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const [inp, out] = process.argv.slice(2);
const prompt = 'Remove the person and the microphone completely from this image and show the same room empty, as if the same camera filmed it with nobody there. Keep the exact camera angle, framing, lighting, colors and every object of the room. Where the person was, continue the room naturally (the chair can stay, empty). No people, no text. Same vertical 9:16 framing.';
const j = await (await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: env.FX_IMAGE_MODEL || 'google/gemini-3-pro-image', modalities: ['image', 'text'], image_config: { aspect_ratio: '9:16' }, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(inp).toString('base64')}` } }] }] }) })).json();
const url = j?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
if (!url) { console.error(JSON.stringify(j).slice(0, 400)); process.exit(1); }
fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
console.log('saved', out, 'cost', j.usage?.cost);
