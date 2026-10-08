import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { CharacterCard, LoreEntry, Outline, StateEntry, StyleExemplar } from '../../../shared/src/types';
import type { LoreTestReport } from '../../../shared/src/lore';
import { api } from '../api/client';
import { useStore } from '../state/store';
import { Btn } from './primitives';

/** 人物状态时间线：采纳归档建议自动追加；这里供作者审阅、删除错节点、手补漏节点 */
function StateHistoryView({ card, onChange }: { card: CharacterCard; onChange: (hist: StateEntry[]) => void }) {
  const hist = Array.isArray(card.stateHistory) ? card.stateHistory : [];
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ chapterId: '', state: '' });
  const add = () => {
    const cid = draft.chapterId.trim();
    const st = draft.state.trim();
    if (!/^v\d{2,}c\d{3,}$/.test(cid) || !st) return;
    onChange([...hist, { chapterId: cid, chapterTitle: '', state: st, at: new Date().toISOString() }]);
    setDraft({ chapterId: '', state: '' });
  };
  return (
    <div style={{ marginTop: 8 }}>
      <button className="icon-btn" style={{ width: 'auto', padding: '2px 10px', borderRadius: 'var(--r-pill)', fontSize: 12 }}
        onClick={() => setOpen((o) => !o)}>
        状态时间线 · {hist.length} 节点 {open ? '▲' : '▼'}
      </button>
      {open && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {hist.length === 0 && <div style={{ fontSize: 12, opacity: 0.6 }}>尚无节点——采纳某章归档产生的「状态变更」建议后会自动记在这里。</div>}
          {hist.map((e, k) => (
            <div key={k} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, padding: '4px 8px', borderRadius: 'var(--r-sm)', background: 'var(--gray-2)' }}>
              <span style={{ opacity: 0.7, flexShrink: 0 }}>{e.chapterId}{e.chapterTitle ? `《${e.chapterTitle}》` : ''}</span>
              <span style={{ flex: 1 }}>{e.state}{e.reason ? <span style={{ opacity: 0.6 }}>（{e.reason}）</span> : ''}</span>
              <button className="icon-btn danger" title="删除该节点" onClick={() => onChange(hist.filter((_, x) => x !== k))}>✕</button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="text" placeholder="v01c003" style={{ width: 88 }} value={draft.chapterId} onChange={(ev) => setDraft((d) => ({ ...d, chapterId: ev.target.value }))} />
            <input type="text" placeholder="该章时点的状态" style={{ flex: 1 }} value={draft.state} onChange={(ev) => setDraft((d) => ({ ...d, state: ev.target.value }))} />
            <Btn ghost onClick={add} disabled={!/^v\d{2,}c\d{3,}$/.test(draft.chapterId.trim()) || !draft.state.trim()}>补记</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

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
            <StateHistoryView
              card={c}
              onChange={(hist) => patchChar(i, { stateHistory: hist })}
            />
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

        <div className="hr" />
        <LorebookSection outline={bundle.outline} />

        <div className="hr" />
        <ExemplarSection outline={bundle.outline} />

        <div style={{ height: 60 }} />
      </div>
    </div>
  );
}

/** 触发词字符串 ⇔ 数组：以逗号/顿号/空格分隔 */
function parseKeys(s: string): string[] {
  return s.split(/[,，、\s]+/).map((k) => k.trim()).filter(Boolean);
}

/**
 * 世界书（Lorebook）编辑区：设定拆成"触发词 → 内容"条目，写章时按语料命中才注入。
 * 数据走 store.loadLorebook/saveLorebook（异步取数在 store，避免 effect 内 setState 违规）；
 * 本地草稿在 store 引用变化（首帧载入 / 保存回显规范化）时于渲染期重置，与人物卡同一手法。
 */
function LorebookSection({ outline }: { outline: Outline | null }) {
  const { lorebook, loreTrace, loadLorebook, saveLorebook, toast } = useStore(useShallow((s) => ({
    lorebook: s.lorebook, loreTrace: s.loreTrace, loadLorebook: s.loadLorebook, saveLorebook: s.saveLorebook, toast: s.toast,
  })));
  const [draft, setDraft] = useState<LoreEntry[]>(lorebook ?? []);
  // store 值换引用（载入完成 / 保存回显）→ 重置草稿；渲染期比较，不走 effect
  const [lastStore, setLastStore] = useState(lorebook);
  if (lorebook !== lastStore) {
    setLastStore(lorebook);
    setDraft(lorebook ?? []);
  }
  useEffect(() => { void loadLorebook(); }, [loadLorebook]);

  const chOptions: { id: string; label: string }[] = [];
  const volOptions: { id: string; label: string }[] = [];
  if (outline) {
    for (const v of outline.volumes) {
      volOptions.push({ id: v.id, label: v.title });
      for (const c of v.chapters) chOptions.push({ id: c.id, label: `${v.title}·${c.title}` });
    }
  }
  // 每条被激活过的章数（留痕）：id → {on, off}
  const hit = new Map<string, { on: number; off: number }>();
  if (loreTrace) {
    for (const t of Object.values(loreTrace)) {
      for (const a of t.activated) hit.set(a.id, { on: (hit.get(a.id)?.on ?? 0) + 1, off: hit.get(a.id)?.off ?? 0 });
      for (const d of t.dropped) hit.set(d.id, { on: hit.get(d.id)?.on ?? 0, off: (hit.get(d.id)?.off ?? 0) + 1 });
    }
  }

  const patch = (i: number, p: Partial<LoreEntry>) => setDraft((ds) => ds.map((e, k) => (k === i ? { ...e, ...p } : e)));
  const patchScope = (i: number, p: Partial<LoreEntry['scope']>) => setDraft((ds) => ds.map((e, k) => {
    if (k !== i) return e;
    const scope = { ...(e.scope ?? {}), ...p };
    for (const key of ['volumeId', 'chapterFrom', 'chapterTo'] as const) if (!scope[key]) delete scope[key];
    return { ...e, scope: Object.keys(scope).length ? scope : undefined };
  }));

  async function save() {
    // 无触发词又非常驻的条目永远不会激活——保存前提醒，不静默丢
    const dead = draft.filter((e) => !e.constant && e.keys.length === 0);
    if (dead.length) toast(`有 ${dead.length} 条无触发词且未勾常驻，将永不激活（加触发词或勾「常驻」）`, 'error');
    if (await saveLorebook(draft)) toast('世界书已保存', 'ok');
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
        <h3 className="pane-title" style={{ fontSize: 18 }}>世界书 · 按需激活</h3>
        <span className="pane-sub" style={{ fontSize: 12 }}>写章时只注入「触发词命中本章语料」的条目；勾选常驻则每章都注入</span>
        {hit.size > 0 && (
          <button className="icon-btn" style={{ width: 'auto', padding: '2px 10px', borderRadius: 'var(--r-pill)', fontSize: 12 }}
            title="按历史激活章数降序重排草稿（点保存整表落盘才生效）"
            onClick={() => setDraft((ds) => ds.slice().sort((a, b) => (hit.get(b.id)?.on ?? 0) - (hit.get(a.id)?.on ?? 0)))}>
            按激活排序
          </button>
        )}
      </div>

      <ActivationTester outline={outline} kind="lore" />

      {draft.map((e, i) => {
        const h = hit.get(e.id);
        return (
          <div key={e.id} className="vol-block" style={{ padding: 12, opacity: e.enabled === false ? 0.55 : 1 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <input type="text" style={{ fontWeight: 700, flex: 1 }} value={e.title} placeholder="条名" onChange={(ev) => patch(i, { title: ev.target.value })} />
              {h && (h.on > 0 || h.off > 0) && (
                <span style={{ fontSize: 11, opacity: 0.7, whiteSpace: 'nowrap' }}>
                  {h.on > 0 && <span style={{ color: 'var(--ok)' }}>激活{h.on}章 </span>}
                  {h.off > 0 && <span style={{ color: 'var(--warn)' }}>挤掉{h.off}次</span>}
                </span>
              )}
              <button className="icon-btn danger" title="删除条目" onClick={() => setDraft((ds) => ds.filter((_, k) => k !== i))}>✕</button>
            </div>
            <div className="field"><label>触发词（逗号/顿号/空格分隔，中文按子串匹配）</label>
              <input type="text" value={e.keys.join(', ')} placeholder="例：内力, 丹田, 经脉" onChange={(ev) => patch(i, { keys: parseKeys(ev.target.value) })} />
            </div>
            <div className="field"><label>设定内容（命中后原样注入 prompt）</label>
              <textarea style={{ minHeight: 56 }} value={e.content} onChange={(ev) => patch(i, { content: ev.target.value })} />
            </div>
            {!!e.contract && (
              <div className="field"><label>必现名物（逗号/顿号分隔；正文生成后逐一核对，缺失则自动整章重写一次）· 留空则从内容里的「」短引用自动提取</label>
                <input type="text" value={(e.mustInclude ?? []).join(', ')} placeholder="例：梓木, 照胆剑" onChange={(ev) => patch(i, { mustInclude: parseKeys(ev.target.value).length ? parseKeys(ev.target.value) : undefined })} />
              </div>
            )}
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
              <label className="wn-toggle" style={{ margin: 0 }}><input type="checkbox" checked={e.enabled !== false} onChange={(ev) => patch(i, { enabled: ev.target.checked || undefined })} /> 启用</label>
              <label className="wn-toggle" style={{ margin: 0 }}><input type="checkbox" checked={!!e.constant} onChange={(ev) => patch(i, { constant: ev.target.checked || undefined })} /> 常驻</label>
              <label className="wn-toggle" style={{ margin: 0 }}><input type="checkbox" checked={!!e.contract} onChange={(ev) => patch(i, ev.target.checked ? { contract: true } : { contract: undefined, mustInclude: undefined })} /> 契约（豁免预算）</label>
              <label className="wn-toggle" style={{ margin: 0, gap: 4 }}>优先级 <input type="number" style={{ width: 60 }} value={e.priority ?? 0} onChange={(ev) => { const n = Number(ev.target.value); patch(i, { priority: Number.isFinite(n) && n !== 0 ? n : undefined }); }} /></label>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8, fontSize: 13 }}>
              <span style={{ opacity: 0.7 }}>生效范围</span>
              <select value={e.scope?.volumeId ?? ''} onChange={(ev) => patchScope(i, { volumeId: ev.target.value || undefined })}>
                <option value="">全书</option>
                {volOptions.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
              <span style={{ opacity: 0.7 }}>章起</span>
              <select value={e.scope?.chapterFrom ?? ''} onChange={(ev) => patchScope(i, { chapterFrom: ev.target.value || undefined })}>
                <option value="">不限</option>
                {chOptions.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
              <span style={{ opacity: 0.7 }}>章止</span>
              <select value={e.scope?.chapterTo ?? ''} onChange={(ev) => patchScope(i, { chapterTo: ev.target.value || undefined })}>
                <option value="">不限</option>
                {chOptions.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </div>
          </div>
        );
      })}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Btn ghost onClick={() => setDraft((ds) => [...ds, { id: `l-${Date.now()}`, title: '新条目', keys: [], content: '' }])}>＋ 加条目</Btn>
        <Btn primary onClick={() => void save()}>保存世界书</Btn>
      </div>
    </div>
  );
}

/**
 * 风格范文库编辑区（A2c）：主要入口是评审面板"一键收录"，这里是誊录/纠错/停用处。
 * 数据走 store.loadExemplars/saveExemplarList；草稿重置用渲染期比较（同 LorebookSection 手法）。
 */
function ExemplarSection({ outline }: { outline: Outline | null }) {
  const { exemplars, loadExemplars, saveExemplarList, toast } = useStore(useShallow((s) => ({
    exemplars: s.exemplars, loadExemplars: s.loadExemplars, saveExemplarList: s.saveExemplarList, toast: s.toast,
  })));
  const [draft, setDraft] = useState<StyleExemplar[]>(exemplars ?? []);
  const [lastStore, setLastStore] = useState(exemplars);
  if (exemplars !== lastStore) {
    setLastStore(exemplars);
    setDraft(exemplars ?? []);
  }
  useEffect(() => { void loadExemplars(); }, [loadExemplars]);

  const patch = (i: number, p: Partial<StyleExemplar>) => setDraft((ds) => ds.map((e, k) => (k === i ? { ...e, ...p } : e)));

  async function save() {
    const dead = draft.filter((e) => !e.constant && e.keys.length === 0);
    if (dead.length) toast(`有 ${dead.length} 条无触发词且未勾常驻，将永不激活`, 'error');
    if (await saveExemplarList(draft)) toast('风格范文库已保存', 'ok');
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
        <h3 className="pane-title" style={{ fontSize: 18 }}>风格范文库 · 以本书好段落示范</h3>
        <span className="pane-sub" style={{ fontSize: 12 }}>写章时按触发词命中注入（只模仿笔法，严禁抄情节）；主入口是「读者评审」面板的逐段收录，这里做誊录与纠错</span>
      </div>

      <ActivationTester outline={outline} kind="style" />

      {draft.map((e, i) => (
        <div key={e.id} className="vol-block" style={{ padding: 12, opacity: e.enabled === false ? 0.55 : 1 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <input type="text" style={{ fontWeight: 700, flex: 1 }} value={e.title} placeholder="条名" onChange={(ev) => patch(i, { title: ev.target.value })} />
            <span style={{ fontSize: 11, opacity: 0.65, whiteSpace: 'nowrap' }}>{e.sourceChapterTitle ? `来自《${e.sourceChapterTitle}》` : '手动条目'}</span>
            <button className="icon-btn danger" title="删除条目" onClick={() => setDraft((ds) => ds.filter((_, k) => k !== i))}>✕</button>
          </div>
          <div className="field"><label>范文正文（建议逐字摘自本书定稿正文）</label>
            <textarea style={{ minHeight: 64 }} value={e.content} onChange={(ev) => patch(i, { content: ev.target.value })} />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div className="field" style={{ flex: 2, marginBottom: 0 }}><label>触发词（逗号/顿号/空格分隔）</label>
              <input type="text" value={e.keys.join(', ')} placeholder="例：雨夜, 对峙, 验尸" onChange={(ev) => patch(i, { keys: parseKeys(ev.target.value) })} />
            </div>
            <div className="field" style={{ flex: 1, marginBottom: 0 }}><label>场景标签</label>
              <input type="text" value={e.sceneTag ?? ''} placeholder="打斗/环境/心理…" onChange={(ev) => patch(i, { sceneTag: ev.target.value.trim() || undefined })} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', fontSize: 13, marginTop: 6 }}>
            <label className="wn-toggle" style={{ margin: 0 }}><input type="checkbox" checked={e.enabled !== false} onChange={(ev) => patch(i, { enabled: ev.target.checked || undefined })} /> 启用</label>
            <label className="wn-toggle" style={{ margin: 0 }}><input type="checkbox" checked={!!e.constant} onChange={(ev) => patch(i, { constant: ev.target.checked || undefined })} /> 常驻（每章都注入）</label>
          </div>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Btn ghost onClick={() => setDraft((ds) => [...ds, { id: `x-${Date.now()}`, title: '新范文', keys: [], content: '', at: new Date().toISOString() }])}>＋ 加范文</Btn>
        <Btn primary onClick={() => void save()}>保存范文库</Btn>
      </div>
    </div>
  );
}

/** 激活判定的人话归因（B2 测试器） */
const VERDICT_LABEL: Record<string, { t: string; c: string }> = {
  'activated': { t: '✅ 激活', c: 'var(--ok)' },
  'dropped': { t: '⚠️ 预算溢出被挤掉', c: 'var(--warn)' },
  'no-hit': { t: '○ 触发词未命中', c: 'var(--text-faint)' },
  'out-of-scope': { t: '⛔ 不在生效范围', c: 'var(--text-faint)' },
  'disabled': { t: '⏸ 已停用', c: 'var(--text-faint)' },
};

/**
 * 激活测试器（B2）：选一章 → 逐条解释"为什么注入/没注入"。
 * 判定在服务端跑真·生成同源逻辑（同语料构造、同预算、同引擎），所见即所得。
 */
function ActivationTester({ outline, kind }: { outline: Outline | null; kind: 'lore' | 'style' }) {
  const slug = useStore((s) => s.slug);
  const toast = useStore((s) => s.toast);
  const [ch, setCh] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<LoreTestReport | null>(null);
  const chapters = useMemo(() => (outline?.volumes ?? []).flatMap((v) => v.chapters.map((c) => ({ id: c.id, label: `${v.title}·${c.title}` }))), [outline]);
  const cur = ch && chapters.some((c) => c.id === ch) ? ch : (chapters[0]?.id ?? '');

  async function run() {
    if (!slug || !cur) return;
    setBusy(true);
    try {
      setReport(await api.loreTest(slug, cur, kind));
    } catch (err) {
      toast(`测试失败：${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vol-block" style={{ padding: 12, marginBottom: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>激活测试</span>
        <span style={{ fontSize: 12, opacity: 0.65 }}>按真实生成的同源判定解释每条{kind === 'lore' ? '世界书' : '范文'}的去向</span>
        <select value={cur} onChange={(e) => { setCh(e.target.value); setReport(null); }} style={{ maxWidth: 220 }}>
          {chapters.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <Btn small ghost onClick={() => void run()} disabled={!cur || busy}>{busy ? '测试中…' : '测一下'}</Btn>
      </div>
      {report && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            预算占用 {report.used}/{report.budget} 字 · 共 {report.items.length} 条
          </div>
          {report.items.map((it) => {
            const v = VERDICT_LABEL[it.verdict] ?? VERDICT_LABEL['no-hit'];
            return (
              <div key={it.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12.5, padding: '3px 8px', borderRadius: 'var(--r-sm)', background: 'var(--gray-2)' }}>
                <span style={{ minWidth: 0, flex: 1, fontWeight: 600 }}>{it.title}</span>
                <span style={{ opacity: 0.6 }}>{it.chars}字{it.constant ? '·常驻' : ''}{it.contract ? '·契约' : ''}</span>
                <span style={{ color: v.c, whiteSpace: 'nowrap' }}>
                  {v.t}{it.hitKey && it.verdict === 'activated' ? `（命中「${it.hitKey}」）` : ''}
                </span>
              </div>
            );
          })}
          {report.items.length === 0 && <div style={{ fontSize: 12, opacity: 0.6 }}>（当前表为空，先在下方添加条目）</div>}
        </div>
      )}
    </div>
  );
}
