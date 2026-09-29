/**
 * L0 确定性预检：零模型成本的正则/统计级检查，跑在任何 LLM 审校之前。
 * 只报"代码能确证"的信号——它不判断文笔与剧情，只拦截生成事故的确定性形状：
 * 标题/作者话混入正文、复读块、现代词穿帮、缩进约定、字数严重偏离。
 * 输出按 severity 分级（high=几乎必错，medium=倾向有问题，low=提醒），
 * 全部可能误报（口癖复沓/诗引是合法重复），所以它是体检信号不是门禁。
 */

export type L0Severity = 'high' | 'medium' | 'low';

export interface L0Finding {
  code: 'title-leak' | 'repeated-block' | 'modern-word' | 'indent-style' | 'length-skew';
  severity: L0Severity;
  message: string;
  quote?: string;   // 命中的原文片段（供人核；与引证验真同一约定——逐字取自正文）
  at?: number;      // 定位偏移（归一化文本内，供 UI 跳转近似）
}

export interface L0Options {
  targetWords?: number;        // meta.wordsPerChapter
  bannedWords?: string[];      // 项目自定义禁词
  ancientSetting?: boolean;    // 默认现代词表只在古风/架空类题材启用——都市题材必误报，启用与否由调用方按大纲判定
}

/** 默认现代词表：只收"古风/架空世界观里几乎不可能合法"的硬穿帮词；
 *  有歧义的（分钟/消息/时钟等古今双义或可自造）一律不收——误报会杀死对整个检查的信任 */
const MODERN_WORDS = [
  '电话', '手机', '电脑', '电视', '汽车', '火车', '飞机', '地铁', '公交', '网络', '上网',
  '摄像头', '监控器', '手枪', '子弹', '电灯', '灯泡', '发电机', '西装', '咖啡', '巧克力',
  '沙发', '手表', '公司', '工厂', '车间', '警察', '干部',
];

const stripWs = (s: string): string => s.replace(/\s+/g, '');

/** 题材判定辅助（调用方喂 genre+styleGuide 原文）：命中即视为古风/架空类 */
export function looksAncientSetting(text: string): boolean {
  return /(古风|武侠|仙侠|玄幻|奇幻|修真|历史|古代|架空|王朝|朝廷|江湖)/.test(text);
}

/** ≥15 字的连续重复块（跨段复读，LLM 生成事故的头号形状）。对去空白文本滑窗；
 *  同一复读区间会命中多个移位 gram——按"两次出现的间隔一致"并成一条报告。 */
export function findRepeatedBlocks(content: string, minLen = 15, maxReport = 5): L0Finding[] {
  const norm = stripWs(content);
  if (norm.length < minLen * 2) return [];
  const seen = new Map<string, number>();
  const hits: Array<{ gram: string; firstAt: number; secondAt: number }> = [];
  for (let i = 0; i + minLen <= norm.length; i++) {
    const g = norm.slice(i, i + minLen);
    const prev = seen.get(g);
    if (prev === undefined) { seen.set(g, i); continue; }
    if (prev === -1) continue;
    seen.set(g, -1);
    // 与已有命中同区间：gram 起点等距后移 → 同一次复读的滑窗副产品，不重复报告
    const merged = hits.some((h) => prev - h.firstAt === i - h.secondAt && prev > h.firstAt && prev - h.firstAt <= minLen);
    if (!merged) hits.push({ gram: g, firstAt: prev, secondAt: i });
  }
  return hits.slice(0, maxReport).map((h) => ({
    code: 'repeated-block' as const,
    severity: 'low' as L0Severity,
    message: `正文有 ≥15 字内容在约 ${h.secondAt - h.firstAt} 字后原样复现，疑似模型复读；若为诗引/复沓修辞可忽略`,
    quote: h.gram,
    at: h.firstAt,
  }));
}

/** 标题/作者话泄漏：正文里混入章题行、字数说明、markdown 标题 */
export function findTitleLeak(content: string): L0Finding[] {
  const out: L0Finding[] = [];
  const lines = content.split(/\r?\n/);
  let pos = 0;
  for (const line of lines) {
    const t = line.trim();
    if (/^#{1,6}\s/.test(t)) {
      out.push({ code: 'title-leak', severity: 'high', message: '正文混入 Markdown 标题行', quote: t, at: pos });
    } else if (/^【?第[一二三四五六七八九十百千万\d]+章】?\s*\S{0,30}$/.test(t)) {
      out.push({ code: 'title-leak', severity: 'high', message: '正文混入章标题行', quote: t, at: pos });
    } else if (/(本章|本章节?)(字数|完结|预告)|作者(的话|说)|（字数[:：]\s*\d+）?/.test(t)) {
      out.push({ code: 'title-leak', severity: 'high', message: '正文混入作者说明/字数标注', quote: t, at: pos });
    }
    pos += line.length + 1;
  }
  return out;
}

/** 现代词穿帮：默认表仅在 ancientSetting 下启用；bannedWords 自定义项无条件检查 */
export function findModernWords(content: string, opts: { useDefaults: boolean; bannedWords: string[] }): L0Finding[] {
  const list = [...new Set([...(opts.useDefaults ? MODERN_WORDS : []), ...opts.bannedWords])].filter(Boolean);
  const out: L0Finding[] = [];
  const found = new Set<string>();
  for (const w of list) {
    if (found.has(w)) continue;
    const at = content.indexOf(w);
    if (at >= 0) {
      found.add(w);
      out.push({
        code: 'modern-word', severity: 'medium',
        message: `出现现代词「${w}」，与设定违和的可能性高（若为设定内自造词可忽略）`,
        quote: content.slice(Math.max(0, at - 10), at + w.length + 10),
        at,
      });
    }
  }
  return out;
}

/** 段首缩进约定：非空段落应以两个全角空格起头；过半失约才报（系统性问题）。
 *  注意不能用 trim() 取行——JS 会把 \u3000 全角空格当空白剥掉，缩进就没了 */
export function findIndentIssues(content: string): L0Finding[] {
  const paras = content.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.length > 0);
  if (!paras.length) return [];
  const bad = paras.filter((p) => !p.startsWith('\u3000\u3000') && !p.startsWith('  '));
  if (bad.length / paras.length <= 0.4) return [];
  return [{
    code: 'indent-style', severity: 'low',
    message: `${bad.length}/${paras.length} 段未以两个全角空格缩进，违反段落约定`,
    quote: bad[0]?.slice(0, 30),
  }];
}

/** 字数严重偏离：不足目标 30% 或超过 3 倍（截断/注水的确定性信号） */
export function findLengthSkew(content: string, targetWords?: number): L0Finding[] {
  if (!targetWords || targetWords <= 0) return [];
  const n = stripWs(content).length;
  if (n < targetWords * 0.3) {
    return [{ code: 'length-skew', severity: 'medium', message: `正文约 ${n} 字，不足目标 ${targetWords} 字的 30%（可能被截断或生成失败）` }];
  }
  if (n > targetWords * 3) {
    return [{ code: 'length-skew', severity: 'low', message: `正文约 ${n} 字，超过目标 ${targetWords} 字 3 倍（疑似注水）` }];
  }
  return [];
}

export function l0Check(content: string, opts: L0Options = {}): L0Finding[] {
  if (!content.trim()) return [];
  return [
    ...findTitleLeak(content),
    ...findRepeatedBlocks(content),
    ...findModernWords(content, { useDefaults: opts.ancientSetting === true, bannedWords: opts.bannedWords ?? [] }),
    ...findLengthSkew(content, opts.targetWords),
    ...findIndentIssues(content),
  ];
}
