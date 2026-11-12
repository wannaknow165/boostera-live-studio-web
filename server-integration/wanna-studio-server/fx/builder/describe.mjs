// Gemini watches a reference transformation video and returns how to turn it into a live effect:
// title, category (face/body/full), posture (sit/stand), phases with times, and a tailored green-layer prompt.
// Usage: node builder/describe.mjs <video.mp4>   -> writes describe.json next to the video
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const env = Object.fromEntries(fs.readFileSync(process.env.FX_ENV || new URL('../../.env', import.meta.url), 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const video = process.argv[2], out = path.join(path.dirname(video), 'describe.json'), small = path.join(path.dirname(video), 'small.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', video, '-vf', 'scale=360:-2', '-an', '-c:v', 'libx264', '-crf', '30', small]);
const prompt = `This TikTok video shows a creator transforming with AI effects. We will rebuild it as a LIVE AR effect that runs on any streamer's camera: the engine tracks her face (478 points incl. eyes), skeleton and body mask, can swap the background and make her vanish/reappear, and overlays a green-screen effect layer aligned to the original.
Watch it and return ONLY JSON:
{
 "title": short Hebrew name,
 "title_en": 1-3 English words for a file name (e.g. "anubis", "raven witch"),
 "summary": one Hebrew sentence of what happens,
 "category": "face" (effect lives on the face/head), "body" (costume on the body), or "full" (she fully turns into something / leaves the scene),
 "posture": "sit" or "stand" (the posture the streamer must be in when it STARTS),
 "phases": [{"t": start seconds, "what": short English description}],
 "keep": [list of every effect element to keep in the green layer],
 "background": short English description of the new room/scene if the background changes, else null,
 "remix_prompt": an English prompt for an image-to-video AI whose FIRST FRAME is a photo of a different streamer sitting/standing at home looking at the camera. Write it so THAT person goes through this same transformation in one continuous ~10 s shot, with the same visual elements, colours, order and drama as this video (describe the elements concretely). Start with "The person in the image is live-streaming at home and". Say to keep the person recognizable until a mask/helmet/transformation covers the face. End with lighting style, "vertical framing". No names, no text overlays,
 "return_color": a hex colour that matches the effect's main light (for the flash when the streamer comes back),
 "green_prompt": a complete English instruction for a video-editing AI to turn THIS video into a green-screen effect layer: remove the real person (skin, hair, normal clothes) and the whole background, replace with flat pure #00FF00, keep exactly the listed effect elements in the same place/size/timing, keep glowing eyes as two bright points, no green in the elements, same length, framing and timing (no camera changes). Be specific to this video.
}`;
const body = { model: env.FX_ANALYZE_MODEL || 'google/gemini-4-argon', response_format: { type: 'json_object' }, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'video_url', video_url: { url: `data:video/mp4;base64,${fs.readFileSync(small).toString('base64')}` } }] }] };
const j = await (await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const text = j?.choices?.[0]?.message?.content; if (!text) { console.error(JSON.stringify(j).slice(0, 500)); process.exit(1); }
const d = JSON.parse(text.replace(/^```json\s*|```\s*$/g, '')); d.cost = j.usage?.cost; fs.writeFileSync(out, JSON.stringify(d, null, 2)); fs.unlinkSync(small);
console.log(JSON.stringify(d, null, 2));
