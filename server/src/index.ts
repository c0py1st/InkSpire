import { DATA_DIR, envFirst, loadConfig } from './config';
import { createApp } from './app';
import { purgeTrash } from './fs-store';

const PORT = Number(envFirst('PORT') ?? 8787);

purgeTrash();

createApp().listen(PORT, '127.0.0.1', () => {
  const cfg = loadConfig();
  const mock = cfg.mockMode || cfg.providers.every((p) => !p.apiKey.trim());
  console.log('');
  console.log('  墨阁 · 本地小说创作 agent');
  console.log(`  接口地址  http://127.0.0.1:${PORT}/api`);
  console.log(`  数据目录  ${DATA_DIR}`);
  console.log(`  运行模式  ${mock ? '演示模式（未配置 API Key，内容为本地灌水）' : '真实模型模式'}`);
  console.log('');
});
