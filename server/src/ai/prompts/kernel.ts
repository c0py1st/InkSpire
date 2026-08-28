import { CREATOR_BASE, JSON_ONLY } from './common';

/** 第 1 步：把用户的自由提示词提炼成故事内核 */
export function kernelPrompt(ideaPrompt: string, scale: { volumeCount: number; chaptersPerVolume: number; wordsPerChapter: number }): { system: string; user: string } {
  return {
    system: CREATOR_BASE,
    user: `下面是作者的开书构想。请把它提炼成一份"故事内核"。

作者构想（可能包含题材、人物、世界观、想要的桥段，信息可能零散甚至矛盾——矛盾时选更有张力的解读并在内核里理顺）：
"""
${ideaPrompt}
"""

本书规模：约 ${scale.volumeCount} 卷，每卷约 ${scale.chaptersPerVolume} 章，每章约 ${scale.wordsPerChapter} 字。

请输出 JSON（${JSON_ONLY}）：
{
  "premise": "一句话卖点，不超过 40 字",
  "genre": "题材/类型标签",
  "coreConflict": "贯穿全书的主线冲突，两三句",
  "endingVision": "结局走向，两三句",
  "styleGuide": "文风约定：叙事人称、句式节奏、氛围基调、明确禁忌（如避免现代词），三到五句",
  "volumeSummariesDraft": ["每一卷的剧情弧概述，共 ${scale.volumeCount} 条，每条两三句，各卷之间要有递进"]
}`,
  };
}
