import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Settings: process env  >  server.env (plain settings: port, address, title…)  >  .env (secrets: API keys)
export function loadEnv() {
  const env = { ...process.env };
  for (const name of ['server.env', '.env']) {
    const f = path.join(ROOT, name);
    if (fs.existsSync(f)) for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  if (!env.PUBLIC_BASE_URL) env.PUBLIC_BASE_URL = `http://localhost:${env.PORT || 8800}`;
  return env;
}
