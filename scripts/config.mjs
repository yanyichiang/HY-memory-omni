import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export const root = new URL('../', import.meta.url);
export const stateDir = () => resolve(process.env.HY_HOME || '.hy-memory-omni');
export async function readConfig() {
  const path = resolve(process.env.HY_CONFIG || `${stateDir()}/config.json`);
  let settings;
  try { settings = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Run npm run init first, then edit .hy-memory-omni/config.json.');
    throw new Error('Configuration must be a JSON object.');
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Configuration must be a JSON object.');
  const template = JSON.parse(await readFile(new URL('config.example.json', root), 'utf8'));
  const keys = [...Object.keys(template), 'HY_API_TOKEN', 'HY_LLM_URL', 'HY_LLM_MODEL', 'HY_LLM_KEY', 'HY_EMBED_URL', 'HY_EMBED_MODEL', 'HY_EMBED_KEY'];
  const config = Object.fromEntries(keys.filter(key => process.env[key] || settings[key] || template[key]).map(key => [key, process.env[key] || settings[key] || template[key]]));
  for (const key of [...Object.keys(template), 'HY_API_TOKEN']) {
    if (typeof config[key] !== 'string' || !config[key].trim() || config[key].startsWith('REPLACE_')) throw new Error(`Configure ${key} in ${path} or the environment.`);
  }
  if (config.HY_API_TOKEN.length < 32 || config.HY_API_TOKEN.length > 1024) throw new Error('HY_API_TOKEN must contain 32–1024 characters.');
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(config.HY_OWNER_REF)) throw new Error('HY_OWNER_REF must contain 1–160 letters, digits, underscores or hyphens.');
  if (!/^\d+$/.test(config.HY_EMBED_DIMS) || +config.HY_EMBED_DIMS < 1 || +config.HY_EMBED_DIMS > 65536) throw new Error('HY_EMBED_DIMS must be a positive integer up to 65536.');
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.CF_ACCOUNT_ID)}/ai/v1`;
  return { ...config, HY_LLM_URL: config.HY_LLM_URL || base, HY_LLM_MODEL: config.HY_LLM_MODEL || config.MEMORY_FORMATION_MODEL,
    HY_LLM_KEY: config.HY_LLM_KEY || config.MEMORY_MODEL_TOKEN, HY_EMBED_URL: config.HY_EMBED_URL || base,
    HY_EMBED_MODEL: config.HY_EMBED_MODEL || config.MEMORY_TEXT_EMBEDDING_MODEL, HY_EMBED_KEY: config.HY_EMBED_KEY || config.MEMORY_MODEL_TOKEN };
}
