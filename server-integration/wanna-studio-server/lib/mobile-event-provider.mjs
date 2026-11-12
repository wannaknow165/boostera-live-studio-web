import fs from 'node:fs';
import path from 'node:path';
import {createTikToolsConnection} from './tiktools-connection.mjs';

// Private local configuration. Public responses contain capability flags only.
export function eventProvider(root, env = {}, factory) {
  const file = path.join(root, 'data', 'live-event-provider.json');
  let saved = {};
  if (fs.existsSync(file)) saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const key = () => saved.apiKey || env.TIKTOOLS_API_KEY || '';
  const selected = () => saved.provider || (key() ? 'tiktools' : 'direct');
  return {
    info: () => ({provider: selected(), tiktoolsConfigured: Boolean(key()),
      directSigningConfigured: Boolean(env.SIGN_API_KEY || env.EULER_API_KEY)}),
    save(input) {
      if (!['direct', 'tiktools'].includes(input.provider) || input.apiKey !== undefined &&
          (typeof input.apiKey !== 'string' || input.apiKey.length > 4096 || /\s|[\x00-\x1f\x7f]/.test(input.apiKey))) {
        throw Object.assign(Error('INVALID_EVENT_PROVIDER'), {status: 400});
      }
      saved = {...saved, provider: input.provider, ...(input.apiKey !== undefined ? {apiKey: input.apiKey} : {})};
      fs.writeFileSync(file + '.tmp', JSON.stringify(saved), {mode: 0o600});
      fs.renameSync(file + '.tmp', file);
      return this.info();
    },
    async create(handle, options) {
      if (factory) return factory(handle, options);
      if (selected() === 'tiktools') {
        if (!key()) throw Object.assign(Error('TIKTOOLS_KEY_REQUIRED'), {code: 'TIKTOOLS_KEY_REQUIRED'});
        return createTikToolsConnection(handle, {apiKey: key()});
      }
      const {TikTokLiveConnection} = await import('tiktok-live-connector');
      return new TikTokLiveConnection(handle, options);
    },
  };
}
