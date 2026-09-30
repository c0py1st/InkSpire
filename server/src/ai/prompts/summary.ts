import { ASSISTANT_BASE, JSON_ONLY } from './common';

/** 章末摘要 + 新设定探测（辅助模型跑，控制成本） */
export function summaryPrompt(args: {
  chapterTitle: string;
  content: string;
  knownCharacters: string[];
  /** 已建档人物的当前状态快照（姓名 -> 卡片 state），用于探测"状态变了但卡没更新" */
  characterStates?: Array<{ name: string; state: string }>;
  /** 本章大纲 beat：给了就额外做"正文 vs 大纲"偏移探测（阶段B3 大纲修订建议卡） */
  beat?: string;
}): { system: string; user: string } {
  const stateList = (args.characterStates ?? [])
    .map((c) => `- ${c.name}：${c.state || '（卡片未记录当前状态）'}`)
    .join('\n');
  return {
    system: ASSISTANT_BASE,
    user: `请为下面这章（${args.chapterTitle}）做四件事：

1. 写一段 100 字以内的剧情摘要，供后续章节写作时做前情参考：只记"发生了什么、人物关系/立场出现了什么变化"，不评价文笔。
2. 找出本章新出现的有名字人物或新设定要素（与已知名单比对）。
3. 对照下列已建档人物的"卡片记录的当前状态"，找出在本章中处境发生实质变化的人（受伤、死亡、身份/立场转变、关键物品得失、所在地点大变动）。只报有实质变化的；没有就给空数组。newState 是一句话的新状态，reason 是依据的剧情事实。
4. 提取本章值得记入「世界事件账本」的重要事件：判据是"十几章之后回看仍然要紧"——死亡、背叛、结案、启程到外地、权力/婚约/所有权的变更、大战爆发等。日常寒暄、单纯的情绪变化不算（那类走第 3 项）。每条 title 一句话，actors 列参与的人物/势力名，when 可给出故事内时间提示（如"三年初冬"，没有把握就留空）。最多 4 条，宁缺毋滥，没有就给空数组。
${args.beat ? `
5. 把正文与本章大纲要求核对：若正文实际走向与大纲要求发生了实质性偏离（关键事件缺失/新增/顺序调换），且这偏离已写成事实、后续章节只能顺着它走——给出一个更贴合已成事实的新 beat 文本（写法与原大纲要求一致，一到两句）；若只是正文没执行到位、应当改正文而不是改大纲，drifted 填 true 但不给 newBeat；完全没偏离则 drifted 填 false。` : ''}

【本章正文】
${args.content}
${args.beat ? `\n【本章大纲要求】\n${args.beat}\n` : ''}
已知人物名单：${args.knownCharacters.join('、') || '（暂无）'}
${stateList ? `\n人物卡当前状态登记：\n${stateList}` : ''}

输出 JSON（${JSON_ONLY}）：
{ "summary": "...", "newCharacters": [ { "name": "", "reason": "在本章扮演了什么" } ], "worldNotes": ["新设定一句话"], "stateChanges": [ { "name": "", "newState": "一句话新状态", "reason": "依据" } ], "events": [ { "title": "事件一句话", "detail": "展开（可缺省）", "actors": ["人物或势力"], "when": "故事内时间提示（可缺省）" } ]${args.beat ? ', "beatDrift": { "drifted": true, "problem": "偏离在哪（一句话）", "newBeat": "贴合已成事实的新大纲要求（可缺省）" }' : '' } }`,
  };
}
