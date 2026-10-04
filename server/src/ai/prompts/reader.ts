import type { GoldenChapter, GoldenThreeReview, ReaderReview, ReviewHighlight } from '../../../../shared/src/types';
import { ASSISTANT_BASE, JSON_ONLY } from './common';

/**
 * 读者模拟评审（E2）：让模型分饰若干"目标读者"给本章打分，
 * 焦点是读者体验（想不想读下去、爽没爽到、钩子给得硬不硬），
 * 而非纠错式一致性检查。每条抱怨必须引用正文原文（服务端逐字验真）。
 */

/** 三套读者人设：网文向 vs 通用向（persona 的判据不同） */
function personas(webnovel: boolean): string {
  if (webnovel) {
    return `1. 「爽文老饕」：看过上千章网文，最在意爽点是否兑现、节奏拖不拖、金手指有没有变强。
2. 「追更党」：每天蹲更新，最在意章末钩子硬不硬、会不会"手滑点开下一章"、有没有断在无关处。
3. 「弃文读者」：耐心极低，只要一处出戏/注水/降智就当场弃书，专门挑劝退点。`;
  }
  return `1. 「类型小说读者」：在意故事推进与悬念，会问"这章结束后我为什么还要翻下一页"。
2. 「文学读者」：在意语言质感、人物可信度与细节，反感套路化与说明文式叙述。
3. 「挑剔的书评人」：专找结构失衡、情绪假高潮、伏笔生硬与视角越界。`;
}

export function readerReviewPrompt(args: {
  chapterTitle: string;
  content: string;
  webnovel: boolean;
  payoffPoint?: string;        // 作者标注的本章爽点（有则重点验收）
  chapterHook?: string;        // 作者标注的章末钩子（有则重点验收）
}): { system: string; user: string } {
  const focus = args.webnovel
    ? '网文连载视角：爽点到没到位、章末钩子想不想让人点下一章、有没有注水与劝退点。'
    : '通用长篇视角：这章给阅读体验带来的推进、语言与可信度、以及"为什么还想读下去"。';
  const authorTargets = [
    args.payoffPoint ? `作者标注的本章爽点：${args.payoffPoint}（重点判断是否真的兑现，还是只写了个名头）` : '',
    args.chapterHook ? `作者标注的章末钩子：${args.chapterHook}（判断结尾是否真落到这个悬念上、够不够抓人）` : '',
  ].filter(Boolean).join('\n');
  return {
    system: ASSISTANT_BASE,
    user: `请以三类目标读者的身份，各自独立点评下面这一章正文的阅读体验（不是校对错别字，也不是查设定矛盾）。
总关注点：${focus}

三类读者：
${personas(args.webnovel)}

${authorTargets ? authorTargets + '\n\n' : ''}评分纪律：
- 每位读者给 overall（1~10，允许严厉）、wouldContinue（是否愿意继续读下去，布尔）、praise（最多一句真诚的优点）、grievances（0~3 条具体抱怨）。
- 每条 grievance 必须带 quote（从正文【原样摘录】的一处短句，作为证据，不许改写或凭空编造）与 issue（一句话说明读者的真实感受）。
- 抱怨要具体到"哪句/哪段让人怎样"，不要空泛说"节奏一般"。
- 最后给 verdict（一句话总评）与 topFixes（按影响大小排序、最多 3 条可执行的修改建议）。
- highlights：挑出本章最值得后来章节模仿的文字（0~3 段，宁缺毋滥——写得平庸就给空数组）。
  每段 excerpt 必须从正文【逐字原样摘录】一整句到一小段（30~300 字，服务端会逐字验真，编造即弃）；
  keys 给 2~5 个场景触发词（这类文字适合在什么场面被想起来用，如"雨夜""对峙""心理独白"）；sceneTag 一个词归类。

【本章《${args.chapterTitle}》正文】
${args.content}

输出 JSON（${JSON_ONLY}）：
{ "personas": [ { "name": "读者身份", "overall": 6, "wouldContinue": true, "praise": "…", "grievances": [ { "quote": "正文原句", "issue": "读者感受" } ] } ], "verdict": "…", "topFixes": ["…"],
  "highlights": [ { "excerpt": "正文原样摘录", "keys": ["触发词1", "触发词2"], "sceneTag": "…" } ] }
（personas 恰好三条，顺序与上面三类读者一致；highlights 可为空数组）`,
  };
}

/** 校验/归一模型返回的评审（配合引证验真在路由里做）；返回 null 表示结构不可用 */
export function normalizeReaderReview(raw: unknown): ReaderReview | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.personas)) return null;
  const personasOut = o.personas.slice(0, 3).flatMap((p) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return [];
    const x = p as Record<string, unknown>;
    // 至少要有身份或分数才算一条评审；全默认的空对象是脏条目
    if (typeof x.name !== 'string' && typeof x.overall !== 'number') return [];
    const overall = typeof x.overall === 'number' && Number.isFinite(x.overall) ? Math.max(0, Math.min(10, Math.round(x.overall))) : 0;
    const grievances = Array.isArray(x.grievances)
      ? x.grievances.slice(0, 3).flatMap((g) => {
          if (!g || typeof g !== 'object' || Array.isArray(g)) return [];
          const gg = g as Record<string, unknown>;
          if (typeof gg.quote !== 'string' || typeof gg.issue !== 'string') return [];
          return [{ quote: gg.quote.slice(0, 200), issue: gg.issue.slice(0, 200) }];
        })
      : [];
    return [{
      name: typeof x.name === 'string' ? x.name.slice(0, 24) : '读者',
      overall,
      wouldContinue: !!x.wouldContinue,
      praise: typeof x.praise === 'string' ? x.praise.slice(0, 160) : '',
      grievances,
    }];
  });
  if (personasOut.length === 0) return null;
  // A2：highlights 缺省不出现（旧契约逐字节不变）；脏条目丢弃不毁整份评审，"先滤脏再截 3"——脏条目不占名额
  const highlights: ReviewHighlight[] = (Array.isArray(o.highlights) ? o.highlights : []).flatMap((h) => {
        if (!h || typeof h !== 'object' || Array.isArray(h)) return [];
        const x = h as Record<string, unknown>;
        if (typeof x.excerpt !== 'string' || !x.excerpt.trim()) return [];
        const keys = Array.isArray(x.keys)
          ? x.keys.filter((k): k is string => typeof k === 'string' && !!k.trim()).map((k) => k.trim().slice(0, 40)).slice(0, 5)
          : [];
        return [{
          excerpt: x.excerpt.trim().slice(0, 600),
          keys,
          ...(typeof x.sceneTag === 'string' && x.sceneTag.trim() ? { sceneTag: x.sceneTag.trim().slice(0, 20) } : {}),
        }];
  }).slice(0, 3);
  return {
    personas: personasOut,
    verdict: typeof o.verdict === 'string' ? o.verdict.slice(0, 200) : '',
    topFixes: Array.isArray(o.topFixes) ? o.topFixes.filter((s): s is string => typeof s === 'string').slice(0, 3).map((s) => s.slice(0, 200)) : [],
    ...(highlights.length ? { highlights } : {}),
  };
}

/* ---------------- E4 黄金三章评审 ---------------- */

/**
 * 番茄/起点式"开篇定生死"：把前三章当一批送审，逐章 GO/REVISE/REWRITE，
 * 并给一个综合留存评分。判据是"读完第 3 章还在不在书里"，不是文笔。
 */
export function goldenThreePrompt(args: {
  chapters: Array<{ index: number; title: string; content: string; chapterHook?: string }>;
  genre: string;
}): { system: string; user: string } {
  const body = args.chapters
    .map((c) => `\n【第${c.index}章《${c.title}》】${c.chapterHook ? `（作者标注章末钩子：${c.chapterHook}）` : ''}\n${c.content.slice(0, 8000)}`)
    .join('\n');
  return {
    system: ASSISTANT_BASE,
    user: `你是免费网文平台的资深编辑，替"给了前三章定生死"的读者判断这部 ${args.genre} 的开篇能不能留住人。
逐章裁决 + 综合诊断，判据只有"读者会不会继续"：钩子硬不硬、冲突/金手指进得早不早、有没有劝退点（信息倾倒、主角被动、逻辑硬伤）。别评文笔好坏。

${body}

纪律：
- 每章 verdict：GO（能留人）/ REVISE（有硬伤但可改）/ REWRITE（开篇失败，建议重写）。
- 每章 grievances 0~3 条，quote 必须从对应章正文【原样摘录】（服务端逐字验真），issue 一句话。
- hookNote：一句话评该章章末钩子的强度。
- retentionScore 0~10：三章合力把新读者留住的把握；overall 一句话开篇诊断；fixes≤3 条按影响排序。

输出 JSON（${JSON_ONLY}）：
{ "chapters": [ { "index": 1, "title": "…", "chapterId": "…", "verdict": "GO|REVISE|REWRITE", "hookNote": "…", "grievances": [ { "quote": "正文原句", "issue": "…" } ] } ],
  "retentionScore": 6, "overall": "…", "fixes": ["…"] }`,
  };
}

const VERDICTS = new Set(['GO', 'REVISE', 'REWRITE']);

export function normalizeGoldenThree(raw: unknown): GoldenThreeReview | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.chapters)) return null;
  const chapters: GoldenChapter[] = o.chapters.slice(0, 3).flatMap((c) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return [];
    const x = c as Record<string, unknown>;
    const verdict = typeof x.verdict === 'string' && VERDICTS.has(x.verdict.toUpperCase()) ? x.verdict.toUpperCase() : 'REVISE';
    const grievances = Array.isArray(x.grievances)
      ? x.grievances.slice(0, 3).flatMap((g) => {
          if (!g || typeof g !== 'object' || Array.isArray(g)) return [];
          const gg = g as Record<string, unknown>;
          if (typeof gg.quote !== 'string' || typeof gg.issue !== 'string') return [];
          return [{ quote: gg.quote.slice(0, 200), issue: gg.issue.slice(0, 200) }];
        })
      : [];
    return [{
      index: typeof x.index === 'number' ? x.index : 0,
      title: typeof x.title === 'string' ? x.title.slice(0, 60) : '',
      chapterId: typeof x.chapterId === 'string' ? x.chapterId.slice(0, 24) : '',
      verdict: verdict as GoldenChapter['verdict'],
      hookNote: typeof x.hookNote === 'string' ? x.hookNote.slice(0, 160) : '',
      grievances,
    }];
  });
  if (chapters.length === 0) return null;
  const rs = typeof o.retentionScore === 'number' && Number.isFinite(o.retentionScore) ? Math.max(0, Math.min(10, Math.round(o.retentionScore))) : 0;
  return {
    chapters,
    retentionScore: rs,
    overall: typeof o.overall === 'string' ? o.overall.slice(0, 200) : '',
    fixes: Array.isArray(o.fixes) ? o.fixes.filter((s): s is string => typeof s === 'string').slice(0, 3).map((s) => s.slice(0, 200)) : [],
  };
}
