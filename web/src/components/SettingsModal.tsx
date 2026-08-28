import { useEffect, useState } from 'react';
import type { AppConfig, ProviderProfile } from '../../../shared/src/types';
import { PROVIDER_PRESETS } from '../../../shared/src/types';
import { api } from '../api/client';
import { useStore } from '../state/store';
import { Btn } from './primitives';

const normUrl = (u: string) => u.replace(/\/+$/, '').trim().toLowerCase();

function matchPreset(baseURL: string) {
  return PROVIDER_PRESETS.find((x) => normUrl(x.baseURL) === normUrl(baseURL));
}

export function SettingsModal() {
  const { config, saveConfig, setSettingsOpen, toast } = useStore();
  const [draft, setDraft] = useState<AppConfig | null>(config);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  useEffect(() => {
    setDraft(config ? JSON.parse(JSON.stringify(config)) : null);
  }, [config?.providers.length]);

  if (!draft) return null;

  function patchProv(id: string, patch: Partial<ProviderProfile>) {
    setDraft((d) => d && { ...d, providers: d.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  }

  async function test(p: ProviderProfile) {
    setTesting(p.id);
    try {
      const res = await api.testProvider(p);
      setTestResult((r) => ({ ...r, [p.id]: res.message }));
    } catch (err) {
      setTestResult((r) => ({ ...r, [p.id]: (err as Error).message }));
    } finally {
      setTesting(null);
    }
  }

  async function save() {
    if (!draft) return;
    try {
      await saveConfig(draft);
      setSettingsOpen(false);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  return (
    <div className="modal-mask">
      <div className="modal">
        <div className="m-head">
          设置 · 模型接入
          <div style={{ flex: 1 }} />
          <Btn ghost small onClick={() => setSettingsOpen(false)}>关闭</Btn>
        </div>
        <div className="m-body">
          <div className="suggestion" style={{ marginBottom: 16 }}>
            任意 OpenAI 兼容接口都能接入。密钥只保存在本机 <code>data/.config.json</code>。
            未填密钥时应用处于<b className="s-name">演示模式</b>，生成内容为本地占位文字。
          </div>

          <div className="role-slot">
            <div className="role-name">创作模型</div>
            <select
              value={draft.creativeId ?? ''}
              onChange={(e) => setDraft({ ...draft, creativeId: e.target.value || null })}
            >
              <option value="">（未指定）</option>
              {draft.providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name || `${p.baseURL} / ${p.model}`}</option>
              ))}
            </select>
            <span style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>写大纲与正文</span>
          </div>
          <div className="role-slot">
            <div className="role-name">辅助模型</div>
            <select
              value={draft.assistId ?? ''}
              onChange={(e) => setDraft({ ...draft, assistId: e.target.value || null })}
            >
              <option value="">同创作模型</option>
              {draft.providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name || `${p.baseURL} / ${p.model}`}</option>
              ))}
            </select>
            <span style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>写摘要、探测新设定，可用更便宜的</span>
          </div>

          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, margin: '14px 0' }}>
            <input
              type="checkbox"
              checked={draft.mockMode}
              onChange={(e) => setDraft({ ...draft, mockMode: e.target.checked })}
            />
            强制演示模式（不调用任何真实 API）
          </label>

          <div className="hr" />

          {draft.providers.map((p) => (
            <ProvCard
              key={p.id}
              p={p}
              testing={testing === p.id}
              result={testResult[p.id]}
              onChange={(patch) => patchProv(p.id, patch)}
              onDelete={() => setDraft((d) => d && { ...d, providers: d.providers.filter((x) => x.id !== p.id) })}
              onTest={() => void test(p)}
            />
          ))}

          <Btn
            ghost
            onClick={() =>
              setDraft((d) => d && {
                ...d,
                providers: [
                  ...d.providers,
                  {
                    id: `prov-${Date.now()}`,
                    name: '新配置',
                    baseURL: 'https://api.deepseek.com/v1',
                    apiKey: '',
                    model: 'deepseek-v4-flash',
                    temperature: 1.2,
                    maxTokens: 8192,
                    contextWindow: 131072,
                  },
                ],
              })
            }
          >＋ 添加配置档</Btn>
        </div>
        <div className="m-foot">
          <div className="spacer" />
          <Btn onClick={() => setSettingsOpen(false)}>取消</Btn>
          <Btn primary onClick={() => void save()}>保存设置</Btn>
        </div>
      </div>
    </div>
  );
}

function ProvCard(props: {
  p: ProviderProfile;
  testing: boolean;
  result?: string;
  onChange: (patch: Partial<ProviderProfile>) => void;
  onDelete: () => void;
  onTest: () => void;
}) {
  const { p, testing, result, onChange, onDelete, onTest } = props;
  const toast = useStore((s) => s.toast);
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const preset = matchPreset(p.baseURL);
  const okResult = result?.startsWith('连接成功') || result?.startsWith('演示');

  async function loadModels() {
    if (!p.apiKey.trim()) {
      // 未填 Key 时仍尝试，由后端提示；但也提醒
    }
    setLoadingModels(true);
    try {
      const res = await api.listModels(p);
      if (res.ok && res.models.length) {
        setModels(res.models);
        if (!res.models.includes(p.model) && res.models.length === 1) onChange({ model: res.models[0] });
      } else {
        toast(res.message || '该平台没有返回模型列表', 'error');
      }
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setLoadingModels(false);
    }
  }

  return (
    <div className="prov-card">
      <div className="param-grid two">
        <label className="param">
          <span className="cap">配置名称</span>
          <input type="text" value={p.name} onChange={(e) => onChange({ name: e.target.value })} />
        </label>
        <label className="param">
          <span className="cap">预设平台（选择后自动填好地址）</span>
          <select
            value={preset?.label ?? ''}
            onChange={(e) => {
              const x = PROVIDER_PRESETS.find((v) => v.label === e.target.value);
              if (x) onChange({ baseURL: x.baseURL, ...(x.model ? { model: x.model } : {}) });
            }}
          >
            {!preset && <option value="">自定义接口（手动填写的地址）</option>}
            {PROVIDER_PRESETS.map((x) => (
              <option key={x.label} value={x.label}>{x.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="param-grid two">
        <label className="param">
          <span className="cap">接口地址 Base URL（一般以 /v1 结尾）</span>
          <input type="text" value={p.baseURL} onChange={(e) => onChange({ baseURL: e.target.value })} />
        </label>
        <label className="param">
          <span className="cap">模型 ID（可拉取列表选择，或直接输入）</span>
          <div className="model-pick">
            <select
              value={models.includes(p.model) ? p.model : ''}
              onChange={(e) => { if (e.target.value) onChange({ model: e.target.value }); }}
              disabled={!models.length}
            >
              {models.length === 0 && <option value="">—— 先点右侧“拉取列表” ——</option>}
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <button className="btn small" disabled={loadingModels} onClick={() => void loadModels()} title="从该平台获取可用模型并填充下拉">
              {loadingModels ? '获取中…' : '拉取列表'}
            </button>
          </div>
          <input type="text" value={p.model} placeholder="或手动输入模型 ID"
            onChange={(e) => onChange({ model: e.target.value })} style={{ marginTop: 4 }} />
        </label>
      </div>

      <label className="param" style={{ marginBottom: 10 }}>
        <span className="cap">API Key（只保存在本机，不会上传）</span>
        <div className="key-wrap">
          <input
            type={showKey ? 'text' : 'password'}
            value={p.apiKey}
            placeholder="sk-……"
            onChange={(e) => onChange({ apiKey: e.target.value })}
          />
          <button className="btn small eye" onClick={() => setShowKey((s) => !s)}>{showKey ? '隐藏' : '显示'}</button>
        </div>
      </label>

      <div className="param-grid">
        <label className="param">
          <span className="cap" title="采样温度：控制随机性">温度 temperature</span>
          <input
            type="number" step={0.1} min={0} max={2}
            value={p.temperature ?? ''}
            onChange={(e) => onChange({ temperature: e.target.value === '' ? undefined : Number(e.target.value) })}
          />
          <small>0＝严谨稳定，1.3+＝天马行空；写正文常用 0.8~1.3</small>
        </label>
        <label className="param">
          <span className="cap" title="单次回复最多生成多少 token">单次输出上限 max tokens</span>
          <input
            type="number" step={256}
            value={p.maxTokens ?? ''}
            onChange={(e) => onChange({ maxTokens: e.target.value === '' ? undefined : Number(e.target.value) })}
          />
          <small>一次最多生成多少字；建议 ≥ 每章目标字数 × 2</small>
        </label>
        <label className="param">
          <span className="cap" title="模型上下文长度，用于估算前情摘要注入预算">上下文窗口 tokens</span>
          <input
            type="number" step={1024}
            value={p.contextWindow ?? ''}
            onChange={(e) => onChange({ contextWindow: e.target.value === '' ? undefined : Number(e.target.value) })}
          />
          <small>模型一次能"读进去"多少内容；DeepSeek 通常 131072</small>
        </label>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Btn small disabled={testing} onClick={onTest}>{testing ? '测试中…' : '测试连接'}</Btn>
        <span style={{ fontSize: 11.5, color: okResult ? 'var(--ok)' : 'var(--text-dim)' }}>{result ?? ''}</span>
        <div style={{ flex: 1 }} />
        <Btn small ghost danger onClick={onDelete}>删除此配置</Btn>
      </div>
    </div>
  );
}
