import type { Kernel } from '../../../../shared/src/types';
import { CREATOR_BASE, JSON_ONLY } from './common';

/** 第 2 步：把内核展开成各卷大纲 */
export function volumesPrompt(kernel: Kernel, volumeCount: number): { system: string; user: string } {
  return {
    system: CREATOR_BASE,
    user: `基于以下故事内核，设计 ${volumeCount} 卷的分卷大纲。

故事内核：
- 题材：${kernel.genre}
- 一句话内核：${kernel.premise}
- 主线冲突：${kernel.coreConflict}
- 结局走向：${kernel.endingVision}
- 文风约定：${kernel.styleGuide}

要求：
1. 各卷剧情弧必须递进，最终指向"结局走向"，不得引入与内核无关的新主线。
2. 每卷给一个有记忆点的中文标题（不超过 12 字）。
3. 卷与卷之间要有明确的转折钩子。

输出 JSON（${JSON_ONLY}）：
{ "volumes": [ { "title": "卷标题", "summary": "本卷剧情弧，120 字以内" } ] }`,
  };
}
