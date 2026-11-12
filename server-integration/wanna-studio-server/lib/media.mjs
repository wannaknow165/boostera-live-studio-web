// ffmpeg helpers: template preparation, green-key transparency, live preview.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
const run = promisify(execFile);
const FF = process.env.FFMPEG || 'ffmpeg', FP = process.env.FFPROBE || 'ffprobe';

export async function probe(file) {
  const { stdout } = await run(FP, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file]);
  const j = JSON.parse(stdout); const v = j.streams.find(s => s.codec_type === 'video') || {};
  return { duration: +(+j.format.duration).toFixed(2), width: v.width, height: v.height, hasAudio: j.streams.some(s => s.codec_type === 'audio') };
}

// Kling input rules: 3–30 s, width/height >= 700 px, ratio 2:5..5:2, 24–60 fps.
// Steps: cut to the AI part (trimStart/trimEnd), crop black borders, upscale so the short side >= 720, re-encode.
export async function prepareTemplate(src, dst, { trimStart = 0, trimEnd = 0 } = {}) {
  const info = await probe(src);
  const end = trimEnd > 0 ? Math.min(trimEnd, info.duration) : info.duration;
  const len = Math.max(0, end - trimStart);
  if (len < 3) throw new Error(`template must be at least 3 s after trimming (got ${len.toFixed(1)} s)`);
  if (len > 30) throw new Error(`template must be at most 30 s after trimming (got ${len.toFixed(1)} s) — pass trimStart/trimEnd`);
  // detect black borders
  let crop = '';
  try {
    const { stderr } = await run(FF, ['-hide_banner', '-ss', String(trimStart), '-t', String(Math.min(len, 10)), '-i', src, '-vf', 'cropdetect=24:2:0', '-f', 'null', '-'], { maxBuffer: 64 << 20 });
    const counts = {}; for (const m of stderr.matchAll(/crop=(\d+:\d+:\d+:\d+)/g)) counts[m[1]] = (counts[m[1]] || 0) + 1;
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (best) { const [w, h] = best.split(':').map(Number); if (w < info.width - 8 || h < info.height - 8) crop = `crop=${best},`; }
  } catch { /* no crop */ }
  const scale = "scale='if(lt(iw,ih),max(720,iw),-2)':'if(lt(iw,ih),-2,max(720,ih))':flags=lanczos,scale=trunc(iw/2)*2:trunc(ih/2)*2";
  await run(FF, ['-v', 'error', '-y', '-ss', String(trimStart), '-i', src, '-t', String(len), '-vf', `${crop}${scale},fps=30`, '-c:v', 'libx264', '-crf', '16', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', dst], { maxBuffer: 64 << 20 });
  const out = await probe(dst);
  return { duration: out.duration, width: out.width, height: out.height, cropped: !!crop, trimStart, trimEnd: end };
}

// Green screen -> transparent overlay. Key colour sampled from the frame corners.
export async function makeTransparent(src, base, { opacity = 0.92, prores = true } = {}) {
  const { stdout } = await run(FF, ['-v', 'error', '-ss', '0.5', '-i', src, '-frames:v', '1', '-vf', 'scale=64:64', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 1 << 20 });
  const px = (x, y) => { const o = (y * 64 + x) * 3; return [stdout[o], stdout[o + 1], stdout[o + 2]]; };
  const pts = [[1, 1], [62, 1], [1, 62], [62, 62], [32, 1], [1, 32], [62, 32]].map(([x, y]) => px(x, y)).filter(([r, g, b]) => g > r + 30 && g > b + 30);
  const key = pts.length ? '0x' + [0, 1, 2].map(i => Math.round(pts.reduce((s, p) => s + p[i], 0) / pts.length).toString(16).padStart(2, '0')).join('') : '0x00FF00';
  const vf = `chromakey=${key}:0.13:0.10,despill=type=green:mix=0.6:expand=0.15,format=yuva444p,colorchannelmixer=aa=${opacity}`;
  await run(FF, ['-v', 'error', '-y', '-i', src, '-vf', vf + ',format=yuva420p', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '28', '-row-mt', '1', '-auto-alt-ref', '0', '-c:a', 'libopus', `${base}.webm`], { maxBuffer: 64 << 20 });
  if (prores) await run(FF, ['-v', 'error', '-y', '-i', src, '-vf', vf, '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-c:a', 'pcm_s16le', `${base}.mov`], { maxBuffer: 64 << 20 });
  return { webm: `${base}.webm`, mov: `${base}.mov`, vf };
}

// Composite a transparent result over a background frame (e.g. a live screenshot) for review.
export async function makePreview(src, vf, bgImage, out) {
  const bg = bgImage && fs.existsSync(bgImage) ? ['-loop', '1', '-i', bgImage] : ['-f', 'lavfi', '-i', 'color=c=0x334455:s=1080x1920'];
  await run(FF, ['-v', 'error', '-y', ...bg, '-i', src, '-filter_complex', `[0]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p[b];[1]scale=1080:1920,${vf}[f];[b][f]overlay=shortest=1,format=yuv420p`, '-map', '1:a?', '-c:v', 'libx264', '-crf', '20', '-c:a', 'aac', out], { maxBuffer: 64 << 20 });
  return out;
}
