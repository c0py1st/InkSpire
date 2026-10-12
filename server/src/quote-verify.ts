/**
 * 引证验真：一致性检查/评审类 LLM 输出的每条问题都带"正文原句"引证，
 * 但模型会编造或改写引文——不落地核验就拿假证据驱动修复。
 * 规则（纯函数、零依赖）：
 *  1) 引文逐字在正文 → verified:'exact'
 *  2) 忽略空白差异后命中（换行/缩进造成的错位）→ verified:'loose'
 *  3) 引文尾部带省略号时，取前段核验（模型常截半句）
 *  4) 都不中 → verified:false —— UI 降级展示，绝不作为"确定问题"
 */

export type QuoteVerdict = 'exact' | 'loose' | false;

const stripWs = (s: string): string => s.replace(/\s+/g, '');

export function verifyQuote(quote: string, content: string): QuoteVerdict {
  const q = String(quote ?? '').trim();
  if (!q || !content) return false;
  // 去掉尾部省略号再验（引文截半句是常态）
  const qCore = q.replace(/(?:…|\.\.\.|⋯)+$/, '').trim() || q;
  if (content.includes(qCore)) return 'exact';
  const sq = stripWs(qCore);
  if (!sq) return false;
  return stripWs(content).includes(sq) ? 'loose' : false;
}

/** 给 issues 批量标注核验结果（不改原对象，返回带 verified 的浅拷贝） */
export function verifyIssueQuotes<T extends { quote?: string }>(issues: T[], content: string): Array<T & { verified: QuoteVerdict }> {
  return issues.map((it) => ({ ...it, verified: verifyQuote(it.quote ?? '', content) }));
}

/* ---------------- 对话回答的引用核验（chat citations） ----------------
 * 实测依据（真 Key）：低温模型已会拒绝编造，但会把原文里被叙述隔开的两段引语
 * 「缝」成一段连续引文——每个字都真、连起来不存在。只有逐字比对能抓这类缝合。
 * 提取必须区分「引语」与「提及」：书中术语/人名常被打成「白鹤」「照胆」样引号，
 * 那是提及不是引用，核验它们只会制造误报噪音。 */

/** 直接引语候选：引号内 6~120 字，且满足其一——
 *  a) 引导语在前（说/道/问/答/喊/念/原话/台词/写道 + 冒号紧邻）；
 *  b) 句子样（≥14 字，或含句读逗号顿号）——短而无逗号的引号词视为提及，跳过 */
const QUOTE_PAT = /[“「]([^“”「」\n]{6,120})[”」]/g;
const INTRO_PAT = /(说|道|问|答|喊|喝|念|写道|原话|台词|开口|叫道|回答道|回复)[^\n]{0,6}[：:]\s*$/;

export function extractCitationCandidates(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(QUOTE_PAT)) {
    const q = (m[1] ?? '').trim();
    if (q.length < 6) continue;
    const before = text.slice(Math.max(0, (m.index ?? 0) - 16), m.index);
    const introled = INTRO_PAT.test(before);
    const sentenceLike = q.length >= 14 || /[，。！？；、]/.test(q);
    if (introled || sentenceLike) out.add(q);
  }
  return [...out];
}

export interface CitationMark { quote: string; ok: boolean }

/** 对答案里的引语候选逐条核验（bookText = 全书正文拼接）；空输入/无候选返回 [] */
export function markCitations(answer: string, bookText: string): CitationMark[] {
  if (!answer?.trim() || !bookText) return [];
  return extractCitationCandidates(answer).map((quote) => ({ quote, ok: verifyQuote(quote, bookText) !== false }));
}
