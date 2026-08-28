/** 各任务共享的提示词片段与上下文拼装约定 */

export const JSON_ONLY = '只输出 JSON，不要输出任何解释文字或代码围栏。';

export interface StoryBibleBlock {
  premise: string;
  genre: string;
  coreConflict: string;
  endingVision: string;
  styleGuide: string;
  worldview: string;
}

export function storyBibleSection(b: StoryBibleBlock): string {
  return [
    '【故事圣经（最高约束，任何生成不得与之矛盾）】',
    `题材：${b.genre}`,
    `一句话内核：${b.premise}`,
    `主线冲突：${b.coreConflict}`,
    `结局走向（不可更改的大方向）：${b.endingVision}`,
    `文风约定：${b.styleGuide}`,
    b.worldview ? `世界观设定：\n${b.worldview}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function charactersSection(chars: { name: string; role: string; personality: string; background: string; relations: string; speechHabit?: string; state?: string }[]): string {
  if (!chars.length) return '';
  return (
    '【人物卡】\n' +
    chars
      .map(
        (c) =>
          `- ${c.name}（${c.role}）：性格 ${c.personality}；背景 ${c.background}；关系 ${c.relations}` +
          (c.speechHabit ? `；说话特点 ${c.speechHabit}` : '') +
          (c.state ? `；当前状态 ${c.state}` : ''),
      )
      .join('\n')
  );
}

export const CREATOR_BASE = [
  '你是一位资深长篇小说作家与结构编辑，工于中文叙事，擅长把大纲落实为有画面感、有情绪张力的正文。',
  '你最重要的职业操守：严格遵循给定的大纲与设定，绝不擅自改变剧情走向、人物立场或结局。',
  '正文里不出现任何"本章"字样、作者旁白或元说明。',
].join('\n');

export const ASSISTANT_BASE = '你是一个严谨的中文长篇小说项目助理编辑，输出精炼、格式严格、从不擅自发挥。';
