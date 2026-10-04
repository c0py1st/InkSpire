import { useEffect, useMemo, useRef, useState } from 'react';
import { findTextRanges, countChars } from '../../../shared/src/util';
import { useStore } from '../state/store';

/**
 * 通读模式：全书正文连续连排（审读视图，只读）。
 * 搜索高亮纯前端计算（findTextRanges，无正则注入面），命中全局编号，‹/› 或 Enter 逐条跳转；
 * 章节按块懒渲染（IntersectionObserver 原生 API），首屏只挂 30 章，滚到哪补到哪。
 */
export function ReadView() {
  const readChapters = useStore((s) => s.readChapters);
  const loadReadThrough = useStore((s) => s.loadReadThrough);
  const openChapter = useStore((s) => s.openChapter);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [visibleCount, setVisibleCount] = useState(30);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { void loadReadThrough(); }, [loadReadThrough]);

  // 章 → 段 → 命中区间；hits 全局连续编号（阅读序），章级区间用于"跳进未渲染的章"
  const model = useMemo(() => {
    const chapters = (readChapters ?? []).map((ch) => {
      const paras = ch.content.split(/\n\s*\n/).filter((p) => p.trim()).map((text) => ({
        text,
        ranges: q.trim() ? findTextRanges(text, q) : [],
        hitStart: 0,
      }));
      let n = 0;
      for (const p of paras) n += p.ranges.length;
      return { id: ch.id, title: ch.title, words: countChars(ch.content), paras, hitCount: n };
    });
    let acc = 0;
    const chapRanges: Array<[number, number]> = [];
    for (const c of chapters) {
      for (const p of c.paras) { p.hitStart = acc; acc += p.ranges.length; }
      chapRanges.push([acc - c.hitCount, acc]);
    }
    return { chapters, chapRanges, hitCount: acc };
  }, [readChapters, q]);

  // 滚到底自动补渲染（observer 回调里 setState 不算 effect 体内同步 setState，合规）
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setVisibleCount((c) => Math.min(c + 30, model.chapters.length));
    });
    io.observe(el);
    return () => io.disconnect();
  }, [model.chapters.length, visibleCount]);

  // 命中跳转：先在事件处理器里保证所在章已渲染（effect 里同步 setState 是级联渲染反模式），
  // effect 只负责 DOM 滚动
  const cur = model.hitCount > 0 ? ((active % model.hitCount) + model.hitCount) % model.hitCount : -1;
  const gotoHit = (next: number) => {
    if (!model.hitCount) return;
    const idx = ((next % model.hitCount) + model.hitCount) % model.hitCount;
    const ci = model.chapRanges.findIndex(([a, b]) => idx >= a && idx < b);
    if (ci >= 0 && ci + 1 > visibleCount) setVisibleCount(ci + 1);
    setActive(idx);
  };
  useEffect(() => {
    if (cur < 0) return;
    const t = setTimeout(() => document.getElementById(`rhit-${cur}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
    return () => clearTimeout(t);
  }, [cur, visibleCount, model]);

  if (!readChapters) return <div className="center-scroll"><div className="pane-pad" style={{ opacity: 0.6 }}>正在载入全书正文…</div></div>;
  if (!readChapters.length) return <div className="center-scroll"><div className="pane-pad" style={{ opacity: 0.6 }}>这本书还没有正文——先去写一章，再来通读。</div></div>;

  const shown = model.chapters.slice(0, visibleCount);

  return (
    <div className="center-scroll">
      <div className="read-bar">
        <input
          type="text" className="read-q" placeholder="在全书正文中查找并高亮…"
          value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) gotoHit(cur - 1); else gotoHit(cur + 1); } }}
        />
        <span className="read-count">{model.hitCount ? `第 ${cur + 1} / 共 ${model.hitCount} 处` : q.trim() ? '无命中' : ''}</span>
        <button className="btn ghost small" onClick={() => gotoHit(cur - 1)} disabled={!model.hitCount} title="上一处（Shift+Enter）">‹</button>
        <button className="btn ghost small" onClick={() => gotoHit(cur + 1)} disabled={!model.hitCount} title="下一处（Enter）">›</button>
      </div>
      <div className="read-flow">
        {shown.map((c) => (
          <section key={c.id} className="read-chapter">
            <h3 className="read-title" title="点击去编辑器打开本章" onClick={() => void openChapter(c.id)}>
              {c.title} <span className="read-words">{c.words.toLocaleString()} 字</span>
            </h3>
            {c.paras.map((p, k) => (
              <p key={k} className="read-para">{renderPara(p, q, cur, setActive)}</p>
            ))}
          </section>
        ))}
        {visibleCount < model.chapters.length && (
          <div style={{ opacity: 0.55, textAlign: 'center', padding: '12px 0' }}>继续滚动加载（已渲染 {shown.length}/{model.chapters.length} 章）</div>
        )}
        <div ref={sentinelRef} style={{ height: 1 }} />
        <div style={{ height: 80 }} />
      </div>
    </div>
  );
}

type Para = { text: string; ranges: Array<[number, number]>; hitStart?: number };

/** 段内交替输出文本与 <mark>；当前命中加 .on，点击 mark 直接定位 */
function renderPara(p: Para, q: string, cur: number, setActive: (n: number) => void) {
  if (!q.trim() || !p.ranges.length) return p.text;
  const nodes: React.ReactNode[] = [];
  let pos = 0;
  p.ranges.forEach(([a, b], k) => {
    const hitIdx = (p.hitStart ?? 0) + k;
    if (a > pos) nodes.push(p.text.slice(pos, a));
    nodes.push(
      <mark key={k} id={`rhit-${hitIdx}`} className={hitIdx === cur ? 'on' : ''} onClick={() => setActive(hitIdx)}>
        {p.text.slice(a, b)}
      </mark>,
    );
    pos = b;
  });
  if (pos < p.text.length) nodes.push(p.text.slice(pos));
  return nodes;
}
