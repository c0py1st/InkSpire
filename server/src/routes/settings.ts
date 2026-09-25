import { Router } from 'express';
import { AppConfig, ProviderProfile } from '../../../shared/src/types';
import { loadConfig, maskConfig, mergeKeys, saveConfig } from '../config';
import { testProvider } from '../ai/provider';

export const settingsRouter = Router();

/** AbortSignal.timeout 触发的错误名不直观，统一翻译 */
function errMessage(err: unknown): string {
  const e = err as Error;
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return '请求超时（15 秒）：该平台无响应，稍后再试或检查接口地址';
  return e.message;
}

/** 请求体里的密钥留空时回退用存档里同 id 的密钥（界面不再回显明文，测连/拉表要能直接点） */
function effectiveProfile(body: ProviderProfile): ProviderProfile {
  if (body.apiKey && body.apiKey.trim()) return body;
  const saved = loadConfig().providers.find((x) => x.id === body.id);
  return saved ? { ...body, apiKey: saved.apiKey } : body;
}

// 出网一律脱敏：明文密钥不经过任何 HTTP 响应
settingsRouter.get('/', (_req, res) => {
  res.json(maskConfig(loadConfig()));
});

settingsRouter.put('/', (req, res) => {
  const cfg = req.body as AppConfig;
  if (!Array.isArray(cfg.providers)) return res.status(400).json({ error: 'providers 必须是数组' });
  saveConfig(mergeKeys(cfg, loadConfig()));
  res.json({ ok: true });
});

/** 显式清除某个配置档的已存密钥（留空 ≠ 清除，防误删） */
settingsRouter.delete('/key/:id', (req, res) => {
  const cfg = loadConfig();
  const p = cfg.providers.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: '配置档不存在' });
  p.apiKey = '';
  saveConfig(cfg);
  res.json({ ok: true });
});

/** 测试连接：发起一次极小的 chat 请求 */
settingsRouter.post('/test', async (req, res) => {
  const cfg = loadConfig();
  const p = effectiveProfile(req.body as ProviderProfile);
  try {
    const message = await testProvider(cfg, p);
    res.json({ ok: true, message });
  } catch (err) {
    res.status(400).json({ ok: false, message: errMessage(err) });
  }
});

/** 拉取该供应商的模型列表（OpenAI 兼容 GET /models） */
settingsRouter.post('/models', async (req, res) => {
  const p = effectiveProfile(req.body as ProviderProfile);
  try {
    const url = (p.baseURL || '').replace(/\/+$/, '') + '/models';
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${p.apiKey ?? ''}` },
      // 平台无响应时不能让设置页永远转圈
      signal: AbortSignal.timeout(15000),
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
    res.status(400).json({ ok: false, models: [], message: errMessage(err) });
  }
});
