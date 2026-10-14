import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT, envFirst } from './config';
import { hostGuard } from './host-guard';
import { settingsRouter } from './routes/settings';
import { projectsRouter } from './routes/projects';
import { projectRouter } from './routes/project';
import { aiRouter } from './routes/ai';

/**
 * 组装 Express app（不监听）。桌面打包与 HTTP 路由测试共用同一棵树，
 * 保证"测的就是跑的"。启动副作用（建目录/清回收站/listen）留给入口。
 */
export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // DNS rebinding 防线：只接受指向本机的 Host（API 与静态托管同口径）
  app.use(hostGuard(Number(envFirst('PORT') ?? 8787)));
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
  const webDistEnv = envFirst('WEB_DIST');
  const WEB_DIST = webDistEnv ? path.resolve(webDistEnv) : path.join(ROOT, 'web', 'dist');
  if (fs.existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(WEB_DIST, 'index.html'));
    });
  }

  // 统一错误兜底：透传 error 自带的状态码（body-parser 的 malformed JSON=400、超限=413 等），无则 500
  app.use((err: Error & { status?: number; statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const st = err.status ?? err.statusCode;
    if (!st || st >= 500) console.error('[moge] 未处理错误：', err);
    if (!res.headersSent) res.status(st ?? 500).json({ error: err.message });
  });

  return app;
}
