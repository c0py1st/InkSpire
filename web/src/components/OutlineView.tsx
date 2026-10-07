import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ChapterStatus, Outline, Volume } from '../../../shared/src/types';
import { recapFingerprint } from '../../../shared/src/types';
import { chapterId as mkChapterId, moveChapterAcrossVolumes } from '../../../shared/src/util';
import { api } from '../api/client';
import { useStore } from '../state/store';
import { BuDialog } from './BuDialog';
import { Btn, Field } from './primitives';
import { ForeshadowPanel } from './ForeshadowPanel';

/** 卷回本状态：新鲜可顶替逐章 / 过期需重压 / 未归档齐 / 尚无回本 */
type RecapState = 'fresh' | 'stale' | 'incomplete' | 'none';
function recapStateOf(vol: Volume, summaries: Record<string, string>, recap?: { fingerprint: string }): RecapState {
  const archived = vol.chapters.every((c) => (summaries[c.id] ?? '').trim());
  if (!archived) return 'incomplete';
  if (!recap) return 'none';
  return recap.fingerprint === recapFingerprint(vol, summaries) ? 'fresh' : 'stale';
}

export function OutlineView() {
  const { bundle, persistOutline, updateOutlineLocal, toast, openChapter, setView, reloadBundle, toggleWebnovelMode } =
    useStore(useShallow((s) => ({
      bundle: s.bundle, persistOutline: s.persistOutline, updateOutlineLocal: s.updateOutlineLocal,
      toast: s.toast, openChapter: s.openChapter, setView: s.setView, reloadBundle: s.reloadBundle,
      toggleWebnovelMode: s.toggleWebnovelMode,
    })));
  const [refining, setRefining] = useState<number | null>(null);
  const [recapping, setRecapping] = useState<string | null>(null);
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
    // 卷内交换；卷首↑落进上一卷末尾、卷尾↓进入下一卷开头（跨卷搬移，正文文件不动）
    mutateVolumes((vs) => { moveChapterAcrossVolumes(vs, vi, ci, dir); return vs; });
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

  async function buildRecap(volId: string) {
    setRecapping(volId);
    try {
      const out = await api.buildVolumeRecap(bundle!.meta.slug, volId);
      await reloadBundle();
      if (out.status === 'incomplete') toast(`本卷还有 ${out.total! - out.done!} 章未归档，暂不能压回本`, 'error');
      else if (out.status === 'fresh') toast('卷回本已是最新', 'ok');
      else toast('卷回本已生成', 'ok');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setRecapping(null);
    }
  }

  return (
    <div className="center-scroll">
      <div className="pane-pad outline-head">
        <h2 className="pane-title">大纲 · agent 的工作契约</h2>
        <div className="pane-sub">这里改动的每一个字，都会成为后续章节生成的硬约束。字段失焦即保存。</div>

        {/* 网文模式：兼容路线的总开关——关掉不删已填字段，只是不再显示与注入 */}
        <label className="wn-toggle" title="开启后每章可填「爽点/章末钩子」，生成时作为硬约束注入并做跨章钩子去重；体检面板追加节奏红线告警。关闭只隐藏编辑入口，已填字段仍随大纲生效">
          <input type="checkbox" checked={!!bundle?.meta.webnovelMode} onChange={(e) => void toggleWebnovelMode(e.target.checked)} />
          网文连载模式
          <span className="wn-hint">爽点 / 章末钩子 / 钩子去重 / 节奏红线</span>
        </label>

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
              {(() => {
                const st = recapStateOf(vol, bundle.summaries, bundle.recaps?.[vol.id]);
                if (st === 'incomplete') return null; // 未归档齐：回本无从压起，不显示
                const rc = bundle.recaps?.[vol.id];
                if (st === 'fresh' && rc) {
                  return (
                    <span className="recap-chip" title={`悬停看回本全文：\n${rc.recap}`}>
                      卷回本✓
                      <button
                        className="icon-btn" style={{ marginLeft: 2 }}
                        title="重新压缩本卷回本（章摘要变动后需要）"
                        disabled={recapping !== null}
                        onClick={() => void buildRecap(vol.id)}
                      >{recapping === vol.id ? '…' : '↻'}</button>
                    </span>
                  );
                }
                return (
                  <Btn
                    small disabled={recapping !== null}
                    onClick={() => void buildRecap(vol.id)}
                    title="把本卷逐章摘要压成一条「卷回本」：续写后续卷时用它顶替整卷细摘要，省上下文又不丢长程记忆"
                  >{recapping === vol.id ? '压缩中…' : st === 'stale' ? '回本已过期·重压' : '生成卷回本'}</Btn>
                );
              })()}
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
                    onChange={(e) => mutateVolumes((vs) => { vs[vi].chapters[ci] = { ...c, status: e.target.value as ChapterStatus }; return vs; })}
                  >
                    <option value="todo">未写</option>
                    <option value="draft">草稿</option>
                    <option value="revised">定稿</option>
                  </select>
                  <button className="icon-btn" title="写作或打开本章" onClick={() => void openChapter(c.id)}>✎</button>
                  <button className="icon-btn" title="上移（卷首再上移将移入上一卷末尾）" onClick={() => moveChapter(vi, ci, -1)}>↑</button>
                  <button className="icon-btn" title="下移（卷尾再下移将移入下一卷开头）" onClick={() => moveChapter(vi, ci, 1)}>↓</button>
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
                    onChange={() => mutateVolumes((vs) => { vs[vi].chapters[ci] = { ...c, characters: [] }; return vs; }, false)}
                    onBlur={(e) => mutateVolumes((vs) => {
                      vs[vi].chapters[ci] = { ...c, characters: e.target.value.split(/[、,，\s]+/).filter(Boolean) };
                      return vs;
                    })}
                  />
                </div>
                {(bundle?.meta.webnovelMode || c.payoffPoint || c.chapterHook) && (
                  <div className="row2 wn-row">
                    <input
                      type="text" placeholder="本章爽点：读者情绪在本章兑现什么（可空）"
                      value={c.payoffPoint ?? ''}
                      onChange={(e) => mutateVolumes((vs) => { vs[vi].chapters[ci] = { ...c, payoffPoint: e.target.value }; return vs; }, false)}
                      onBlur={(e) => mutateVolumes((vs) => {
                        const { payoffPoint: _drop, ...rest } = vs[vi].chapters[ci];
                        vs[vi].chapters[ci] = e.target.value.trim() ? { ...rest, payoffPoint: e.target.value } : { ...rest };
                        return vs;
                      })}
                    />
                    <input
                      type="text" placeholder="章末钩子：结尾落到的悬念（相邻章忌同套路）"
                      value={c.chapterHook ?? ''}
                      onChange={(e) => mutateVolumes((vs) => { vs[vi].chapters[ci] = { ...c, chapterHook: e.target.value }; return vs; }, false)}
                      onBlur={(e) => mutateVolumes((vs) => {
                        const { chapterHook: _drop, ...rest } = vs[vi].chapters[ci];
                        vs[vi].chapters[ci] = e.target.value.trim() ? { ...rest, chapterHook: e.target.value } : { ...rest };
                        return vs;
                      })}
                    />
                  </div>
                )}
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
        <div style={{ height: 24 }} />
        <ForeshadowPanel />
        <div style={{ height: 60 }} />
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <Btn onClick={() => setView('bible')}>去编辑设定集 →</Btn>
        </div>
      </div>

      {confirmVol !== null && (
        <BuDialog open onClose={() => setConfirmVol(null)} closeOnOutsidePress ariaTitle="AI 细化本卷" size="narrow">
          <div className="m-head">AI 细化本卷</div>
          <div className="m-body" style={{ fontSize: 13 }}>
            将让 agent 依据本卷剧情弧重新生成《{outline.volumes[confirmVol].title}》全部 {outline.volumes[confirmVol].chapters.length || 10} 章的 beat，现有细纲会被覆盖（章节 id 与已有正文保持不变）。继续吗？
          </div>
          <div className="m-foot">
            <div className="spacer" />
            <Btn onClick={() => setConfirmVol(null)}>取消</Btn>
            <Btn primary onClick={() => void refineVolume(confirmVol)}>重新生成</Btn>
          </div>
        </BuDialog>
      )}
    </div>
  );
}
