import type { Kernel, Volume } from '../../../../shared/src/types';
import { ASSISTANT_BASE, JSON_ONLY } from './common';

/** 第 4 步：设定集初稿（人物卡 + 世界观） */
export function biblePrompt(kernel: Kernel, volumes: Volume[]): { system: string; user: string } {
  const volLines = volumes.map((v, i) => `${i + 1}. ${v.title}：${v.summary}`).join('\n');
  return {
    system: ASSISTANT_BASE,
    user: `基于以下内核与分卷大纲，产出这本书的设定集初稿。

内核：题材 ${kernel.genre}；内核 ${kernel.premise}；主线冲突 ${kernel.coreConflict}；结局 ${kernel.endingVision}；文风 ${kernel.styleGuide}

分卷大纲：
${volLines}

要求：
1. characters：6~10 张人物卡，覆盖主角、核心对手、关键配角。姓名符合题材气质且互相不重名。
2. 每张卡包含：name/role/personality/background/relations/speechHabit，其中 personality 与 speechHabit 要具体到"能据其对台词"的程度。
3. worldview：300 字以内的世界观骨架（时代、规则体系、势力格局），只写会实际影响剧情的部分。

输出 JSON（${JSON_ONLY}）：
{
  "characters": [ { "name": "", "role": "", "personality": "", "background": "", "relations": "", "speechHabit": "" } ],
  "worldview": "..."
}`,
  };
}
