import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { CharacterCard } from '../../../shared/src/types';
import { useStore } from '../state/store';
import { Btn } from './primitives';

export function BibleView() {
  const { bundle, persistCharacters, persistWorldview, toast } = useStore(useShallow((s) => ({
    bundle: s.bundle, persistCharacters: s.persistCharacters, persistWorldview: s.persistWorldview, toast: s.toast,
  })));
  // slug 变化（切换作品）时重置本地编辑态：渲染期间直接比较上一值，避免 effect 级联
  const [lastSlug, setLastSlug] = useState(bundle?.meta.slug);
  const [chars, setChars] = useState<CharacterCard[]>(bundle?.characters ?? []);
  const [worldview, setWorldview] = useState(bundle?.worldview ?? '');
  if (bundle && bundle.meta.slug !== lastSlug) {
    setLastSlug(bundle.meta.slug);
    setChars(bundle.characters);
    setWorldview(bundle.worldview);
  }

  if (!bundle) return null;

  function patchChar(i: number, patch: Partial<CharacterCard>) {
    setChars((cs) => cs.map((c, k) => (k === i ? { ...c, ...patch } : c)));
  }

  async function save() {
    try {
      await persistCharacters(chars);
      await persistWorldview(worldview);
      toast('设定集已保存', 'ok');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  return (
    <div className="center-scroll">
      <div className="pane-pad">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <h2 className="pane-title">设定集</h2>
            <div className="pane-sub">agent 写每一章前都会读这里的人物卡与世界观。改完记得保存。</div>
          </div>
          <Btn primary onClick={() => void save()}>保存设定集</Btn>
        </div>

        {chars.map((c, i) => (
          <div key={c.id} className="vol-block" style={{ padding: 14 }}>
            <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
              <input type="text" style={{ fontWeight: 700, flex: 1 }} value={c.name} placeholder="姓名" onChange={(e) => patchChar(i, { name: e.target.value })} />
              <input type="text" style={{ width: 160 }} value={c.role} placeholder="定位" onChange={(e) => patchChar(i, { role: e.target.value })} />
              <button className="icon-btn danger" title="删除人物卡" onClick={() => setChars((cs) => cs.filter((_, k) => k !== i))}>✕</button>
            </div>
            <div className="field"><label>性格</label><textarea style={{ minHeight: 44 }} value={c.personality} onChange={(e) => patchChar(i, { personality: e.target.value })} /></div>
            <div className="field"><label>背景</label><textarea style={{ minHeight: 44 }} value={c.background} onChange={(e) => patchChar(i, { background: e.target.value })} /></div>
            <div className="field"><label>关系</label><textarea style={{ minHeight: 44 }} value={c.relations} onChange={(e) => patchChar(i, { relations: e.target.value })} /></div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div className="field" style={{ flex: 1, marginBottom: 0 }}><label>说话特点</label><input type="text" value={c.speechHabit ?? ''} onChange={(e) => patchChar(i, { speechHabit: e.target.value })} /></div>
              <div className="field" style={{ flex: 1, marginBottom: 0 }}><label>当前状态</label><input type="text" value={c.state ?? ''} onChange={(e) => patchChar(i, { state: e.target.value })} /></div>
            </div>
          </div>
        ))}

        <Btn ghost onClick={() => setChars((cs) => [...cs, { id: `c-${Date.now()}`, name: '新人物', role: '配角', personality: '', background: '', relations: '' }])}>
          ＋ 加人物卡
        </Btn>

        <div className="hr" />
        <div className="field">
          <label>世界观 / 势力 / 体系（自由文本）</label>
          <textarea style={{ minHeight: 180 }} value={worldview} onChange={(e) => setWorldview(e.target.value)} />
        </div>
        <Btn primary onClick={() => void save()}>保存设定集</Btn>
        <div style={{ height: 60 }} />
      </div>
    </div>
  );
}
