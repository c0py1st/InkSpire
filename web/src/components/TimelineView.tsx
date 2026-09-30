import { useCallback, useEffect, useMemo, useState } from 'react';
import type { StoryEvent } from '../../../shared/src/types';
import { useStore } from '../state/store';
import { Btn } from './primitives';

/**
 * 世界事件时间线：按章序的大事账本（自动提取 + 作者补记双轨）。
 * 数据走 GET /events；补记/删除即时回写 store（服务端返回全量，天然防漂移）。
 * actor 过滤是纯前端过滤，与 agent 的 read_timeline 同语义。
 */
export function TimelineView() {
  const slug = useStore((s) => s.slug);
  const bundle = useStore((s) => s.bundle);
  const events = useStore((s) => s.events);
  const loadEvents = useStore((s) => s.loadEvents);
  const addStoryEvent = useStore((s) => s.addStoryEvent);
  const deleteStoryEvent = useStore((s) => s.deleteStoryEvent);
  const openChapter = useStore((s) => s.openChapter);
  const confirmAsk = useStore((s) => s.confirmAsk);
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ chapterId: '', title: '', whenInStory: '', actors: '', detail: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => { void loadEvents(); }, [loadEvents]);

  // 章序 + 章题映射（来自大纲，与左栏树一致）
  const chOrder = useMemo(() => {
    const map = new Map<string, { idx: number; title: string; vol: string }>();
    if (bundle?.outline) {
      let idx = 0;
      for (const v of bundle.outline.volumes) {
        for (const c of v.chapters) map.set(c.id, { idx: idx++, title: c.title, vol: v.title });
      }
    }
    return map;
  }, [bundle]);

  const shown = useMemo(() => {
    const list = (events ?? []).slice().sort((a, b) => (chOrder.get(a.chapterId)?.idx ?? 0) - (chOrder.get(b.chapterId)?.idx ?? 0) || a.at.localeCompare(b.at));
    const q = filter.trim();
    if (!q) return list;
    return list.filter((e) => (e.actors ?? []).some((a) => a.includes(q)) || e.title.includes(q) || (e.detail ?? '').includes(q));
  }, [events, filter, chOrder]);

  // 按卷分组渲染
  const grouped = useMemo(() => {
    const out: Array<{ vol: string; items: StoryEvent[] }> = [];
    for (const e of shown) {
      const vol = chOrder.get(e.chapterId)?.vol ?? '（不在大纲）';
      const g = out[out.length - 1];
      if (g && g.vol === vol) g.items.push(e);
      else out.push({ vol, items: [e] });
    }
    return out;
  }, [shown, chOrder]);

  const submit = useCallback(async () => {
    if (!draft.chapterId || !draft.title.trim()) return;
    setSaving(true);
    const ok = await addStoryEvent({
      chapterId: draft.chapterId,
      title: draft.title.trim(),
      ...(draft.whenInStory.trim() ? { whenInStory: draft.whenInStory.trim() } : {}),
      ...(draft.detail.trim() ? { detail: draft.detail.trim() } : {}),
      ...(draft.actors.trim() ? { actors: draft.actors.split(/[、,，;；\s]+/).filter(Boolean) } : {}),
    });
    setSaving(false);
    if (ok) {
      setAdding(false);
      setDraft({ chapterId: '', title: '', whenInStory: '', actors: '', detail: '' });
    }
  }, [draft, addStoryEvent]);

  const askDelete = useCallback(async (e: StoryEvent) => {
    const sure = await confirmAsk(`删除事件「${e.title}」？${e.source === 'auto' ? '（自动提取，重归档该章会再生）' : '（作者补记）'}`, { title: '删除事件', okLabel: '删除' });
    if (sure) await deleteStoryEvent(e.id);
  }, [confirmAsk, deleteStoryEvent]);

  if (!slug) return null;
  const chapterOptions = bundle?.outline
    ? bundle.outline.volumes.flatMap((v) => v.chapters.map((c) => ({ id: c.id, label: `${v.title} · ${c.title}` })))
    : [];

  return (
    <div className="center-scroll">
      <div className="pane-pad">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <h2 className="pane-title">世界事件时间线</h2>
            <div className="pane-sub">章归档时自动提取「十几章后仍然要紧」的大事；也可以手动补记。对话里 agent 会查这本账。</div>
          </div>
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
            <input
              type="text" className="tl-filter" placeholder="按人物/势力过滤…"
              value={filter} onChange={(e) => setFilter(e.target.value)}
            />
            <Btn ghost small onClick={() => setAdding((a) => !a)}>{adding ? '收起' : '＋ 补记'}</Btn>
          </span>
        </div>

        {adding && (
          <div className="vol-block" style={{ padding: 14, marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <div className="field" style={{ width: 220 }}>
                <label>来源章 *</label>
                <select value={draft.chapterId} onChange={(e) => setDraft((d) => ({ ...d, chapterId: e.target.value }))}>
                  <option value="">选择章…</option>
                  {chapterOptions.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </div>
              <div className="field" style={{ width: 140 }}>
                <label>故事内时刻</label>
                <input type="text" placeholder="如：三年初冬" value={draft.whenInStory} onChange={(e) => setDraft((d) => ({ ...d, whenInStory: e.target.value }))} />
              </div>
              <div className="field" style={{ flex: 1, minWidth: 180 }}>
                <label>事件一句话 *</label>
                <input type="text" placeholder="如：盐仓账目对出三年亏空" value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <div className="field" style={{ width: 220 }}>
                <label>参与人物/势力（顿号或逗号分隔）</label>
                <input type="text" placeholder="如：李慎、周主簿" value={draft.actors} onChange={(e) => setDraft((d) => ({ ...d, actors: e.target.value }))} />
              </div>
              <div className="field" style={{ flex: 1, minWidth: 180, marginBottom: 0 }}>
                <label>展开说明（可空）</label>
                <input type="text" value={draft.detail} onChange={(e) => setDraft((d) => ({ ...d, detail: e.target.value }))} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn ghost small onClick={() => setAdding(false)}>取消</Btn>
              <Btn primary small onClick={() => void submit()} disabled={saving || !draft.chapterId || !draft.title.trim()}>落账</Btn>
            </div>
          </div>
        )}

        {(events ?? []).length === 0 && !adding && (
          <div className="pane-sub" style={{ padding: '18px 2px' }}>账本还是空的——每章「完成」归档时会自动提取；也可以点右上「补记」手记一条。</div>
        )}

        {grouped.map((g) => (
          <div key={g.vol} style={{ marginBottom: 18 }}>
            <div className="tl-vol">{g.vol}</div>
            {g.items.map((e) => (
              <div key={e.id} className="tl-item">
                <span className={`tl-dot ${e.source === 'auto' ? 'auto' : 'manual'}`} />
                <div className="tl-body">
                  <div className="tl-head">
                    <button className="tl-ch" onClick={() => void openChapter(e.chapterId)} title="跳到该章">
                      {chOrder.get(e.chapterId)?.title ?? e.chapterId}
                    </button>
                    {e.whenInStory && <span className="tl-when">{e.whenInStory}</span>}
                    <span className={`tl-src ${e.source}`}>{e.source === 'auto' ? '提取' : '补记'}</span>
                    <span className="spacer" style={{ flex: 1 }} />
                    <button className="icon-btn danger" title="删除该事件" onClick={() => void askDelete(e)}>✕</button>
                  </div>
                  <div className="tl-title">{e.title}</div>
                  {e.detail && <div className="tl-detail">{e.detail}</div>}
                  {e.actors && e.actors.length > 0 && (
                    <div className="tl-actors">{e.actors.map((a) => <span key={a} className="tl-chip">{a}</span>)}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
        <div style={{ height: 60 }} />
      </div>
    </div>
  );
}
