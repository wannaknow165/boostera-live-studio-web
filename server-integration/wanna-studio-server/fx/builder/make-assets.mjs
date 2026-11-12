// Generate the assets for an effect from its effect.json "assets" section.
// image assets: OpenRouter image model on flat green -> chroma key -> PNG with alpha (or plain PNG when key=false)
// clip assets:  keyframe image on green -> OpenRouter video model (image-to-video) -> chroma key -> WebM VP9 alpha
// Usage: node builder/make-assets.mjs effects/raven-witch [assetId ...]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ENV_FILE = process.env.FX_ENV || new URL('../../.env', import.meta.url);
const env = Object.fromEntries(fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const H = { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' };
const [dir, ...only] = process.argv.slice(2);
const fx = JSON.parse(fs.readFileSync(path.join(dir, 'effect.json'), 'utf8'));
const log = (...a) => console.log(new Date().toLocaleTimeString('en-GB'), ...a);
const GREEN = 'Isolated on a perfectly flat, uniform pure chroma-key green (#00FF00) background with no shadow, no floor, no gradient. The object must not contain any green.';

async function image(prompt, refs, aspect) {
  const content = [{ type: 'text', text: prompt }, ...refs.map(r => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(path.join(dir, r)).toString('base64')}` } }))];
  const j = await (await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify({ model: env.FX_IMAGE_MODEL || 'google/gemini-3-pro-image', modalities: ['image', 'text'], image_config: { aspect_ratio: aspect || '1:1' }, messages: [{ role: 'user', content }] }) })).json();
  const url = j?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url) throw new Error('image failed: ' + JSON.stringify(j).slice(0, 400));
  return { buf: Buffer.from(url.split(',')[1], 'base64'), cost: j.usage?.cost };
}

function keyPng(src, dst) {
  // chroma key + despill, trim transparent borders
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', 'chromakey=0x00FF00:0.16:0.08,despill=type=green:mix=0.7:expand=0.2,format=rgba', '-frames:v', '1', dst]);
}

async function clip(a) {
  const kf = path.join(dir, `${a.id}.keyframe.png`);
  if (!fs.existsSync(kf)) { const r = await image(`${a.keyframe} ${GREEN}`, a.refs || [], '9:16'); fs.writeFileSync(kf, r.buf); log(a.id, 'keyframe cost', r.cost); }
  const jpg = kf.replace('.png', '.jpg'); execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', kf, '-q:v', '3', jpg]);
  const body = { model: env.FX_VIDEO_MODEL || 'kwaivgi/kling-v3.0-pro', prompt: `${a.motion} The background stays a perfectly flat uniform pure green (#00FF00) for the whole clip.`, duration: a.duration || 5, aspect_ratio: '9:16', resolution: '720p', generate_audio: false, frame_images: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(jpg).toString('base64')}` }, frame_type: 'first_frame' }] };
  // RESUME_VIDEO_ID: continue polling a job that was already submitted (no second charge)
  const j = process.env.RESUME_VIDEO_ID ? { id: process.env.RESUME_VIDEO_ID } : await (await fetch('https://openrouter.ai/api/v1/videos', { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
  if (!j.id) throw new Error('video submit: ' + JSON.stringify(j).slice(0, 400));
  log(a.id, 'video submitted', j.id);
  let s; for (;;) { await new Promise(r => setTimeout(r, 15000)); try { s = await (await fetch(`https://openrouter.ai/api/v1/videos/${j.id}`, { headers: H })).json(); } catch (e) { log(a.id, 'poll retry', e.message); continue; } if (s.status === 'completed') break; if (['failed', 'cancelled', 'expired'].includes(s.status)) throw new Error('video ' + s.status + ' ' + s.error); }
  const green = path.join(dir, `${a.id}.green.mp4`);
  fs.writeFileSync(green, Buffer.from(await (await fetch(`https://openrouter.ai/api/v1/videos/${j.id}/content?index=0`, { headers: H })).arrayBuffer()));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', green, '-vf', 'scale=540:-2,chromakey=0x00FF00:0.14:0.10,despill=type=green:mix=0.7:expand=0.2,format=yuva420p', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '32', '-auto-alt-ref', '0', '-g', '24', '-an', path.join(dir, a.file)]);
  log(a.id, 'clip done cost', s.usage?.cost);
}

for (const a of fx.assets) {
  if (only.length && !only.includes(a.id)) continue;
  if (fs.existsSync(path.join(dir, a.file))) { log(a.id, 'exists, skip'); continue; }
  if (a.type === 'image') {
    const r = await image(a.key === false ? a.prompt : `${a.prompt} ${GREEN}`, a.refs || [], a.aspect);
    const raw = path.join(dir, `${a.id}.raw.png`); fs.writeFileSync(raw, r.buf);
    if (a.key === false) fs.copyFileSync(raw, path.join(dir, a.file)); else keyPng(raw, path.join(dir, a.file));
    log(a.id, 'image done cost', r.cost);
  } else if (a.type === 'clip') await clip(a);
}
log('ALL_ASSETS_DONE');
