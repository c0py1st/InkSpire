import type { ChapterBeat, CharacterCard, LoreEntry, Outline } from '../../../../shared/src/types';
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
  foreshadow?: string;           // 伏笔备忘（已埋未收 + 本章应收）
  cast: CharacterCard[];         // 出场人物完整卡片
  mentionOnly: CharacterCard[];  // 其他主要人物一句话版
  recentHooks?: Array<{ chapter: string; hook: string }>;  // 前文已用章末钩子（去重用；网文模式才有值）
  lore?: string;                 // 世界书本章激活块文本（命中才出现；缺省 = 逐字节旧行为）
  style?: string;                // 风格范文本章激活块文本（A2；命中才出现，缺省同上）
  loreTrace?: {
    activated: LoreEntry[]; dropped: LoreEntry[];
    styleActivated?: LoreEntry[]; styleDropped?: LoreEntry[];
  };                             // 供生成路径落 .index 留痕，不进 prompt
}

/** 逐章正文的生成提示词。这是"严格按大纲"的核心环节。 */
export function prosePrompt(ctx: ChapterContext, targetWords?: number): { system: string; user: string } {
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
  ctx.foreshadow ? `【伏笔登记表（写作纪律，必须遵守）】\n${ctx.foreshadow}` : '',
  // 世界书本章激活条目：只在有命中时出现（无条目/未命中 = 逐字节旧行为）
  ctx.lore ? `【世界书·本章激活】（与出场人物卡同级的硬设定，不得违背）\n${ctx.lore}` : '',
  // ↓ 排布即缓存策略：前面的块跨章逐字节稳定（DeepSeek 前缀缓存按最长公共前缀命中），
  // 每章都变的块（在场人物卡/上一章结尾/本章约束）一律压到生成点之前。
  ctx.mentionOnly.length
    ? `【仅提及的人物】${ctx.mentionOnly.map((c) => `${c.name}：${c.personality}`).join('；')}`
    : '',
  ctx.cast.length
    ? `【本章出场人物卡】\n${ctx.cast
        .map((c) => `${c.name}（${c.role}）：性格 ${c.personality}；背景 ${c.background}；关系 ${c.relations}${c.speechHabit ? `；说话 ${c.speechHabit}` : ''}${c.state ? `；状态 ${c.state}` : ''}`)
        .join('\n')}`
    : '',
  // 风格范文（A2）：验真过的本书好段落做笔法样本；放结尾原文前=离生成点最近的示范位
  ctx.style ? `【风格范文（只模仿笔法、句长、节奏——严禁复用其情节、人名、对白内容）】\n${ctx.style}` : '',
  ctx.prevTail ? `【上一章结尾原文】（承接其场景、语气与未收的钩子）\n…${ctx.prevTail}` : '',
  `【本章硬约束】第 ${ctx.chapter.title} 章（POV：${ctx.chapter.pov ?? '自由'}）\n${ctx.chapter.beat}`,
  nextBeats ? `【后续章节走向（写作时可埋钩子，但不要提前展开）】\n${nextBeats}` : '',
  // 网文模式专属（字段缺省即不出现，非网文逐字节不变）：爽点兑现 + 章末钩子去重
  ctx.chapter.payoffPoint ? `【本章爽点（须在本章兑现）】${ctx.chapter.payoffPoint}` : '',
  ctx.chapter.chapterHook
    ? `【本章章末钩子（结尾须落到这个悬念上）】${ctx.chapter.chapterHook}`
    : '',
  ctx.recentHooks && ctx.recentHooks.length
    ? `【钩子去重】前文已用过的章末钩子：${ctx.recentHooks.map((h) => `《${h.chapter}》${h.hook}`).join('；')}。本章结尾不要复读这些套路（同型悬念、同句式的"突然听到巨响/发现熟悉身影"等），要换新触发方式。`
    : '',
]
  .filter(Boolean)
  .join('\n')}

写作要求：
1. 正文完整覆盖本章 beat 的每一个关键事件，顺序合理、因果清晰；不得新增 beat 之外的主线事件。
2. 人物言行必须符合人物卡；POV 人物之外不进入其内心。
3. 目标长度 ${targetWords ? `约 ${targetWords} 字` : '约 2000~3000 字'}；每个自然段开头用两个全角空格（　　）缩进，段与段之间用一个空行分隔；不要小标题、不要章节号、不要作者说明。
4. 直接输出正文文字。`,
  };
}

/** 续写模式：已有部分正文时使用。budgetText 明确本次只写多少字，避免模型重写一整章导致耗时过长。 */
export function continuePrompt(ctx: ChapterContext, existing: string, budgetText: string): { system: string; user: string } {
  const base = prosePrompt(ctx);
  const tail = existing.slice(-1200);
  return {
    system: base.system,
    user: `${base.user}

【特别注意】本章已有部分正文约 ${existing.replace(/\s/g, '').length} 字，如下是其结尾：
…${tail}

本次任务是从其结尾处无缝续写约 ${budgetText}，把本章自然写完、收束到本章 beat 的终点。续写内容必须与已有部分浑然一体：延续场景、时态、人称与节奏，不得重复已有情节，也不要复述最后一段；不要为了凑长度而注水。

直接输出续写的正文内容（不要重复已有文字）。`,
  };
}
