import { useEffect } from 'react';
import { useStore } from '../state/store';
import { Btn } from './primitives';

/**
 * 体检面板：全书进度 / 伏笔账 / 人物出场 / L0 预检 / 模型用量。
 * 数据全部来自 GET /health（纯统计 + .index 缓存，零模型调用），
 * 「重跑 L0」是唯一主动动作（纯代码，不花钱）。
 */
export function HealthView() {
  const slug = useStore((s) => s.slug);
  const webnovelMode = useStore((s) => !!s.bundle?.meta.webnovelMode);
  const openChapter = useStore((s) => s.openChapter);
  const rep = useStore((s) => s.health);
  const busy = useStore((s) => s.healthLoading);
  const loadHealth = useStore((s) => s.loadHealth);
  const rerunHealthL0 = useStore((s) => s.rerunHealthL0);

  // 进入即取数；loadHealth 是 store action（zustand set 不被 React 钩子规则追踪），effect 里调用合规
  useEffect(() => { void loadHealth(); }, [loadHealth]);

  if (!slug) return null;

  const rec = rep?.foreshadow;
  const recycleTotal = rec ? rec.resolved + rec.open : 0;
  const recycleRate = recycleTotal ? Math.round((rec!.resolved / recycleTotal) * 100) : 0;
  const usageTotals = rep?.usage.totals;
  const hitRate = usageTotals && usageTotals.prompt ? Math.round((usageTotals.cached / usageTotals.prompt) * 100) : 0;

  return (
    <div className="center-scroll">
      <div className="pane-pad">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <h2 className="pane-title">体检</h2>
            <div className="pane-sub">进度、伏笔账、人物出场、L0 预检与模型用量。全部本地统计，不调模型。</div>
          </div>
          <span style={{ display: 'inline-flex', gap: 8, flexShrink: 0 }}>
            <Btn ghost small onClick={() => void loadHealth()} disabled={busy}>↻ 刷新</Btn>
            <Btn ghost small onClick={() => void rerunHealthL0()} disabled={busy} title="逐章跑一遍确定性预检（零成本）">
              {busy ? '处理中…' : '重跑 L0 预检'}
            </Btn>
          </span>
        </div>

        {!rep && <div className="pane-sub">加载中…</div>}

        {rep && (
          <>
            {/* 概览三格 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
              <Stat label="章节进度" value={`${rep.progress.archived}/${rep.progress.total}`} sub="已归档 / 总章" />
              <Stat label="全稿字数" value={rep.progress.totalWords.toLocaleString()} sub="去空白正文" />
              <Stat label="伏笔回收率" value={`${recycleRate}%`} sub={`已收 ${rec?.resolved ?? 0} · 未收 ${rec?.open ?? 0} · 废弃 ${rec?.abandoned ?? 0}`} warn={(rec?.overdue.length ?? 0) > 0} />
            </div>

            {/* 伏笔逾期 */}
            {rec && rec.overdue.length > 0 && (
              <Section title={`逾期未收的伏笔（${rec.overdue.length}）`} tone="warn">
                {rec.overdue.map((o) => (
                  <div key={o.id} className="hk-row" onClick={() => void openChapter(o.payoffChapterId)}>
                    <span className="hk-main">{o.content}</span>
                    <span className="hk-tag">应收于《{o.payoffTitle}》</span>
                  </div>
                ))}
              </Section>
            )}

            {/* 网文节奏（仅开启网文模式的书写）：爽点密度/断档红线/钩子缺口 */}
            {webnovelMode && (
              <Section
                title="网文节奏红线"
                tone={rep.pacing.longestDry >= rep.pacing.warnAfter ? 'danger' : rep.pacing.longestDry >= 3 ? 'warn' : 'ok'}
                right={<span className="hk-counts">爽点覆盖 {rep.pacing.chapters ? Math.round((rep.pacing.payoffChapters / rep.pacing.chapters) * 100) : 0}% · 钩子覆盖 {rep.pacing.chapters ? Math.round((rep.pacing.hookChapters / rep.pacing.chapters) * 100) : 0}%</span>}
              >
                {rep.pacing.longestDry >= rep.pacing.warnAfter ? (
                  <div className="tl-detail" style={{ color: 'var(--danger)', marginBottom: 6 }}>
                    最长爽点断档 {rep.pacing.longestDry} 章，已到连载红线（≥{rep.pacing.warnAfter}）——读者的耐心按章计费。
                  </div>
                ) : (
                  <div className="tl-detail" style={{ marginBottom: 6 }}>最长爽点断档 {rep.pacing.longestDry} 章（红线 {rep.pacing.warnAfter} 章）。</div>
                )}
                {rep.pacing.dryRuns.map((r) => (
                  <div key={r.fromChapterId} className="hk-row" style={{ cursor: 'default' }}>
                    <span className="hk-main">断档 {r.length} 章</span>
                    <span className="hk-tag">{r.fromChapterId} → {r.toChapterId}</span>
                  </div>
                ))}
                {rep.pacing.missingHook.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <span className="pane-sub">缺章末钩子：{rep.pacing.missingHook.length} 章 · </span>
                    {rep.pacing.missingHook.slice(0, 8).map((m) => (
                      <span key={m.chapterId} className="tl-chip" style={{ cursor: 'pointer', marginRight: 5 }} onClick={() => void openChapter(m.chapterId)}>{m.title}</span>
                    ))}
                  </div>
                )}
              </Section>
            )}

            {/* L0 预检 */}
            <Section
              title={`L0 确定性预检${rep.l0.chapters.length ? `（${rep.l0.chapters.length} 章有信号）` : ''}`}
              tone={rep.l0.high > 0 ? 'danger' : rep.l0.chapters.length ? 'warn' : 'ok'}
              right={<span className="hk-counts">high {rep.l0.high} · med {rep.l0.medium} · low {rep.l0.low}</span>}
            >
              {rep.l0.chapters.length === 0 && <div className="pane-sub" style={{ padding: '6px 0' }}>未发现形状级事故（标题泄漏 / 复读 / 现代词 / 字数异常）。</div>}
              {rep.l0.chapters.map((c) => (
                <div key={c.chapterId} className="hk-row" onClick={() => void openChapter(c.chapterId)}>
                  <span className="hk-main">《{c.title}》</span>
                  <span className="hk-tag">{c.high ? `严重 ${c.high} ` : ''}{c.medium ? `中 ${c.medium} ` : ''}{c.low ? `轻 ${c.low}` : ''}</span>
                </div>
              ))}
            </Section>

            {/* 人物出场 */}
            <Section title="人物出场">
              {rep.appearances.length === 0 && <div className="pane-sub" style={{ padding: '6px 0' }}>还没有人物卡。</div>}
              {rep.appearances.map((a) => (
                <div key={a.name} className="hk-row">
                  <span className="hk-main">{a.name} <span className="hk-role">{a.role}</span></span>
                  <span className="hk-tag">出场 {a.chapters} 章{a.stateNodes ? ` · 状态 ${a.stateNodes} 节点` : ''}</span>
                </div>
              ))}
            </Section>

            {/* 模型用量 */}
            <Section
              title="模型用量 · 前缀缓存"
              right={<span className="hk-counts">命中率 {hitRate}% · 共 {usageTotals?.calls ?? 0} 次调用</span>}
            >
              {!usageTotals?.calls && <div className="pane-sub" style={{ padding: '6px 0' }}>还没有可统计的真实模型调用（演示模式不报 usage）。</div>}
              {(usageTotals?.calls ?? 0) > 0 && (
                <>
                  {Object.entries(rep.usage.bySource)
                    .sort((a, b) => b[1].prompt - a[1].prompt)
                    .map(([src, c]) => (
                      <div key={src} className="hk-row" style={{ cursor: 'default' }}>
                        <span className="hk-main">{src}</span>
                        <span className="hk-tag">
                          {c.calls} 次 · {c.prompt.toLocaleString()} 入 · 命中 {c.cached.toLocaleString()}
                          （{c.prompt ? Math.round((c.cached / c.prompt) * 100) : 0}%）
                        </span>
                      </div>
                    ))}
                  <div className="pane-sub" style={{ marginTop: 6, fontSize: 11 }}>命中率随模型/时段波动，DeepSeek 类前缀缓存需真实 Key 才谈得上稳定数字。</div>
                </>
              )}
            </Section>
            <div style={{ height: 60 }} />
          </>
        )}
      </div>
    </div>
  );
}

function Stat(props: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className={`stat-card${props.warn ? ' warn' : ''}`}>
      <div className="stat-label">{props.label}</div>
      <div className="stat-value">{props.value}</div>
      {props.sub && <div className="stat-sub">{props.sub}</div>}
    </div>
  );
}

function Section(props: { title: string; tone?: 'ok' | 'warn' | 'danger'; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="vol-block" style={{ padding: 14, marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <h3 className={`sec-title${props.tone ? ` tone-${props.tone}` : ''}`}>{props.title}</h3>
        <div style={{ flex: 1 }} />
        {props.right}
      </div>
      {props.children}
    </div>
  );
}
