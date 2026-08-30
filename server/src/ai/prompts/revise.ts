import type { CharacterCard } from '../../../../shared/src/types';
import { CREATOR_BASE } from './common';

/** 选区改写提案（润色/扩写/缩写/换个写法/自定义指令） */
export function revisePrompt(args: {
  chapterTitle: string;
  chapterBeat: string;
  styleGuide: string;
  cast: CharacterCard[];
  before: string;   // 选区前文
  after: string;    // 选区后文
  original: string; // 选区原文
  kind: string;
  instruction: string;
}): { system: string; user: string } {
  const kindRule: Record<string, string> = {
    polish: '润色：提升文字质感与节奏，但保持情节、信息量与篇幅大致不变。',
    expand: '扩写：把这段展开得更充分（补充动作细节、环境与心理），篇幅约增至 1.5~2 倍，不得引入新事件。',
    condense: '缩写：压缩到原来的一半左右，只保留必要的信息与张力。',
    rewrite: '换个写法：同样的情节内容，用明显不同的笔法重写（比如换视角质感、换节奏）。',
    custom: '按用户的自定义要求改写这一段。',
  };
  return {
    system: CREATOR_BASE,
    user: `你在一部连载小说的第 ${args.chapterTitle} 章中，需要改写一个片段。

本章大纲要求：${args.chapterBeat}
全书文风约定：${args.styleGuide}
${args.cast.length ? `涉及人物：${args.cast.map((c) => `${c.name}（${c.personality}）`).join('；')}` : ''}

【选区前文】
…${args.before.slice(-400)}

【待改写片段】
${args.original}

【选区后文】
${args.after.slice(0, 300)}…

任务：${kindRule[args.kind] ?? kindRule.custom}
${args.instruction ? `用户的具体要求：${args.instruction}` : ''}

输出要求：
- 只输出改写后的正文片段本身，不要解释、不要引号包裹、不要前后空行。
- 若片段位于自然段开头，以两个全角空格（　　）缩进。
- 改写结果必须能与前后文自然衔接。`,
  };
}
