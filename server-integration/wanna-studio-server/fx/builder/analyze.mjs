// Turn a reference transformation video into an effect package automatically:
//   video -> Gemini (video understanding) -> effect.json (timeline in the engine's vocabulary + asset prompts) -> reference frames.
// Then run make-assets.mjs to produce the assets. Built for batches: point it at a folder of videos.
// Usage: node builder/analyze.mjs <video.mp4 | folder> [--assets]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const ENV_FILE = process.env.FX_ENV || new URL('../../.env', import.meta.url);
const env = Object.fromEntries(fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const H = { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' };
const MODEL = env.FX_ANALYZE_MODEL || 'google/gemini-4-argon';
const [target, flag] = process.argv.slice(2);
const log = (...a) => console.log(new Date().toLocaleTimeString('en-GB'), ...a);

const VOCAB = `You design LIVE AR effects for a real-time engine that runs on a TikTok streamer's own camera.
The engine knows the streamer's face (478 landmarks incl. irises), the upper-body skeleton (shoulders, elbows, hands, hips), a body segmentation mask, and keeps a clean background plate (so it can make the streamer disappear). There is always exactly one person.
Timeline step types ("do"):
- "attach": an image asset anchored to the streamer. fields: asset, anchor ("head" = on top of the head, "eyes" = across the eyes, "face" = over the face, "chin", "chest", "shoulders", "shoulderL", "shoulderR", "elbowL", "elbowR", "handL", "handR" = held in / on the hand, "waist"), scale (width in face-widths, hat≈2.2, glasses≈1.1), offsetUp (face-widths above anchor), pivotY (0..1, point of the image that sits on the anchor, hat≈0.86), enter ("drop"|"fade"|"pop").
- "eyesGlow": glowing irises. fields: color, size (≈0.1).
- "bodyTexture": an image texture painted on the body mask (clothes/fur/feathers/armor/scales). fields: texture (asset id), reveal ("bottomUp"|"fade"), opacity, keepFace (true).
- "bodyTint": colour wash on the body. fields: color, opacity.
- "sparkle": particles around the head. fields: color.
- "flash": bright burst at the body centre. fields: color.
- "vanish": the streamer fades out and the clean background shows (use when she turns into something / disappears).
- "clip": a transparent video asset played at the body position (e.g. the creature she becomes flying away). fields: asset, anchor ("body"|"screen"), scale (in body heights), freezeAnchor (true).
- "return": the streamer fades back in and all attached layers are removed.
Every step has t (start seconds) and d (duration seconds).
Assets: "image" (single object on green, or a texture with "key": false) and "clip" (5 s animated object on green, made by image-to-video: give "keyframe" description and "motion" description).
Rules: keep the total under 12 s, end with "return" unless the effect is a permanent costume; at most 3 image assets and 1 clip; describe assets so they match the reference video exactly (colours, materials, emblems); never describe the real person's face.`;

async function analyze(video, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(video, path.join(outDir, 'reference.mp4'));
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]).toString());
  // reference frames every ~1 s for the asset prompts
  const frames = [];
  for (let t = 0.5; t < dur; t += Math.max(1, dur / 10)) { const f = `ref_${t.toFixed(1)}.jpg`; execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', video, '-frames:v', '1', '-vf', 'scale=480:-2', path.join(outDir, f)]); frames.push(f); }
  const small = path.join(outDir, 'reference.small.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', video, '-vf', 'scale=360:-2', '-an', '-c:v', 'libx264', '-crf', '30', small]);
  const prompt = `${VOCAB}\n\nWatch this reference video (a creator transforms on her stream). Reproduce the same transformation as a LIVE effect for any streamer.\nReference frames available for asset "refs": ${frames.join(', ')} (frame name = time in seconds).\nReturn ONLY JSON: {"id": kebab-case, "title": short Hebrew title, "summary": one Hebrew sentence, "duration": seconds, "requires": body parts that must be visible before it can start (subset of "face","eyes","shoulders","hands","handL","handR","waist","body"; half-body effects need "shoulders"), "assets": [...], "timeline": [...]}. Each asset: {"id","type","file" (id.png or id.webm),"refs":[1-2 frame names],"prompt" or "keyframe"+"motion","key"?,"aspect"?}.`;
  const body = { model: MODEL, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'video_url', video_url: { url: `data:video/mp4;base64,${fs.readFileSync(small).toString('base64')}` } }] }] };
  const j = await (await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
  const text = j?.choices?.[0]?.message?.content;
  if (!text) throw new Error('analyze failed: ' + JSON.stringify(j).slice(0, 400));
  const fx = JSON.parse(text.replace(/^```json|```$/g, ''));
  fx.reference = 'reference.mp4'; fx.analyzedBy = MODEL; fx.analyzeCost = j.usage?.cost;
  fs.writeFileSync(path.join(outDir, 'effect.json'), JSON.stringify(fx, null, 2));
  fs.unlinkSync(small);
  log('analyzed', path.basename(video), '->', fx.id, `${fx.timeline?.length} steps, ${fx.assets?.length} assets`, 'cost', j.usage?.cost);
  return outDir;
}

const videos = fs.statSync(target).isDirectory() ? fs.readdirSync(target).filter(f => /\.(mp4|mov)$/i.test(f)).map(f => path.join(target, f)) : [target];
for (const v of videos) {
  const name = path.basename(v).replace(/\.(mp4|mov)$/i, '').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  const outDir = path.join(ROOT, 'effects', name);
  if (fs.existsSync(path.join(outDir, 'effect.json'))) { log('skip (exists)', name); continue; }
  try {
    await analyze(v, outDir);
    if (flag === '--assets') execFileSync(process.execPath, [path.join(ROOT, 'builder', 'make-assets.mjs'), outDir], { stdio: 'inherit' });
  } catch (e) { log('FAILED', name, e.message); }
}
// gallery index for the panel
const list = fs.readdirSync(path.join(ROOT, 'effects')).filter(d => fs.existsSync(path.join(ROOT, 'effects', d, 'effect.json'))).map(d => { const e = JSON.parse(fs.readFileSync(path.join(ROOT, 'effects', d, 'effect.json'), 'utf8')); return { id: e.id, dir: d, title: e.title, summary: e.summary || '', duration: e.duration }; });
fs.writeFileSync(path.join(ROOT, 'effects', 'index.json'), JSON.stringify(list, null, 2));
log('effects index:', list.length);
