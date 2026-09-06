import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT, loadConfig } from './config';
import { settingsRouter } from './routes/settings';
import { projectsRouter } from './routes/projects';
import { projectRouter } from './routes/project';
import { aiRouter } from './routes/ai';

const PORT = Number(process.env.MOGE_PORT ?? 8787);
const WEB_DIST = path.join(ROOT, 'web', 'dist');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16mb' }));

fs.mkdirSync(DATA_DIR, { recursive: true });

app.use('/api/settings', settingsRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/projects', projectRouter);
app.use('/api', aiRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: '未知接口' });
});

// 生产模式：托管前端构建产物
if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(WEB_DIST, 'index.html'));
  });
}

// 统一错误兜底
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[moge] 未处理错误：', err);
  if (!res.headersSent) res.status(500).json({ error: err.message });
});

app.listen(PORT, '127.0.0.1', () => {
  const cfg = loadConfig();
  const mock = cfg.mockMode || cfg.providers.every((p) => !p.apiKey.trim());
  console.log('');
  console.log('  墨阁 · 本地小说创作 agent');
  console.log(`  接口地址  http://127.0.0.1:${PORT}/api`);
  console.log(`  数据目录  ${DATA_DIR}`);
  console.log(`  运行模式  ${mock ? '演示模式（未配置 API Key，内容为本地灌水）' : '真实模型模式'}`);
  console.log('');
});
