import { useEffect, useState } from 'react';
import type { AppConfig, ProviderProfile } from '../../../shared/src/types';
import { PROVIDER_PRESETS } from '../../../shared/src/types';
import { api } from '../api/client';
import { useStore } from '../state/store';
import { Btn } from './primitives';

const normUrl = (u: string) => u.replace(/\/+$/, '').trim().toLowerCase();
const OTHER = '__other__';

function matchPreset(baseURL: string) {
  return PROVIDER_PRESETS.find((x) => normUrl(x.baseURL) === normUrl(baseURL));
}

/**
 * 设置弹窗：左侧供应商列表 + 右侧详情。
 * 添加配置只在列表追加一项并在右侧展开编辑；角色槽位（创作/辅助）在详情里指定。
 */
export function SettingsModal() {
  const { config, saveConfig, setSettingsOpen, toast } = useStore();
  const [draft, setDraft] = useState<AppConfig | null>(() => (config ? JSON.parse(JSON.stringify(config)) : null));
  const [selectedId, setSelectedId] = useState<string | null>(config?.providers[0]?.id ?? null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState('');

  const selected = draft?.providers.find((p) => p.id === selectedId) ?? draft?.providers[0] ?? null;

  // 选中的配置被删除后，回落到第一项
  useEffect(() => {
    if (draft && !draft.providers.some((p) => p.id === selectedId)) {
      setSelectedId(draft.providers[0]?.id ?? null);
    }
  }, [draft]);

  function patchSelected(patch: Partial<ProviderProfile>) {
    if (!draft || !selected) return;
    setDraft({ ...draft, providers: draft.providers.map((p) => (p.id === selected.id ? { ...p, ...patch } : p)) });
  }

  function addProvider() {
    if (!draft) return;
    const n = draft.providers.filter((p) => p.name.startsWith('新配置')).length;
    const prov: ProviderProfile = {
      id: `prov-${Date.now()}`,
      name: n ? `新配置 ${n + 1}` : '新配置',
      baseURL: '',
      apiKey: '',
      model: '',
      temperature: 1.2,
      maxTokens: 8192,
      contextWindow: 131072,
    };
    setDraft({ ...draft, providers: [...draft.providers, prov] });
    setSelectedId(prov.id);
    setTestResult('');
  }

  function deleteSelected() {
    if (!draft || !selected) return;
    setDraft({
      ...draft,
      providers: draft.providers.filter((p) => p.id !== selected.id),
      creativeId: draft.creativeId === selected.id ? null : draft.creativeId,
      assistId: draft.assistId === selected.id ? null : draft.assistId,
    });
  }

  async function testSelected() {
    if (!selected) return;
    if (!selected.baseURL.trim()) {
      toast('请先填写接口地址 Base URL', 'error');
      return;
    }
    setTesting(true);
    try {
      const res = await api.testProvider(selected);
      setTestResult(res.message);
    } catch (err) {
      setTestResult((err as Error).message);
    } finally {
      setTesting(false);
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

  if (!draft) return null;

  return (
    <div className="modal-mask">
      <div className="modal settings-modal">
        <div className="m-head">
          设置 · 模型接入
          <div style={{ flex: 1 }} />
          <Btn ghost small onClick={() => setSettingsOpen(false)}>关闭</Btn>
        </div>

        <div className="settings-body">
          <aside className="settings-list">
            {draft.providers.map((p) => (
              <div
                key={p.id}
                className={`prov-item${selected?.id === p.id ? ' active' : ''}`}
                onClick={() => { setSelectedId(p.id); setTestResult(''); }}
                title={p.apiKey.trim() ? '已配置密钥' : '未填密钥（该配置将走演示模式）'}
              >
                <span className={`prov-dot ${p.apiKey.trim() ? 'ok' : 'empty'}`} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.name || '未命名配置'}
                </span>
                {draft.creativeId === p.id && <span className="prov-slot">创作</span>}
                {draft.assistId === p.id && <span className="prov-slot">辅助</span>}
              </div>
            ))}
            <button className="prov-add" onClick={addProvider}>＋ 添加配置档</button>
          </aside>

          <section className="settings-detail">
            {selected ? (
              <ProvDetail
                key={selected.id}
                p={selected}
                creativeId={draft.creativeId}
                assistId={draft.assistId}
                testing={testing}
                testResult={testResult}
                onChange={patchSelected}
                onSetCreative={() => setDraft({ ...draft, creativeId: selected.id })}
                onSetAssist={() => setDraft({ ...draft, assistId: draft.assistId === selected.id ? null : selected.id })}
                onDelete={deleteSelected}
                onTest={() => void testSelected()}
              />
            ) : (
              <div style={{ color: 'var(--text-faint)', fontSize: 12.8, paddingTop: 40, textAlign: 'center' }}>
                还没有配置档。点左侧「＋ 添加配置档」开始接入你的模型平台。
              </div>
            )}
          </section>
        </div>

        <div className="m-foot">
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
            <input
              type="checkbox"
              checked={draft.mockMode}
              onChange={(e) => setDraft({ ...draft, mockMode: e.target.checked })}
            />
            强制演示模式
          </label>
          <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
            密钥只保存在本机 data/.config.json；未填密钥的配置走演示模式
          </span>
          <div className="spacer" />
          <Btn onClick={() => setSettingsOpen(false)}>取消</Btn>
          <Btn primary onClick={() => void save()}>保存设置</Btn>
        </div>
      </div>
    </div>
  );
}

function ProvDetail(props: {
  p: ProviderProfile;
  creativeId: string | null;
  assistId: string | null;
  testing: boolean;
  testResult: string;
  onChange: (patch: Partial<ProviderProfile>) => void;
  onSetCreative: () => void;
  onSetAssist: () => void;
  onDelete: () => void;
  onTest: () => void;
}) {
  const { p, testing, testResult } = props;
  const toast = useStore((s) => s.toast);
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const preset = matchPreset(p.baseURL);
  const okResult = testResult.startsWith('连接成功') || testResult.startsWith('演示');

  async function loadModels() {
    if (!p.baseURL.trim()) {
      toast('请先填写接口地址 Base URL', 'error');
      return;
    }
    setLoadingModels(true);
    try {
      const res = await api.listModels(p);
      if (res.ok && res.models.length) {
        setModels(res.models);
      } else {
        toast(res.message || '该平台没有返回模型列表', 'error');
      }
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setLoadingModels(false);
    }
  }

  function onPresetChange(label: string) {
    const x = PROVIDER_PRESETS.find((v) => v.label === label);
    if (x) {
      // 无默认模型的平台清掉残留的模型 ID，避免跨平台误用
      props.onChange({ baseURL: x.baseURL, model: x.model || '' });
      if (!x.model) toast(`已切换到 ${x.label}：请拉取模型列表或手动输入模型 ID`);
    } else {
      // 其他：清空地址由用户填写
      props.onChange({ baseURL: '', model: '' });
      toast('已选择其他平台：请填写接口地址与模型 ID');
    }
  }

  return (
    <div>
      <div className="param-grid two">
        <div className="param">
          <span className="cap">角色槽位（谁是创作 / 辅助模型）</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn small primary={props.creativeId === p.id} onClick={props.onSetCreative} title="写大纲与正文">
              设为创作模型
            </Btn>
            <Btn
              small primary={props.assistId === p.id}
              onClick={props.onSetAssist}
              title="写摘要、探测新设定；再点一次取消，恢复为「同创作模型」"
            >
              设为辅助模型
            </Btn>
          </div>
          <small>未指定辅助模型时沿用创作模型；两个槽位也可以指向不同配置档</small>
        </div>
        <label className="param">
          <span className="cap">配置名称</span>
          <input type="text" value={p.name} onChange={(e) => props.onChange({ name: e.target.value })} />
          <small>会显示在左侧列表</small>
        </label>
      </div>

      <div className="param-grid two">
        <label className="param">
          <span className="cap">预设平台（选择后自动填好地址）</span>
          <select value={preset?.label ?? OTHER} onChange={(e) => onPresetChange(e.target.value)}>
            {PROVIDER_PRESETS.map((x) => (
              <option key={x.label} value={x.label}>{x.label}</option>
            ))}
            <option value={OTHER}>其他（自定义接口）</option>
          </select>
          <small>列表里没有你的平台时选「其他」，地址会清空待你填写</small>
        </label>
        <label className="param">
          <span className="cap">接口地址 Base URL（一般以 /v1 结尾）</span>
          <input
            type="text"
            value={p.baseURL}
            placeholder="例如 https://api.example.com/v1"
            onChange={(e) => props.onChange({ baseURL: e.target.value })}
          />
          <small>{p.baseURL.trim() ? '' : '尚未填写：请手动输入完整接口地址'}</small>
        </label>
      </div>

      <div className="param-grid two">
        <label className="param">
          <span className="cap">模型 ID（可拉取列表选择，或直接输入）</span>
          <div className="model-pick">
            <select
              value={models.includes(p.model) ? p.model : ''}
              onChange={(e) => { if (e.target.value) props.onChange({ model: e.target.value }); }}
              disabled={!models.length}
            >
              {models.length === 0 && <option value="">—— 先点右侧"拉取列表" ——</option>}
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <button className="btn small" disabled={loadingModels} onClick={() => void loadModels()} title="从该平台获取可用模型并填充下拉">
              {loadingModels ? '获取中…' : '拉取列表'}
            </button>
          </div>
          <input
            type="text" value={p.model} placeholder="或手动输入模型 ID"
            onChange={(e) => props.onChange({ model: e.target.value })} style={{ marginTop: 4 }}
          />
        </label>
        <label className="param">
          <span className="cap">API Key（只保存在本机，不会上传）</span>
          <div className="key-wrap">
            <input
              type={showKey ? 'text' : 'password'}
              value={p.apiKey}
              placeholder="sk-……"
              onChange={(e) => props.onChange({ apiKey: e.target.value })}
            />
            <button className="btn small eye" onClick={() => setShowKey((s) => !s)}>{showKey ? '隐藏' : '显示'}</button>
          </div>
          <small>未填 Key 时该配置走演示模式（本地占位内容）</small>
        </label>
      </div>

      <div className="param-grid">
        <label className="param">
          <span className="cap" title="采样温度：控制随机性">温度 temperature</span>
          <input
            type="number" step={0.1} min={0} max={2}
            value={p.temperature ?? ''}
            onChange={(e) => props.onChange({ temperature: e.target.value === '' ? undefined : Number(e.target.value) })}
          />
          <small>0＝严谨稳定，1.3+＝天马行空；写正文常用 0.8~1.3</small>
        </label>
        <label className="param">
          <span className="cap" title="单次回复最多生成多少 token">单次输出上限 max tokens</span>
          <input
            type="number" step={256}
            value={p.maxTokens ?? ''}
            onChange={(e) => props.onChange({ maxTokens: e.target.value === '' ? undefined : Number(e.target.value) })}
          />
          <small>一次最多生成多少字；建议 ≥ 每章目标字数 × 2</small>
        </label>
        <label className="param">
          <span className="cap" title="模型上下文长度，用于估算前情摘要注入预算">上下文窗口 tokens</span>
          <input
            type="number" step={1024}
            value={p.contextWindow ?? ''}
            onChange={(e) => props.onChange({ contextWindow: e.target.value === '' ? undefined : Number(e.target.value) })}
          />
          <small>模型一次能"读进去"多少内容；DeepSeek 通常 131072</small>
        </label>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Btn small disabled={testing} onClick={props.onTest}>{testing ? '测试中…' : '测试连接'}</Btn>
        <span style={{ fontSize: 11.5, color: okResult ? 'var(--ok)' : 'var(--text-dim)' }}>{testResult}</span>
        <div style={{ flex: 1 }} />
        <Btn small ghost danger onClick={props.onDelete}>删除此配置</Btn>
      </div>
    </div>
  );
}
