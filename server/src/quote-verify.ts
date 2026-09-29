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
