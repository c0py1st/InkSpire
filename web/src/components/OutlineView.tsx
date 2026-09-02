import { useState } from 'react';
import type { Outline } from '../../../shared/src/types';
import { chapterId as mkChapterId } from '../../../shared/src/util';
import { api } from '../api/client';
import { useStore } from '../state/store';
import { Btn, Field } from './primitives';

export function OutlineView() {
  const { bundle, persistOutline, updateOutlineLocal, toast, openChapter, setView, reloadBundle } = useStore();
  const [refining, setRefining] = useState<number | null>(null);
  const [confirmVol, setConfirmVol] = useState<number | null>(null);
  /** 卷抽屉：默认全部收起，按卷 id 记录展开状态（用 id 而非下标，拖动排序后不错位） */
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  if (!bundle) return <div className="center-scroll" />;
  const outlineNullable = bundle.outline;
  if (!outlineNullable) {
    return (
      <div className="center-scroll">
        <div className="pane-pad">
          <h2 className="pane-title">本书还没有大纲</h2>
          <div className="pane-sub">请回到首页重新创建，或检查 data 目录中的 outline.json。</div>
        </div>
      </div>
    );
  }
  const outline: Outline = outlineNullable;

  /** 编辑可自由文本字段：本地即时生效，失焦时落盘 */
  function editOutline(patch: Partial<Outline>) {
    updateOutlineLocal({ ...outline, ...patch } as Outline);
  }

  function commitOutline() {
    void persistOutline(outline);
  }

  function mutateVolumes(fn: (vs: Outline['volumes']) => Outline['volumes'], persist = true) {
    const next = { ...outline, volumes: fn(outline.volumes.map((v) => ({ ...v, chapters: [...v.chapters] }))) };
    updateOutlineLocal(next);
    if (persist) void persistOutline(next);
  }

  function addChapter(vi: number) {
    const vol = outline.volumes[vi];
    // 展开目标卷，让新章立刻可见
    setExpandedIds((prev) => new Set(prev).add(vol.id));
    mutateVolumes((vs) => {
      vs[vi].chapters = [
        ...vs[vi].chapters,
        {
          id: mkChapterId(vi + 1, vs[vi].chapters.length + 1),
          title: `新章 ${vs[vi].chapters.length + 1}`,
          beat: '',
          pov: '',
          characters: [],
          status: 'todo',
        },
      ];
      return vs;
    });
    toast('已添加章节，记得填写 beat（本章要发生什么）');
    void vol;
  }

  function moveChapter(vi: number, ci: number, dir: -1 | 1) {
    mutateVolumes((vs) => {
      const arr = vs[vi].chapters;
      const j = ci + dir;
      if (j < 0 || j >= arr.length) return vs;
      [arr[ci], arr[j]] = [arr[j], arr[ci]];
      return vs;
    });
  }

  function removeChapter(vi: number, ci: number) {
    mutateVolumes((vs) => {
      vs[vi].chapters = vs[vi].chapters.filter((_, k) => k !== ci);
      return vs;
    });
  }

  function moveVolume(vi: number, dir: -1 | 1) {
    mutateVolumes((vs) => {
      const j = vi + dir;
      if (j < 0 || j >= vs.length) return vs;
      [vs[vi], vs[j]] = [vs[j], vs[vi]];
      return vs;
    });
  }

  async function refineVolume(vi: number) {
    setRefining(vi);
    setConfirmVol(null);
    try {
      await api.refineVolume(bundle!.meta.slug, vi, outline.volumes[vi].chapters.length || 10);
      await reloadBundle();
      toast('本卷细纲已重新生成', 'ok');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setRefining(null);
    }
  }

  return (
    <div className="center-scroll">
      <div className="pane-pad outline-head">
        <h2 className="pane-title">大纲 · agent 的工作契约</h2>
        <div className="pane-sub">这里改动的每一个字，都会成为后续章节生成的硬约束。字段失焦即保存。</div>

        <Field label="一句话内核"><textarea style={{ minHeight: 48 }} value={outline.premise} onChange={(e) => editOutline({ premise: e.target.value })} onBlur={commitOutline} /></Field>
        <div style={{ display: 'flex', gap: 14 }}>
          <Field label="题材"><input type="text" value={outline.genre} onChange={(e) => editOutline({ genre: e.target.value })} onBlur={commitOutline} /></Field>
        </div>
        <Field label="主线冲突"><textarea style={{ minHeight: 56 }} value={outline.coreConflict} onChange={(e) => editOutline({ coreConflict: e.target.value })} onBlur={commitOutline} /></Field>
        <Field label="结局走向"><textarea style={{ minHeight: 56 }} value={outline.endingVision} onChange={(e) => editOutline({ endingVision: e.target.value })} onBlur={commitOutline} /></Field>
        <Field label="文风约定"><textarea style={{ minHeight: 70 }} value={outline.styleGuide} onChange={(e) => editOutline({ styleGuide: e.target.value })} onBlur={commitOutline} /></Field>

        {outline.volumes.map((vol, vi) => {
          const expanded = expandedIds.has(vol.id);
          return (
          <div key={vol.id} className="vol-block">
            <div className="vol-head">
              <button
                className={`icon-btn vol-chev${expanded ? ' open' : ''}`}
                title={expanded ? '收起章节（收进抽屉）' : '展开章节'}
                onClick={() => setExpandedIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(vol.id)) next.delete(vol.id);
                  else next.add(vol.id);
                  return next;
                })}
              >▶</button>
              <input
                type="text" className="vol-title" value={vol.title}
                onChange={(e) => mutateVolumes((vs) => { vs[vi].title = e.target.value; return vs; }, false)}
                onBlur={(e) => mutateVolumes((vs) => { vs[vi].title = e.target.value; return vs; })}
              />
              <span
                className="vol-count-hit"
                title={expanded ? '收起章节' : '展开章节'}
                onClick={() => setExpandedIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(vol.id)) next.delete(vol.id);
                  else next.add(vol.id);
                  return next;
                })}
              >{vol.chapters.length} 章</span>
              <button className="icon-btn" title="上移" onClick={() => moveVolume(vi, -1)}>↑</button>
              <button className="icon-btn" title="下移" onClick={() => moveVolume(vi, 1)}>↓</button>
              <Btn small disabled={refining !== null} onClick={() => setConfirmVol(vi)} title="AI 会重写本卷每一章的 beat，已有正文不会被删除">
                {refining === vi ? '细化中…' : 'AI 细化本卷'}
              </Btn>
            </div>
            <div className="vol-summary">
              <textarea
                style={{ width: '100%', minHeight: 52 }} placeholder="本卷剧情弧"
                value={vol.summary}
                onChange={(e) => mutateVolumes((vs) => { vs[vi].summary = e.target.value; return vs; }, false)}
                onBlur={(e) => mutateVolumes((vs) => { vs[vi].summary = e.target.value; return vs; })}
              />
            </div>

            {expanded && vol.chapters.map((c, ci) => (
              <div key={c.id} className="ch-edit">
                <div className="row1">
                  <span className="ch-id">{c.id}</span>
                  <input
                    type="text" className="ch-title" value={c.title}
                    onChange={(e) => mutateVolumes((vs) => { vs[vi].chapters[ci] = { ...c, title: e.target.value }; return vs; }, false)}
                    onBlur={(e) => mutateVolumes((vs) => { vs[vi].chapters[ci] = { ...c, title: e.target.value }; return vs; })}
                  />
                  <select
                    value={c.status}
                    onChange={(e) => mutateVolumes((vs) => { vs[vi].chapters[ci] = { ...c, status: e.target.value as never }; return vs; })}
                  >
                    <option value="todo">未写</option>
                    <option value="draft">草稿</option>
                    <option value="revised">定稿</option>
                  </select>
                  <button className="icon-btn" title="写作或打开本章" onClick={() => void openChapter(c.id)}>✎</button>
                  <button className="icon-btn" title="上移" onClick={() => moveChapter(vi, ci, -1)}>↑</button>
                  <button className="icon-btn" title="下移" onClick={() => moveChapter(vi, ci, 1)}>↓</button>
                  <button className="icon-btn danger" title="从大纲中移除（正文文件保留）" onClick={() => removeChapter(vi, ci)}>✕</button>
                </div>
                <textarea
                  className="beat" placeholder="本章 beat：会发生什么（agent 严格照此执行）"
                  value={c.beat}
                  onChange={(e) => mutateVolumes((vs) => { vs[vi].chapters[ci] = { ...c, beat: e.target.value }; return vs; }, false)}
                  onBlur={(e) => mutateVolumes((vs) => { vs[vi].chapters[ci] = { ...c, beat: e.target.value }; return vs; })}
                />
                <div className="row2">
                  <input
                    type="text" placeholder="视角人物"
                    value={c.pov ?? ''}
                    onChange={(e) => mutateVolumes((vs) => { vs[vi].chapters[ci] = { ...c, pov: e.target.value }; return vs; }, false)}
                    onBlur={(e) => mutateVolumes((vs) => { vs[vi].chapters[ci] = { ...c, pov: e.target.value }; return vs; })}
                  />
                  <input
                    type="text" placeholder="出场人物（顿号分隔）"
                    value={(c.characters ?? []).join('、')}
                    onChange={(e) => mutateVolumes((vs) => { vs[vi].chapters[ci] = { ...c, characters: [] }; return vs; }, false)}
                    onBlur={(e) => mutateVolumes((vs) => {
                      vs[vi].chapters[ci] = { ...c, characters: e.target.value.split(/[、,，\s]+/).filter(Boolean) };
                      return vs;
                    })}
                  />
                </div>
              </div>
            ))}
            {expanded && (
              <div style={{ padding: '8px 12px' }}>
                <Btn small ghost onClick={() => addChapter(vi)}>＋ 加一章</Btn>
              </div>
            )}
          </div>
          );
        })}

        <Btn ghost onClick={() => mutateVolumes((vs) => [...vs, { id: `v${String(vs.length + 1).padStart(2, '0')}`, title: `新卷 ${vs.length + 1}`, summary: '', chapters: [] }])}>
          ＋ 加一卷
        </Btn>
        <div style={{ height: 60 }} />
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <Btn onClick={() => setView('bible')}>去编辑设定集 →</Btn>
        </div>
      </div>

      {confirmVol !== null && (
        <div className="modal-mask" onClick={() => setConfirmVol(null)}>
          <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
            <div className="m-head">AI 细化本卷</div>
            <div className="m-body" style={{ fontSize: 13 }}>
              将让 agent 依据本卷剧情弧重新生成《{outline.volumes[confirmVol].title}》全部 {outline.volumes[confirmVol].chapters.length || 10} 章的 beat，现有细纲会被覆盖（章节 id 与已有正文保持不变）。继续吗？
            </div>
            <div className="m-foot">
              <div className="spacer" />
              <Btn onClick={() => setConfirmVol(null)}>取消</Btn>
              <Btn primary onClick={() => void refineVolume(confirmVol)}>重新生成</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
