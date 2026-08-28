import { Router } from 'express';
import { AppConfig, ProviderProfile } from '../../../shared/src/types';
import { loadConfig, saveConfig } from '../config';
import { testProvider } from '../ai/provider';

export const settingsRouter = Router();

settingsRouter.get('/', (_req, res) => {
  res.json(loadConfig());
});

settingsRouter.put('/', (req, res) => {
  const cfg = req.body as AppConfig;
  if (!Array.isArray(cfg.providers)) return res.status(400).json({ error: 'providers 必须是数组' });
  saveConfig(cfg);
  res.json({ ok: true });
});

/** 测试连接：发起一次极小的 chat 请求 */
settingsRouter.post('/test', async (req, res) => {
  const cfg = loadConfig();
  const p = req.body as ProviderProfile;
  try {
    const message = await testProvider(cfg, p);
    res.json({ ok: true, message });
  } catch (err) {
    res.status(400).json({ ok: false, message: (err as Error).message });
  }
});

/** 拉取该供应商的模型列表（OpenAI 兼容 GET /models） */
settingsRouter.post('/models', async (req, res) => {
  const p = req.body as ProviderProfile;
  try {
    const url = (p.baseURL || '').replace(/\/+$/, '') + '/models';
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${p.apiKey ?? ''}` },
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      return res.status(400).json({ ok: false, models: [], message: `HTTP ${resp.status}：${t.slice(0, 160)}` });
    }
    const j = (await resp.json()) as { data?: Array<{ id?: string }> };
    const models = (j.data ?? [])
      .map((m) => m.id)
      .filter((x): x is string => Boolean(x))
      .sort();
    res.json({ ok: true, models });
  } catch (err) {
    res.status(400).json({ ok: false, models: [], message: (err as Error).message });
  }
});
