// One command for the whole flow.
//
//   node builder/fx.mjs url <tiktok link> [face|body|full]
//       downloads the video, Gemini identifies the effect (sit/stand, what to keep), and writes the
//       exact prompt for Gemini to Downloads (<name>-gemini-prompt.txt) next to <name>-original.mp4.
//
//   node builder/fx.mjs green [green.mp4]
//       takes the green video Gemini made (default: the newest gemini_generated_video_*.mp4 in Downloads),
//       matches it to the last video from "url", and builds the effect: green removal, empty room,
//       timeline, panel button. Open/refresh the panel once to build its tracking.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const DL = path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Downloads');
const INC = path.join(ROOT, 'incoming'); fs.mkdirSync(INC, { recursive: true });
const PENDING = path.join(INC, 'pending.json');
const node = (script, args) => execFileSync(process.execPath, [path.join(ROOT, 'builder', script), ...args], { stdio: 'inherit' });
const [cmd, arg, tagArg] = process.argv.slice(2);

const GENERIC = d => `You are preparing a green-screen EFFECT LAYER from this video, for a live AR engine that will place it on a different person in real time.

Background: replace EVERYTHING that is not an effect with a perfectly flat, uniform pure chroma-key green (#00FF00) in every frame – no shadows, no gradients, no light on the green.

Remove completely: the real person's skin, face, hair, normal clothes and hands; the whole room, furniture, walls and floor; any text, logo or watermark.

Keep exactly in the same place, size and timing:
${(d.phases || []).map(p => `- from ${p.t}s: ${p.what}`).join('\n')}
Elements to keep: ${(d.keep || []).join('; ')}.
Glowing eyes stay as two bright points. Scenes that fill the whole frame (portals, landscapes, armies) may stay full-frame.

${d.green_prompt || ''}

Rules: no green color inside the kept elements; no camera moves, zoom or crop; same vertical 9:16 framing, same length and the same timing as the original, so the layer lines up 1:1 with it.

Output: one MP4 video, high quality.`;

if (cmd === 'remix') {
  // TikTok link -> remix-ready effect in one go (no green step): Gemini writes the transformation for any streamer.
  // arg = TikTok link, or a local video file
  const local = !/^https?:/i.test(arg) && fs.existsSync(arg);
  const id0 = local ? path.basename(arg).replace(/\.\w+$/, '').replace(/[^\w-]+/g, '-').slice(-24) : ((arg.match(/video\/(\d+)/) || [])[1] || String(Date.now()));
  const user = local ? 'file' : ((arg.match(/@([\w.]+)/) || [])[1] || 'tiktok');
  const inDir = path.join(INC, `${user}-${id0}`); fs.mkdirSync(inDir, { recursive: true });
  const orig = path.join(inDir, 'original.mp4');
  if (!fs.existsSync(orig)) { if (local) fs.copyFileSync(arg, orig); else execFileSync('yt-dlp', ['-q', '--no-warnings', '-f', 'best[ext=mp4]/best', '-o', orig, arg], { stdio: 'inherit' }); }
  node('describe.mjs', [orig]);
  const d = JSON.parse(fs.readFileSync(path.join(inDir, 'describe.json'), 'utf8'));
  const category = tagArg || 'face', id = (d.title_en || user).toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || user;
  const dir = path.join(ROOT, 'effects', category, id); fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(orig, path.join(dir, 'reference.mp4'));
  const fxJson = { id, posture: d.posture === 'stand' ? 'stand' : 'sit', category, title: d.title, summary: d.summary, duration: 10,
    requires: ['frontal', 'face', 'shoulders', 'body'], returnColor: d.return_color || '#ffd27a', phases: d.phases,
    remix: { seconds: 10, prompt: d.remix_prompt }, assets: [], timeline: [] };
  fs.writeFileSync(path.join(dir, 'effect.json'), JSON.stringify(fxJson, null, 2));
  const idxF = path.join(ROOT, 'effects', 'index.json'), idx = JSON.parse(fs.readFileSync(idxF, 'utf8'));
  fs.writeFileSync(idxF, JSON.stringify([{ id, dir: `${category}/${id}`, title: d.title, posture: fxJson.posture, category, duration: 10 }, ...idx.filter(r => r.id !== id)], null, 2));
  console.log(`\n✔ "${d.title}" ready for remix (${fxJson.posture === 'stand' ? 'עמידה' : 'ישיבה'}) in effects/${category}/${id}.\n  Refresh the panel, type the streamer's name, press "הכן רמיקס".`);
} else if (cmd === 'url') {
  const id = (arg.match(/video\/(\d+)/) || [])[1] || String(Date.now());
  const user = (arg.match(/@([\w.]+)/) || [])[1] || 'tiktok';
  const dir = path.join(INC, `${user}-${id}`); fs.mkdirSync(dir, { recursive: true });
  const orig = path.join(dir, 'original.mp4');
  if (!fs.existsSync(orig)) execFileSync('yt-dlp', ['-q', '--no-warnings', '-f', 'best[ext=mp4]/best', '-o', orig, arg], { stdio: 'inherit' });
  node('describe.mjs', [orig]);
  const d = JSON.parse(fs.readFileSync(path.join(dir, 'describe.json'), 'utf8'));
  const slug = (d.title_en || d.keep?.[0] || user).toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24).replace(/^-|-$/g, '') || user;
  const name = `${slug}-${id.slice(-5)}`;
  fs.writeFileSync(path.join(DL, `${name}-gemini-prompt.txt`), GENERIC(d));
  fs.copyFileSync(orig, path.join(DL, `${name}-original.mp4`));
  fs.writeFileSync(PENDING, JSON.stringify({ dir, name, posture: d.posture, category: tagArg || d.category || 'face', title: d.title, summary: d.summary, at: Date.now() }, null, 2));
  console.log(`\n✔ ${d.title} (${d.posture === 'stand' ? 'עמידה' : 'ישיבה'}, ${tagArg || d.category})\n  Downloads: ${name}-original.mp4 + ${name}-gemini-prompt.txt\n  Upload both to Gemini, then run: node builder/fx.mjs green`);
} else if (cmd === 'green') {
  const p = JSON.parse(fs.readFileSync(PENDING, 'utf8'));
  const green = arg || fs.readdirSync(DL).filter(f => /^gemini_generated_video_.*\.mp4$/i.test(f)).map(f => path.join(DL, f)).filter(f => fs.statSync(f).mtimeMs > p.at).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!green) { console.log('No new gemini_generated_video_*.mp4 in Downloads since the last "url". Pass the file path.'); process.exit(1); }
  const named = path.join(p.dir, `${p.name.replace(/-\d+$/, '')}-${p.posture}.mp4`); fs.copyFileSync(green, named);
  node('add-green.mjs', [named, path.join(p.dir, 'original.mp4'), `--tag=${p.category}`]);
  const id = path.basename(named, '.mp4').replace(/-(sit|stand)$/, '').replace(/[^a-z0-9-]+/g, '-');
  const eDir = path.join(ROOT, 'effects', p.category, id), ej = path.join(eDir, 'effect.json');
  // empty room from a wide frame of the original (35% in: usually after the opening close-up)
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(p.dir, 'original.mp4')]).toString());
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(dur * 0.35), '-i', path.join(p.dir, 'original.mp4'), '-frames:v', '1', '-q:v', '2', path.join(eDir, 'room-src.jpg')]);
  node('empty-room.mjs', [path.join(eDir, 'room-src.jpg'), path.join(eDir, 'room.jpg')]);
  const fx = JSON.parse(fs.readFileSync(ej, 'utf8'));
  fx.title = p.title || fx.title; fx.summary = p.summary || '';
  const L = fx.timeline.find(s => s.do === 'layer').d;
  fx.assets = fx.assets.map(a => a.type === 'layer' ? { ...a, afterTrack: 'hold' } : a);
  if (fs.existsSync(path.join(eDir, 'room.jpg'))) { fx.assets.push({ id: 'room', type: 'image', file: 'room.jpg', key: false }); fx.timeline.unshift({ t: 0, d: fx.duration, do: 'background', image: 'room', fade: 0.8 }); }
  fs.writeFileSync(ej, JSON.stringify(fx, null, 2));
  const idxF = path.join(ROOT, 'effects', 'index.json'), idx = JSON.parse(fs.readFileSync(idxF, 'utf8')); const r = idx.find(x => x.id === fx.id); if (r) r.title = fx.title; fs.writeFileSync(idxF, JSON.stringify(idx, null, 2));
  console.log(`\n✔ effect "${fx.title}" ready in effects/${p.category}/${id} (${L}s). Refresh the panel.`);
} else console.log('usage:\n  node builder/fx.mjs remix <tiktok link> [face|body|full]   (recommended)\n  node builder/fx.mjs url <tiktok link> [face|body|full]\n  node builder/fx.mjs green [green.mp4]');
