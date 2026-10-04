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

/** 注入块文本：每行「- 【条名】内容」。空列表返回 ''（调用侧据此不出块） */
export function loreBlockText(entries: LoreEntry[]): string {
  return entries.map((e) => `- 【${e.title}】${e.content}`).join('\n');
}
