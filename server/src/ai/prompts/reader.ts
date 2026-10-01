import type { ReaderReview } from '../../../../shared/src/types';
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

【本章《${args.chapterTitle}》正文】
${args.content}

输出 JSON（${JSON_ONLY}）：
{ "personas": [ { "name": "读者身份", "overall": 6, "wouldContinue": true, "praise": "…", "grievances": [ { "quote": "正文原句", "issue": "读者感受" } ] } ], "verdict": "…", "topFixes": ["…"] }
（personas 恰好三条，顺序与上面三类读者一致）`,
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
  return {
    personas: personasOut,
    verdict: typeof o.verdict === 'string' ? o.verdict.slice(0, 200) : '',
    topFixes: Array.isArray(o.topFixes) ? o.topFixes.filter((s): s is string => typeof s === 'string').slice(0, 3).map((s) => s.slice(0, 200)) : [],
  };
}
