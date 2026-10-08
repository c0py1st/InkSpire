import type { LoreEntry } from './types';

/**
 * 世界书激活引擎（纯函数，零依赖）。
 * 设计承自 memory.ts 的"整条进出"纪律：条目不做中途截断，
 * 溢出即整条进 dropped 留痕——半条设定比没有设定更容易让模型出错。
 */

export interface LoreActivation {
  /** 最终注入的条目，按注入顺序 */
  activated: LoreEntry[];
  /** 命中/候选但因预算被丢弃的条目（留痕用，作者能看到"哪条被挤掉了"） */
  dropped: LoreEntry[];
}

/** 条目注入成本：按内容长度计（与 memory.ts 的字符预算口径一致） */
function cost(e: LoreEntry): number {
  return e.content.length;
}

/** 触发词命中：子串匹配、大小写不敏感；空/全空白触发词视为无效键，永不命中 */
export function loreKeyHit(entry: LoreEntry, corpusLower: string): boolean {
  for (const k of entry.keys) {
    const key = k.trim().toLowerCase();
    if (key && corpusLower.includes(key)) return true;
  }
  return false;
}

/** scope 的章区间判定（含端点，按阅读序下标）。未知边界 id 视为该侧开放（宽容降级）。导出供 agent 工具复用同一语义。 */
export function loreInScope(entry: LoreEntry, order: string[], at: number, volumeId?: string): boolean {
  const sc = entry.scope;
  if (!sc) return true;
  if (sc.volumeId && volumeId !== sc.volumeId) return false;
  if (sc.chapterFrom) {
    const i = order.indexOf(sc.chapterFrom);
    if (i >= 0 && at < i) return false;
  }
  if (sc.chapterTo) {
    const i = order.indexOf(sc.chapterTo);
    if (i >= 0 && at > i) return false;
  }
  return true;
}

/**
 * 核心激活：过滤 scope 与停用 → 触发判定（constant 豁免）→
 * priority 降序（同值保持文件序，稳定排序）→ 预算整条填充（contract 豁免）。
 * chapterId 不在阅读序中时返回全空（无从定位，宁缺毋滥）。
 */
export function activateLore(args: {
  entries: LoreEntry[];
  order: string[];
  chapterId: string;
  volumeId?: string;
  /** 章级语料（标题/beat/人物/前尾/摘要拼成的纯文本），只用于触发匹配 */
  corpus: string;
  budgetChars: number;
}): LoreActivation {
  const { entries, order, chapterId, volumeId, budgetChars } = args;
  const at = order.indexOf(chapterId);
  if (at < 0) return { activated: [], dropped: [] };
  const hay = args.corpus.toLowerCase();

  const hits: LoreEntry[] = [];
  for (const e of entries) {
    if (e.enabled === false) continue;
    if (!loreInScope(e, order, at, volumeId)) continue;
    if (e.constant !== true && !loreKeyHit(e, hay)) continue;
    hits.push(e);
  }
  // priority 降序、同值文件序：Array.prototype.sort 在 V8 中稳定，直接用
  const ranked = hits
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (b.e.priority ?? 0) - (a.e.priority ?? 0) || a.i - b.i)
    .map((x) => x.e);

  const activated: LoreEntry[] = [];
  const dropped: LoreEntry[] = [];
  let used = 0;
  for (const e of ranked) {
    if (e.contract) { activated.push(e); continue; }
    const c = cost(e);
    if (used + c <= budgetChars) {
      activated.push(e);
      used += c;
    } else {
      dropped.push(e);
    }
  }
  return { activated, dropped };
}

/**
 * 激活条目的注入排版。契约条与非契约条分级：
 * - 有 contract 时单独分组置顶并带硬约束头——要求「主动落实」而非仅仅「不违背」
 *   （实测教训：只标"不得违背"时，模型会让契约条件永不触发来绕开，如剑名条通篇不提剑名）；
 * - 无 contract 时输出与旧版逐字节一致（零契约书的前缀缓存与行为不变）。
 */
export function loreBlockText(entries: LoreEntry[]): string {
  const bullet = (e: LoreEntry): string => `- 【${e.title}】${e.content}`;
  const contracts = entries.filter((e) => e.contract === true);
  const others = entries.filter((e) => e.contract !== true);
  const blocks: string[] = [];
  if (contracts.length) {
    blocks.push(`▲设定契约（本章正文必须主动落实，仅"不违背"不算完成：契约中的名物、称谓、道具须在其要求处出现在正文里）\n${contracts.map(bullet).join('\n')}`);
  }
  if (others.length) blocks.push(others.map(bullet).join('\n'));
  return blocks.join('\n');
}

/* ---------------- 契约名物自检（生成链重写判定与 UI 提示共用；纯函数零模型） ---------------- */

/** 回退提取要排除的字符：标点的与虚词——防把「结局必须是主角胜出」这类条款当名物造成误伤重写 */
const NOT_NOUN_LIKE = /[的是一不没未需须要应当而与和或但即若因为，。、；：！？（）()《》「」『』…—·\s]/;

/** 一条契约的"必现名物"：mustInclude 显式声明优先；否则回退提取 content 里 1~6 字的名物化「」短引用 */
export function contractTokens(e: LoreEntry): string[] {
  const declared = (e.mustInclude ?? []).map((t) => t.trim()).filter(Boolean);
  if (declared.length) return [...new Set(declared)].slice(0, 12);
  const found = [...e.content.matchAll(/「([^」\n]{1,6})」/g)].map((m) => m[1].trim());
  const clean = found.filter((t) => t && !NOT_NOUN_LIKE.test(t));
  return [...new Set(clean)].slice(0, 5);
}

/** 逐条契约核对正文是否落实名物；返回缺失清单（空=全部命中或无可检名物）。子串命中，中文零分词依赖 */
export function contractMisses(entries: LoreEntry[], text: string): Array<{ title: string; token: string }> {
  const out: Array<{ title: string; token: string }> = [];
  for (const e of entries) {
    if (e.contract !== true || e.enabled === false) continue;
    for (const t of contractTokens(e)) if (!text.includes(t)) out.push({ title: e.title, token: t });
  }
  return out;
}

/* ---------------- 激活解释器（UI 测试器用；判定逻辑与 activateLore 严格同源） ---------------- */

export type LoreVerdict = 'activated' | 'dropped' | 'out-of-scope' | 'disabled' | 'no-hit';

export interface LoreExplainItem {
  id: string;
  title: string;
  chars: number;
  verdict: LoreVerdict;
  hitKey?: string;      // no-hit 之外命中用的触发词
  constant?: boolean;
  contract?: boolean;
}

/** 激活测试器的完整回包（B2）：逐条判定 + 预算占用 */
export interface LoreTestReport { kind: 'lore' | 'style'; used: number; budget: number; items: LoreExplainItem[] }

/**
 * 逐条解释"为什么注入了/没注入"：先按与 activateLore 相同的顺序与预算规则分出
 * activated/dropped，再为未候选条目补 out-of-scope/disabled/no-hit 归因。
 * 章不在阅读序时全部按 out-of-scope 处理（无从定位=全部不生效）。
 */
export function explainLoreActivation(args: {
  entries: LoreEntry[];
  order: string[];
  chapterId: string;
  volumeId?: string;
  corpus: string;
  budgetChars: number;
}): { items: LoreExplainItem[]; used: number; budget: number } {
  const { entries, order, chapterId, volumeId, budgetChars } = args;
  const at = order.indexOf(chapterId);
  const hay = args.corpus.toLowerCase();
  const firstKey = (e: LoreEntry): string | undefined =>
    e.keys.map((k) => k.trim().toLowerCase()).find((k) => k && hay.includes(k));

  type Row = { e: LoreEntry; i: number; verdict: LoreVerdict | 'pending'; hitKey?: string };
  const rows: Row[] = [];
  const candidates: Row[] = [];
  entries.forEach((e, i) => {
    const base = { e, i };
    if (e.enabled === false) { rows.push({ ...base, verdict: 'disabled' }); return; }
    if (at < 0 || !loreInScope(e, order, at, volumeId)) { rows.push({ ...base, verdict: 'out-of-scope' }); return; }
    if (e.constant !== true) {
      const hk = firstKey(e);
      if (!hk) { rows.push({ ...base, verdict: 'no-hit' }); return; }
      const row: Row = { ...base, verdict: 'pending', hitKey: hk };
      rows.push(row); candidates.push(row);
      return;
    }
    const row: Row = { ...base, verdict: 'pending' };
    rows.push(row); candidates.push(row);
  });
  // 与 activateLore 同款排序 + 预算填充
  const ranked = candidates
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (b.r.e.priority ?? 0) - (a.r.e.priority ?? 0) || a.i - b.i)
    .map((x) => x.r);
  let used = 0;
  for (const r of ranked) {
    if (r.e.contract) { r.verdict = 'activated'; continue; }
    if (used + r.e.content.length <= budgetChars) { r.verdict = 'activated'; used += r.e.content.length; }
    else r.verdict = 'dropped';
  }
  const items = rows.map((r) => ({
    id: r.e.id, title: r.e.title, chars: r.e.content.length,
    verdict: r.verdict === 'pending' ? ('activated' as LoreVerdict) : r.verdict,
    ...(r.hitKey ? { hitKey: r.hitKey } : {}),
    ...(r.e.constant ? { constant: true } : {}),
    ...(r.e.contract ? { contract: true } : {}),
  }));
  return { items, used, budget: budgetChars };
}
