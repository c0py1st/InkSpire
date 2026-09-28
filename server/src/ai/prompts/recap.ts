import { ASSISTANT_BASE, JSON_ONLY } from './common';

/**
 * 卷回本：把已完整归档的一卷压成一条粗粒度回顾（长程记忆的压缩层）。
 * 关键要求——有损压缩但不能丢"后续章节必须知道的事实"：
 * 人物最终处境、未解线索、关键道具去向。输入只有逐章摘要（不含正文），
 * 所以它是"摘要的摘要"，成本恒定在一卷之内。
 */
export function recapPrompt(args: {
  volumeTitle: string;
  volumeSummary: string;
  chapters: Array<{ title: string; summary: string }>;
}): { system: string; user: string } {
  const list = args.chapters.map((c) => `- 《${c.title}》：${c.summary}`).join('\n');
  return {
    system: ASSISTANT_BASE,
    user: `下面是一部小说「${args.volumeTitle}」各章的剧情摘要（按顺序），本卷整体走向：${args.volumeSummary || '（见摘要）'}。

请把这卷压缩成一段 250~400 字的「卷回本」，供作者续写下一卷时回顾。必须做到：
1. 保住因果链：本卷主线事件按序说清，因→果不许跳；
2. 人物收束时的处境逐个点名（身份、立场、伤势、关键物品归属、生死去留）——下一卷要靠这些开场；
3. 本卷结束时仍未解决的悬念、未回收的伏笔、悬而未决的冲突，单独列进"未决事项"；
4. 不复述章名，不评价，不生造摘要里没有的事实。

【各章摘要】
${list}

输出 JSON（${JSON_ONLY}）：
{ "recap": "回本正文，可用自然段；末尾以『未决事项：』起头列出未解决线索，分号分隔" }`,
  };
}
