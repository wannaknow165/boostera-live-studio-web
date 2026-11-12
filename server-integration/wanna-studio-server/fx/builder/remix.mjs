// REMIX: the AI makes the streamer herself transform. A video is generated that STARTS from her real live frame
// (first_frame), following the effect's transformation, so on the live it continues seamlessly from the camera.
// Usage: node builder/remix.mjs <effect dir> <frame.jpg> <out.mp4> [seconds]
import fs from 'node:fs';
import path from 'node:path';
const env = Object.fromEntries(fs.readFileSync(process.env.FX_ENV || new URL('../../.env', import.meta.url), 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const H = { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' };
const [fxDir, frame, out, secs] = process.argv.slice(2);
const fx = JSON.parse(fs.readFileSync(path.join(fxDir, 'effect.json'), 'utf8'));
const log = (...a) => console.log(new Date().toLocaleTimeString('en-GB'), ...a);

// the transformation script: effect.remix.prompt if set, otherwise built from the Gemini description phases
const phases = fx.remix?.phases || fx.phases || [];
const prompt = fx.remix?.prompt || `The person in the image is live-streaming and transforms with cinematic magic, as one continuous shot. ${phases.map(p => `At ${p.t}s: ${p.what.replace(/\bher\b/gi, 'their').replace(/\bshe\b/gi, 'they')}`).join(' ')} Keep the same person's face identity recognizable until the mask/helmet covers it. Smooth, photorealistic, dramatic lighting, vertical framing.`;
log('prompt:', prompt.slice(0, 300));
const body = { model: env.FX_REMIX_MODEL || env.FX_VIDEO_MODEL || 'kwaivgi/kling-v3.0-pro', prompt, duration: Number(secs || fx.remix?.seconds || 10), aspect_ratio: '9:16', resolution: '720p', generate_audio: false,
  frame_images: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(frame).toString('base64')}` }, frame_type: 'first_frame' }] };
const j = await (await fetch('https://openrouter.ai/api/v1/videos', { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
if (!j.id) { console.error('submit failed', JSON.stringify(j).slice(0, 400)); process.exit(1); }
log('submitted', j.id);
let s;
for (;;) {
  await new Promise(r => setTimeout(r, 10000));
  try { s = await (await fetch(`https://openrouter.ai/api/v1/videos/${j.id}`, { headers: H })).json(); } catch (e) { log('poll retry', e.message); continue; }
  if (s.status === 'completed') break;
  if (['failed', 'cancelled', 'expired'].includes(s.status)) { console.error('generation', s.status, s.error); process.exit(1); }
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(await (await fetch(`https://openrouter.ai/api/v1/videos/${j.id}/content?index=0`, { headers: H })).arrayBuffer()));
log('REMIX_DONE', out, 'cost', s.usage?.cost);
