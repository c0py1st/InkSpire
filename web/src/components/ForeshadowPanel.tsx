import type { Foreshadow } from '../../../shared/src/types';
import { useStore } from '../state/store';
import { Btn } from './primitives';

/**
 * 伏笔登记表：埋设章 -> 内容 -> 计划回收章 -> 状态。
 * 未回收的伏笔会随前情摘要注入每章生成提示词，一致性检查也读它。
 * 编辑模式与大纲页一致：文本本地即时生效、失焦落盘；下拉/增删即时落盘。
 */
export function ForeshadowPanel() {
  const bundle = useStore((s) => s.bundle);
  const persistForeshadows = useStore((s) => s.persistForeshadows);
  const updateForeshadowsLocal = useStore((s) => s.updateForeshadowsLocal);
  if (!bundle?.outline) return null;

  // 章下拉选项：按大纲顺序的 (id, 标题) 对
  const chapterOptions: Array<{ id: string; label: string }> = [];
  for (const vol of bundle.outline.volumes) {
    for (const c of vol.chapters) chapterOptions.push({ id: c.id, label: `${c.id} ${c.title}` });
  }

  const items = bundle.foreshadows;
  const patchNow = (id: string, p: Partial<Foreshadow>) =>
    void persistForeshadows(items.map((f) => (f.id === id ? { ...f, ...p } : f)));
  const patchLocal = (id: string, p: Partial<Foreshadow>) =>
    updateForeshadowsLocal(items.map((f) => (f.id === id ? { ...f, ...p } : f)));
  const remove = (id: string) => void persistForeshadows(items.filter((f) => f.id !== id));
  const add = () => void persistForeshadows([
    ...items,
    {
      id: `fs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      setupChapterId: chapterOptions[0]?.id ?? '',
      content: '',
      status: 'open',
      createdAt: new Date().toISOString(),
    },
  ]);

  const open = items.filter((f) => f.status === 'open').length;
  return (
    <div className="fs-panel">
      <div className="fs-title">
        伏笔登记表
        <span className="fs-count">{open} 未收 / 共 {items.length} 条</span>
      </div>
      <div className="pane-sub" style={{ marginBottom: 8 }}>
        埋了什么钩子、打算哪一章收，写在这里。agent 写每一章时都会看到「未回收」清单，
        指定本章回收的会作为硬性要求；一致性检查同时盯"该收没收"和"提前剧透"。
      </div>
      {items.length === 0 && (
        <div style={{ color: 'var(--text-faint)', fontSize: 12.5, padding: '4px 0 8px' }}>
          还没有登记。适合记：神秘道具的来历、一句没解释的台词、某个角色的反常举动、反派没交代的底牌。
        </div>
      )}
      {items.map((f) => (
        <div key={f.id} className={`fs-row st-${f.status}`}>
          <select
            value={f.setupChapterId}
            onChange={(e) => patchNow(f.id, { setupChapterId: e.target.value })}
            title="埋设章"
          >
            {chapterOptions.map((o) => <option key={o.id} value={o.id}>埋·{o.label}</option>)}
          </select>
          <input
            type="text"
            className="fs-content"
            placeholder="伏笔内容，一句话"
            value={f.content}
            onChange={(e) => patchLocal(f.id, { content: e.target.value })}
            onBlur={(e) => patchNow(f.id, { content: e.target.value })}
          />
          <select
            value={f.payoffChapterId ?? ''}
            onChange={(e) => patchNow(f.id, { payoffChapterId: e.target.value || undefined })}
            title="计划回收章（留空=未定）"
          >
            <option value="">收·未定</option>
            {chapterOptions.map((o) => <option key={o.id} value={o.id}>收·{o.label}</option>)}
          </select>
          <select
            value={f.status}
            onChange={(e) => patchNow(f.id, { status: e.target.value as Foreshadow['status'] })}
            title="状态"
          >
            <option value="open">未回收</option>
            <option value="resolved">已回收</option>
            <option value="abandoned">已废弃</option>
          </select>
          <button className="icon-btn danger" title="删除这条登记" onClick={() => remove(f.id)}>✕</button>
        </div>
      ))}
      <Btn small ghost onClick={add}>＋ 登记一条伏笔</Btn>
    </div>
  );
}
