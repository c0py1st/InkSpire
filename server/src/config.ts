import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppConfig, defaultConfig, PROVIDER_PRESETS } from '../../shared/src/types';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA_DIR = process.env.MOGE_DATA_DIR
  ? path.resolve(process.env.MOGE_DATA_DIR)
  : path.join(ROOT, 'data');
const CONFIG_PATH = path.join(DATA_DIR, '.config.json');

export { ROOT, DATA_DIR };

function writeJsonAtomic(file: string, obj: unknown): void {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 首次启动时预置一个空的 DeepSeek 配置档，用户填 Key 即可 */
function initialConfig(): AppConfig {
  return {
    providers: [
      {
        id: 'deepseek-default',
        name: `${PROVIDER_PRESETS[0].label} / ${PROVIDER_PRESETS[0].model}`,
        baseURL: PROVIDER_PRESETS[0].baseURL,
        apiKey: '',
        model: PROVIDER_PRESETS[0].model,
        temperature: 1.2,
        maxTokens: 8192,
        contextWindow: 131072,
      },
    ],
    creativeId: 'deepseek-default',
    assistId: null,
    mockMode: false,
  };
}

export function loadConfig(): AppConfig {
  try {
    if (!fs.existsSync(CONFIG_PATH)) throw new Error('no config');
    const cfg = { ...defaultConfig(), ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } as AppConfig;
    return cfg;
  } catch {
    const cfg = initialConfig();
    saveConfig(cfg);
    return cfg;
  }
}

export function saveConfig(cfg: AppConfig): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeJsonAtomic(CONFIG_PATH, cfg);
}

/** mock 判定：显式开启演示模式，或当前配置档没有密钥 */
export function isMock(cfg: AppConfig, profile: { apiKey?: string } | null | undefined): boolean {
  return cfg.mockMode || !profile || !profile.apiKey?.trim();
}
