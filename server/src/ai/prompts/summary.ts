import { ASSISTANT_BASE, JSON_ONLY } from './common';

/** 章末摘要 + 新设定探测（辅助模型跑，控制成本） */
export function summaryPrompt(args: {
  chapterTitle: string;
  content: string;
  knownCharacters: string[];
}): { system: string; user: string } {
  return {
    system: ASSISTANT_BASE,
    user: `请为下面这章（${args.chapterTitle}）做两件事：

1. 写一段 100 字以内的剧情摘要，供后续章节写作时做前情参考：只记"发生了什么、人物关系/立场出现了什么变化"，不评价文笔。
2. 找出本章新出现的有名字人物或新设定要素（与已知名单比对）。

【本章正文】
${args.content}

已知人物名单：${args.knownCharacters.join('、') || '（暂无）'}

输出 JSON（${JSON_ONLY}）：
{ "summary": "...", "newCharacters": [ { "name": "", "reason": "在本章扮演了什么" } ], "worldNotes": ["新设定一句话"] }`,
  };
}
