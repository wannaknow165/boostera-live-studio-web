// Kling 4.0 Omni Video — video editing with a reference image.
// Docs: https://kling.ai/document-api/api/video/4-0/video-omni
// POST {HOST}/omni-video/kling-4.0   GET {HOST}/tasks?task_ids=...
// base_video must be a public https URL (this server serves /media publicly); refer_image accepts base64.
// Billing (Kling 4.0, with input video): total seconds = input + output (or output*2), 0.6 units/s @720p, 0.9 units/s @1080p.
import fs from 'node:fs';

export function buildPrompt({ mode, character, green }) {
  const who = character || 'the main character';
  const base = mode === 'add'
    ? `Edit @video_1. Keep ${who} and everything else unchanged, and add the person from @image_1 as a second hero right beside ${who} in every shot where ${who} appears, interacting naturally and dressed in a matching outfit. Preserve the person's face, facial features, hairstyle, skin tone and facial hair from @image_1 so they are clearly recognizable. Same shots, timing, cuts and camera motion.`
    : `Edit @video_1. Replace ${who} with the person from @image_1 in every shot where ${who} appears. Preserve the person's face, facial features, hairstyle, skin tone and facial hair from @image_1 so they are clearly recognizable (if the face is covered in @image_1, keep their hood, cap, glasses and style); they have a normal human head and wear the same outfit, armor and props as ${who}. Keep everything else exactly unchanged: same shots, timing and cuts, camera motion, poses and actions, backgrounds, effects and lighting.`;
  const g = green ? `\nReplace ALL backgrounds and scenery with a perfectly flat, uniform pure chroma-key green (#00FF00) in every frame, with no shadows, gradients or scenery. Keep the characters, outfits, props and all magic effects (fire, sparks, glow, light beams, particles) fully visible in front of the green. Do not tint the characters green.` : '';
  return base + g;
}

export async function submitEdit({ env, videoUrl, imagePath, prompt, resolution = '1080p' }) {
  const host = env.KLING_HOST || 'https://api-singapore.klingai.com';
  const body = {
    contents: [
      { type: 'prompt', text: prompt },
      { type: 'base_video', url: videoUrl, id: 'video_1' },
      { type: 'refer_image', url: fs.readFileSync(imagePath).toString('base64'), id: 'image_1' },
    ],
    settings: { resolution, audio: 'original', aspect_ratio: 'adaptive' },
  };
  const r = await fetch(`${host}/omni-video/kling-4.0`, { method: 'POST', headers: { Authorization: `Bearer ${env.KLING_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`Kling submit failed: ${j.code} ${j.message}`);
  return j.data.id;
}

export async function waitTask({ env, taskId, onTick }) {
  const host = env.KLING_HOST || 'https://api-singapore.klingai.com';
  for (let i = 0; i < 240; i++) { // up to ~60 min
    await new Promise(r => setTimeout(r, 15000));
    const j = await (await fetch(`${host}/tasks?task_ids=${taskId}`, { headers: { Authorization: `Bearer ${env.KLING_API_KEY}` } })).json();
    const t = j.data?.[0]; if (!t) continue;
    onTick?.(t.status);
    if (t.status === 'succeeded') return t;
    if (t.status === 'failed') throw new Error(`Kling task failed: ${t.message || 'unknown'}`);
  }
  throw new Error('Kling task timed out');
}

export async function unitsLeft(env) {
  const host = env.KLING_HOST || 'https://api-singapore.klingai.com';
  const end = Date.now(), start = end - 90 * 86400000;
  const j = await (await fetch(`${host}/account/costs?start_time=${start}&end_time=${end}`, { headers: { Authorization: `Bearer ${env.KLING_API_KEY}` } })).json();
  return (j.data?.resource_pack_subscribe_infos || []).filter(p => p.status === 'online').map(p => ({ name: p.resource_pack_name, remaining: p.remaining_quantity, models: p.resource_pack_applicable_models }));
}
