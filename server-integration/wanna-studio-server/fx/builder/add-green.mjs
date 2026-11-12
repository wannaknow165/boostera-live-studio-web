// Turn a Gemini green-screen effect video into a ready effect package.
//   node builder/add-green.mjs <green.mp4> [original.mp4] [--room]
// Name and group come from the green file name: "dragon-stand.mp4" -> id "dragon", standing effect.
// (-sit or no suffix = sitting effect). --room also makes an empty-room background from the original (AI, ~$0.14).
// Tracking (where the head is in each frame) is computed by the panel the first time it loads the effect.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const args = process.argv.slice(2), flags = args.filter(a => a.startsWith('--')), files = args.filter(a => !a.startsWith('--'));
const [green, original] = files;
if (!green) { console.log('usage: node builder/add-green.mjs <green.mp4> [original.mp4] [--room]'); process.exit(1); }
const base = path.basename(green).replace(/\.(mp4|mov|webm)$/i, '').toLowerCase();
const posture = /-stand$/.test(base) ? 'stand' : 'sit';
const id = base.replace(/-(sit|stand)$/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'effect';
// --tag=face|body|full|... : the type folder (effects/<tag>/<id>); default face
const category = (flags.find(f => f.startsWith('--tag='))?.slice(6) || 'face').replace(/[^a-z0-9-]/gi, '').toLowerCase();
const rel = `${category}/${id}`, dir = path.join(ROOT, 'effects', category, id); fs.mkdirSync(path.join(dir, 'green'), { recursive: true });
const ff = a => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a]);
const dur = f => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());

fs.copyFileSync(green, path.join(dir, 'green', 'green-src.mp4'));
if (original) fs.copyFileSync(original, path.join(dir, 'reference.mp4'));

// sample the real green from a corner (Gemini's green is rarely exactly #00FF00)
const px = execFileSync('ffmpeg', ['-v', 'error', '-i', green, '-frames:v', '1', '-vf', 'crop=8:8:4:4,scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
const key = '0x' + [...px.subarray(0, 3)].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
console.log('green key', key);
// "green difference" key: alpha comes from how much green exceeds red/blue, so dark/black parts of the effect
// (armor, makeup, feathers) stay fully solid; green spill on the edges is removed. (chromakey made black see-through)
const dk = `format=rgba,geq=r='r(X,Y)':g='min(g(X,Y),max(r(X,Y),b(X,Y))+8)':b='b(X,Y)':a='clip(255-(g(X,Y)-max(r(X,Y),b(X,Y))-28)*5,0,255)'`;
ff(['-i', green, '-vf', `scale=540:-2,${dk},format=yuva420p`, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30', '-auto-alt-ref', '0', '-g', '24', '-an', path.join(dir, 'green', 'layer.webm')]);

let room = false;
if (flags.includes('--room') && original) {
  ff(['-ss', '0.2', '-i', original, '-frames:v', '1', '-q:v', '2', path.join(dir, 'room-src.jpg')]);
  execFileSync(process.execPath, [path.join(ROOT, 'builder', 'empty-room.mjs'), path.join(dir, 'room-src.jpg'), path.join(dir, 'room.jpg')], { stdio: 'inherit' });
  room = fs.existsSync(path.join(dir, 'room.jpg'));
}

const L = Math.round(dur(green) * 10) / 10;
const fx = {
  id, posture, category, title: id, summary: '',
  duration: L + 0.6,
  requires: posture === 'stand' ? ['frontal', 'face', 'shoulders', 'body'] : ['frontal', 'face', 'eyes', 'shoulders', 'body'],
  assets: [
    // track: reference face if the original exists, otherwise the glowing eyes inside the layer
    { id: 'fxlayer', type: 'layer', file: 'green/layer.webm', track: 'green/track.json', trackFrom: original ? 'reference' : 'layer-eyes' },
    ...(room ? [{ id: 'room', type: 'image', file: 'room.jpg', key: false }] : []),
  ],
  timeline: [
    ...(room ? [{ t: 0, d: L + 0.6, do: 'background', image: 'room', fade: 0.7 }] : []),
    { t: 0.4, d: 0.9, do: 'faceMorph' },
    { t: 0, d: L, do: 'layer', asset: 'fxlayer', scale: 1.1 },
    { t: 1.8, d: 1.0, do: 'vanish' },
    { t: Math.max(2.5, L - 0.9), d: 0.9, do: 'return' },
  ],
};
fs.writeFileSync(path.join(dir, 'effect.json'), JSON.stringify(fx, null, 2));

// register in the panel index
const idxFile = path.join(ROOT, 'effects', 'index.json');
const idx = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, 'utf8').replace(/^﻿/, '')) : [];
const row = { id, dir: rel, title: fx.title, posture, category, duration: fx.duration };
fs.writeFileSync(idxFile, JSON.stringify([row, ...idx.filter(r => r.id !== id)], null, 2));
console.log(`effect ready: effects/${rel}  (${posture === 'stand' ? 'עמידה' : 'ישיבה'}, ${L}s${room ? ', room' : ''}) — open the panel once to build its tracking`);
