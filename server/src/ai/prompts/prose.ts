import type { ChapterBeat, CharacterCard, Outline } from '../../../../shared/src/types';
import { CREATOR_BASE } from './common';

export interface ChapterContext {
  outline: Outline;
  chapter: ChapterBeat;
  prevChapter?: ChapterBeat;
  nextChapters: ChapterBeat[];   // 之后 1~2 章的 beat
  volumeSummary: string;
  volumeTitle: string;
  prevTail: string;              // 前一章结尾原文（约 1500 字）
  summaries: string;             // 全部前文滚动摘要
  cast: CharacterCard[];         // 出场人物完整卡片
  mentionOnly: CharacterCard[];  // 其他主要人物一句话版
}

/** 逐章正文的生成提示词。这是"严格按大纲"的核心环节。 */
export function prosePrompt(ctx: ChapterContext): { system: string; user: string } {
  const o = ctx.outline;
  const nextBeats = ctx.nextChapters
    .map((c, i) => `下一${i === 0 ? '' : '下'}章《${c.title}》：${c.beat}`)
    .join('\n');

  return {
    system: CREATOR_BASE,
    user: `请撰写本章正文。

${[
  `【全书内核】题材：${o.genre}；内核：${o.premise}`,
  `主线冲突：${o.coreConflict}`,
  `结局走向（不可偏离）：${o.endingVision}`,
  `文风约定（必须遵守）：${o.styleGuide}`,
  `本卷《${ctx.volumeTitle}》剧情弧：${ctx.volumeSummary}`,
  ctx.summaries ? `【前情摘要】\n${ctx.summaries}` : '【前情摘要】这是全书第一章。',
  ctx.prevTail ? `【上一章结尾原文】（承接其场景、语气与未收的钩子）\n…${ctx.prevTail}` : '',
  ctx.cast.length
    ? `【本章出场人物卡】\n${ctx.cast
        .map((c) => `${c.name}（${c.role}）：性格 ${c.personality}；背景 ${c.background}；关系 ${c.relations}${c.speechHabit ? `；说话 ${c.speechHabit}` : ''}${c.state ? `；状态 ${c.state}` : ''}`)
        .join('\n')}`
    : '',
  ctx.mentionOnly.length
    ? `【仅提及的人物】${ctx.mentionOnly.map((c) => `${c.name}：${c.personality}`).join('；')}`
    : '',
  `【本章硬约束】第 ${ctx.chapter.title} 章（POV：${ctx.chapter.pov ?? '自由'}）\n${ctx.chapter.beat}`,
  nextBeats ? `【后续章节走向（写作时可埋钩子，但不要提前展开）】\n${nextBeats}` : '',
]
  .filter(Boolean)
  .join('\n')}

写作要求：
1. 正文完整覆盖本章 beat 的每一个关键事件，顺序合理、因果清晰；不得新增 beat 之外的主线事件。
2. 人物言行必须符合人物卡；POV 人物之外不进入其内心。
3. 目标长度 ${'约 2000~3000 字'}；用空行分段；不要小标题、不要章节号、不要作者说明。
4. 直接输出正文文字。`,
  };
}

/** 续写模式：已有部分正文时使用 */
export function continuePrompt(ctx: ChapterContext, existing: string): { system: string; user: string } {
  const base = prosePrompt(ctx);
  const tail = existing.slice(-1200);
  return {
    system: base.system,
    user: `${base.user}

【特别注意】本章已有部分正文如下，请从其结尾处无缝续写剩余部分。续写内容必须与已有部分浑然一体：延续场景、时态、人称与节奏，不得重复已有情节，也不要复述最后一段。
已有正文结尾：
…${tail}

直接输出续写的正文内容（不要重复已有文字）。`,
  };
}
