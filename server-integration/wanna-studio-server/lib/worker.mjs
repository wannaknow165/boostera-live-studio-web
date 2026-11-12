// Executes one order: Kling 4.0 edit -> download -> optional transparent version -> preview.
import fs from 'node:fs';
import path from 'node:path';
import { buildPrompt, submitEdit, waitTask } from './kling.mjs';
import { makeTransparent, makePreview } from './media.mjs';

export async function runOrder({ order, store, env, MEDIA, publicUrl }) {
  const t = store.template(order.templateId), a = store.avatar(order.avatarId);
  const save = patch => store.saveOrder({ ...store.order(order.id), ...patch });
  const t0 = Date.now();
  const rel = `results/${order.id}.mp4`, out = path.join(MEDIA, rel);

  if (env.DRY_RUN === '1') {
    // Test mode: no Kling call, the template itself is returned as the "result".
    fs.copyFileSync(path.join(MEDIA, t.file), out);
    const patch = { result: rel };
    if (order.transparent) { await makeTransparent(out, path.join(MEDIA, 'results', `${order.id}.alpha`), { opacity: Number(env.TRANSPARENT_OPACITY || 0.92), prores: env.EXPORT_PRORES !== '0' }); patch.transparent_result = `results/${order.id}.alpha.webm`; patch.transparent_prores = `results/${order.id}.alpha.mov`; }
    save({ ...patch, engine: 'dry-run', status: 'succeeded', finished: new Date().toISOString(), elapsed_s: Math.round((Date.now() - t0) / 1000) });
    return;
  }

  const prompt = (t.prompts?.[order.mode]) || buildPrompt({ mode: order.mode, character: t.character, green: order.transparent });
  const taskId = await submitEdit({ env, videoUrl: publicUrl(t.file), imagePath: path.join(MEDIA, a.file), prompt, resolution: order.resolution });
  save({ engine: 'kling-4.0', klingTaskId: taskId, prompt });
  const task = await waitTask({ env, taskId, onTick: s => save({ klingStatus: s }) });
  const v = task.outputs.find(o => o.type === 'video');
  fs.writeFileSync(out, Buffer.from(await (await fetch(v.url)).arrayBuffer()));
  const units = (task.billing || []).filter(b => b.charge_type === 'unit').reduce((s, b) => s + Number(b.amount), 0);
  store.addCost({ order: order.id, engine: 'kling-4.0', template: t.id, mode: order.mode, resolution: order.resolution, units, cash: (task.billing || []).filter(b => b.charge_type === 'cash').map(b => `${b.amount} ${b.currency}`).join(' '), usage: task.usage, elapsed_s: Math.round((Date.now() - t0) / 1000) });

  const patch = { result: rel, units, usage: task.usage };
  if (order.transparent) {
    const base = path.join(MEDIA, 'results', `${order.id}.alpha`);
    const tr = await makeTransparent(out, base, { opacity: Number(env.TRANSPARENT_OPACITY || 0.92), prores: env.EXPORT_PRORES !== '0' });
    patch.transparent_result = `results/${order.id}.alpha.webm`;
    if (tr.mov) patch.transparent_prores = `results/${order.id}.alpha.mov`;
    if (env.PREVIEW_BACKGROUND) { patch.preview = `results/${order.id}.preview.mp4`; await makePreview(out, tr.vf, env.PREVIEW_BACKGROUND, path.join(MEDIA, patch.preview)); }
  }
  save({ ...patch, status: 'succeeded', finished: new Date().toISOString(), elapsed_s: Math.round((Date.now() - t0) / 1000) });
}
