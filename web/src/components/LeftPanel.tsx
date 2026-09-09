import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state/store';
import { Btn } from './primitives';

export function LeftPanel() {
  const { bundle, centerView, setView, openChapter, chapter, drawerOpen, setDrawer } =
    useStore(useShallow((s) => ({
      bundle: s.bundle, centerView: s.centerView, setView: s.setView, openChapter: s.openChapter,
      chapter: s.chapter, drawerOpen: s.drawerOpen, setDrawer: s.setDrawer,
    })));
  const [openVols, setOpenVols] = useState<Set<number>>(new Set([0]));
  const [tab, setTab] = useState<'outline' | 'bible'>('outline');

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

  return (
    <aside className="left-panel">
      <div className="head">
        <div className="title">{bundle.meta.title}</div>
        <div className="logline">{bundle.meta.logline}</div>
      </div>
      <div className="left-tabs">
        <button className={tab === 'outline' ? 'active' : ''} onClick={() => setTab('outline')}>大纲</button>
        <button className={tab === 'bible' ? 'active' : ''} onClick={() => { setTab('bible'); setView('bible'); }}>设定</button>
      </div>
      <div className="tree">
        {tab === 'outline' &&
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
                      <span className={`status-dot ${c.status}`}></span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
                      <span className="ch-wc">{bundle.wordCounts[c.id] ? bundle.wordCounts[c.id].toLocaleString() : ''}</span>
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
          <span className="mock-dot" title="agent 在最新章节里发现了未建档的设定，去批注抽屉处理">{suggCount} 条新设定建议</span>
        )}
        <div style={{ flex: 1 }} />
        <Btn small ghost onClick={() => setDrawer(!drawerOpen)}>{drawerOpen ? '收起' : '批注'}</Btn>
      </div>
    </aside>
  );
}
