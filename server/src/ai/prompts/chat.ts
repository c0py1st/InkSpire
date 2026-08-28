import type { Outline } from '../../../../shared/src/types';
import { CREATOR_BASE, storyBibleSection } from './common';

/** 批注抽屉里的自由问答（带当前章节上下文） */
export function chatPrompt(args: {
  outline: Outline;
  worldview: string;
  characters: string;     // 已格式化的人物卡区块
  summaries: string;      // 前情摘要
  chapterTitle?: string;
  chapterBeat?: string;
  chapterContent?: string;
  selection?: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  question: string;
}): { system: string; user: string } {
  const o = args.outline;
  return {
    system: `你是本书的驻场编辑，与作者一起打磨这部小说。你了解全书设定与大纲，回答要具体、可操作，直接引用设定与正文细节。
你有权依据大纲指出问题，但永远不擅自替作者决定剧情；涉及改动建议时给理由和方案。

${storyBibleSection({
  premise: o.premise,
  genre: o.genre,
  coreConflict: o.coreConflict,
  endingVision: o.endingVision,
  styleGuide: o.styleGuide,
  worldview: args.worldview,
})}
${args.characters ? `\n${args.characters}` : ''}
${args.summaries ? `\n【前情摘要】\n${args.summaries}` : ''}`,
    user: `${args.chapterTitle ? `当前正在编辑：《${args.chapterTitle}》` : ''}${
      args.chapterBeat ? `（本章大纲：${args.chapterBeat}）` : ''
    }
${args.chapterContent ? `\n【当前章节全文】\n${args.chapterContent}\n` : ''}${
      args.selection ? `\n【作者当前选中的片段】\n"""${args.selection}"""\n` : ''
    }
${args.history.length ? `\n【此前对话】\n${args.history.map((m) => `${m.role === 'user' ? '作者' : '编辑'}：${m.content}`).join('\n')}\n` : ''}
作者的问题是：
${args.question}`,
  };
}
