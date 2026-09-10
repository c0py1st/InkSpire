import { ASSISTANT_BASE, JSON_ONLY } from './common';

/** 章末摘要 + 新设定探测（辅助模型跑，控制成本） */
export function summaryPrompt(args: {
  chapterTitle: string;
  content: string;
  knownCharacters: string[];
  /** 已建档人物的当前状态快照（姓名 -> 卡片 state），用于探测"状态变了但卡没更新" */
  characterStates?: Array<{ name: string; state: string }>;
}): { system: string; user: string } {
  const stateList = (args.characterStates ?? [])
    .map((c) => `- ${c.name}：${c.state || '（卡片未记录当前状态）'}`)
    .join('\n');
  return {
    system: ASSISTANT_BASE,
    user: `请为下面这章（${args.chapterTitle}）做三件事：

1. 写一段 100 字以内的剧情摘要，供后续章节写作时做前情参考：只记"发生了什么、人物关系/立场出现了什么变化"，不评价文笔。
2. 找出本章新出现的有名字人物或新设定要素（与已知名单比对）。
3. 对照下列已建档人物的"卡片记录的当前状态"，找出在本章中处境发生实质变化的人（受伤、死亡、身份/立场转变、关键物品得失、所在地点大变动）。只报有实质变化的；没有就给空数组。newState 是一句话的新状态，reason 是依据的剧情事实。

【本章正文】
${args.content}

已知人物名单：${args.knownCharacters.join('、') || '（暂无）'}
${stateList ? `\n人物卡当前状态登记：\n${stateList}` : ''}

输出 JSON（${JSON_ONLY}）：
{ "summary": "...", "newCharacters": [ { "name": "", "reason": "在本章扮演了什么" } ], "worldNotes": ["新设定一句话"], "stateChanges": [ { "name": "", "newState": "一句话新状态", "reason": "依据" } ] }`,
  };
}
