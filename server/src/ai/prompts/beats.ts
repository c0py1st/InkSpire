import type { Kernel } from '../../../../shared/src/types';
import { CREATOR_BASE, JSON_ONLY } from './common';

/** 第 3 步：把某一卷展开成逐章 beat（也可以运行时对单卷重新细化） */
export function beatsPrompt(
  kernel: Kernel,
  volumeTitle: string,
  volumeSummary: string,
  chapterCount: number,
  neighboringVolumes: Array<{ title: string; summary: string }>,
): { system: string; user: string } {
  const neighbor = neighboringVolumes.length
    ? '\n相邻卷概要（用于衔接，不得越界展开）：\n' + neighboringVolumes.map((v) => `- ${v.title}：${v.summary}`).join('\n')
    : '';
  return {
    system: CREATOR_BASE,
    user: `把下面这一卷展开成 ${chapterCount} 章的逐章细纲。

故事内核：
- 一句话内核：${kernel.premise}
- 主线冲突：${kernel.coreConflict}
- 结局走向：${kernel.endingVision}
- 文风约定：${kernel.styleGuide}

本卷标题：${volumeTitle}
本卷剧情弧：${volumeSummary}${neighbor}

要求：
1. 每章 beat 是"本章实际发生什么"的硬约束描述：包含关键事件、出场人物、情绪转折与章末钩子，60~120 字。
2. beat 之间必须因果衔接，整卷收束到卷摘要。
3. pov 给出本章视角人物名；characters 列出本章出场人物名（2~4 个）。
4. 章节标题 2~8 字，具体、有画面，不用"第X章"前缀。

输出 JSON（${JSON_ONLY}）：
{ "chapters": [ { "title": "章名", "beat": "...", "pov": "...", "characters": ["..."] } ] }`,
  };
}
