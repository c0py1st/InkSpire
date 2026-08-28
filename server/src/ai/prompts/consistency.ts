import type { CharacterCard } from '../../../../shared/src/types';
import { ASSISTANT_BASE, JSON_ONLY } from './common';

/** 一致性检查：本章正文 vs 设定集 + 前情 */
export function consistencyPrompt(args: {
  chapterTitle: string;
  content: string;
  beat: string;
  characters: CharacterCard[];
  summaries: string;
  worldview: string;
}): { system: string; user: string } {
  return {
    system: ASSISTANT_BASE,
    user: `请对第《${args.chapterTitle}》章做一致性检查，只找问题、不提修改后的文本。

本章大纲要求：${args.beat}

【人物卡】
${args.characters.map((c) => `- ${c.name}（${c.role}）：${c.personality}；${c.background}；关系：${c.relations}${c.state ? `；当前状态：${c.state}` : ''}`).join('\n') || '（空）'}

【世界观】
${args.worldview || '（空）'}

【前情摘要】
${args.summaries || '（无）'}

【本章正文】
${args.content}

逐项检查：1) 人物性格/口癖/状态是否与卡片矛盾；2) 是否与前情摘要的时间线、事实冲突；3) 是否使用了与世界观不符的器物/制度/称谓；4) 是否偏离本章大纲要求。

输出 JSON（${JSON_ONLY}）：
{ "issues": [ { "severity": "high|medium|low", "quote": "正文中的问题原句（截取不超过 40 字）", "description": "问题说明" } ] }
没有问题则输出 { "issues": [] }。`,
  };
}
