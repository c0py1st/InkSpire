import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { SearchHit } from '../../../shared/src/types';
import { api } from '../api/client';
import { useStore } from '../state/store';
import { Btn } from './primitives';

export function LeftPanel() {
  const { bundle, centerView, setView, openChapter, chapter, drawerOpen, setDrawer, slug, jumpTo, toast, generating, generatingChapterId } =
    useStore(useShallow((s) => ({
      bundle: s.bundle, centerView: s.centerView, setView: s.setView, openChapter: s.openChapter,
      chapter: s.chapter, drawerOpen: s.drawerOpen, setDrawer: s.setDrawer,
      slug: s.slug, jumpTo: s.jumpTo, toast: s.toast,
      generating: s.generating, generatingChapterId: s.generatingChapterId,
    })));
  const [openVols, setOpenVols] = useState<Set<number>>(new Set([0]));
  const [tab, setTab] = useState<'outline' | 'bible'>('outline');

  // 前文检索：300ms 防抖，命中列表替换大纲树显示；点命中行跳进章节并选中命中词
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);

  // 切换作品时重置搜索：渲染期间比较上一值（与 BibleView 同款模式），避免 effect 级联
  const [lastSlug, setLastSlug] = useState(slug);
  if (lastSlug !== slug) {
    setLastSlug(slug);
    setHits(null);
    setQuery('');
  }

  useEffect(() => {
    const q = query.trim();
    if (!q || !slug) return;
    const t = setTimeout(() => {
      void (async () => {
        try {
          setHits(await api.search(slug, q));
        } catch (err) {
          toast(`检索失败：${(err as Error).message}`, 'error');
          setHits([]);
        }
      })();
    }, 300);
    return () => clearTimeout(t);
  }, [query, slug, toast]);

  const searching = hits !== null;

  if (!bundle?.outline) {
    return (
      <aside className="left-panel">
        <div className="head">
          <div className="title">{bundle?.meta.title ?? '……'}</div>
          <div className="logline">本书还没有大纲。请回首页重新走一遍开书向导，或在设置中检查数据。</div>
        </div>
      </aside>
    );
  }

  const toggleVol = (i: number) => {
    setOpenVols((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const suggCount = bundle.suggestions.length;
  // 当前章贡献了几条未处理建议（旧数据无来源字段则不计入"本章"）
  const suggHere = chapter ? bundle.suggestions.filter((s) => s.sourceChapterId === chapter.id).length : 0;

  return (
    <aside className="left-panel">
      <div className="head">
        <div className="title">{bundle.meta.title}</div>
        <div className="logline">{bundle.meta.logline}</div>
      </div>
      <div className="left-tabs">
        <button className={tab === 'outline' ? 'active' : ''} onClick={() => { setTab('outline'); setHits(null); }}>大纲</button>
        <button className={tab === 'bible' ? 'active' : ''} onClick={() => { setTab('bible'); setView('bible'); setHits(null); }}>设定</button>
        <div style={{ flex: 1 }} />
        <input
          type="search"
          className="tree-search"
          placeholder="搜前文…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!e.target.value.trim()) setHits(null); // 清空输入即退出检索视图
          }}
          title="在所有章节正文中查找：某句话、某个伏笔、某个人物"
        />
      </div>
      <div className="tree">
        {searching ? (
          hits.length === 0 ? (
            <div style={{ padding: '10px 14px', color: 'var(--text-faint)', fontSize: 12.5 }}>
              没有命中的段落。
            </div>
          ) : (
            hits.map((h, i) => (
              <div key={`${h.chapterId}-${h.offset}-${i}`} className="hit-row" onClick={() => void jumpTo(h.chapterId, h.offset, query.trim())} title="点击跳转并选中">
                <span className="hit-where">{h.volumeTitle} · {h.chapterTitle}</span>
                <span className="hit-snip">{h.snippet}</span>
              </div>
            ))
          )
        ) : tab === 'outline' &&
          bundle.outline.volumes.map((vol, vi) => {
            const open = openVols.has(vi);
            const wc = vol.chapters.reduce((a, c) => a + (bundle.wordCounts[c.id] ?? 0), 0);
            return (
              <div key={vol.id}>
                <div className={`vol-row${open ? ' open' : ''}`} onClick={() => toggleVol(vi)} onDoubleClick={() => setView('outline')}>
                  <span className="chev">▶</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{vol.title}</span>
                  <span className="vol-count">{wc ? `${(wc / 10000).toFixed(1)}万` : `${vol.chapters.length}章`}</span>
                </div>
                {open &&
                  vol.chapters.map((c) => (
                    <div
                      key={c.id}
                      className={`ch-row${chapter?.id === c.id && centerView === 'editor' ? ' active' : ''}`}
                      onClick={() => void openChapter(c.id)}
                      title={c.beat}
                    >
                      <span className={`status-dot ${c.status}${generating && generatingChapterId === c.id ? ' gen' : ''}`}></span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
                      <span className="ch-wc">{bundle.wordCounts[c.id] ? bundle.wordCounts[c.id].toLocaleString() : (generating && generatingChapterId === c.id ? '连写中…' : '')}</span>
                    </div>
                  ))}
              </div>
            );
          })}
        {tab === 'bible' && (
          <div style={{ padding: '10px 14px' }}>
            {bundle.characters.map((c) => (
              <div key={c.id} style={{ padding: '5px 0', fontSize: 12.8 }}>
                <b>{c.name}</b> <span style={{ color: 'var(--text-faint)' }}>{c.role}</span>
              </div>
            ))}
            <Btn small ghost style={{ marginTop: 8 }} onClick={() => setView('bible')}>打开设定集编辑 →</Btn>
          </div>
        )}
      </div>
      <div className="left-footer">
        {suggCount > 0 && (
          <span className="mock-dot" title="agent 在章节归档时发现了待确认的设定变更，去批注抽屉处理">
            {suggHere > 0 ? `本章 ${suggHere} 条 · ` : ''}全书 {suggCount} 条待审建议
          </span>
        )}
        <div style={{ flex: 1 }} />
        <Btn small ghost onClick={() => setDrawer(!drawerOpen)}>{drawerOpen ? '收起' : '批注'}</Btn>
      </div>
    </aside>
  );
}
