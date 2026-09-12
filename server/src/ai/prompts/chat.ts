import type { Outline } from '../../../../shared/src/types';
import { storyBibleSection } from './common';

/** 批注抽屉里的自由问答（带当前章节上下文） */
export function chatPrompt(args: {
  outline: Outline;
  worldview: string;
  characters: string;     // 已格式化的人物卡区块
  summaries: string;      // 前情摘要
  foreshadows?: string;   // 伏笔登记表文本
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
回答格式要求：直接切入正题，先给结论或建议，再给必要的理由；像编辑口头答复，不要展示"让我想想""首先分析……"这类中间推理过程，不要无关背景铺陈。

${storyBibleSection({
  premise: o.premise,
  genre: o.genre,
  coreConflict: o.coreConflict,
  endingVision: o.endingVision,
  styleGuide: o.styleGuide,
  worldview: args.worldview,
})}
${args.characters ? `\n${args.characters}` : ''}
${args.summaries ? `\n【前情摘要】\n${args.summaries}` : ''}
${args.foreshadows ? `\n【伏笔登记表（未回收的伏笔清单，回答涉及剧情规划时参考）】\n${args.foreshadows}` : ''}`,
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
