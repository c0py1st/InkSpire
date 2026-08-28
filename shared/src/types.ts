/**
 * 墨阁共享类型：server 与 web 都从这里 import。
 * 修改这里的结构 = 同时改掉了 agent 的"契约"与界面的数据模型。
 */

export type ChapterStatus = 'todo' | 'draft' | 'revised';

export interface ChapterBeat {
  id: string;            // 形如 v01c003，同时是章节文件名
  title: string;
  beat: string;          // 本章事件梗概 —— agent 写作时的硬约束
  pov?: string;          // 视角人物
  characters?: string[]; // 出场人物名
  status: ChapterStatus;
  wordCount?: number;
}

export interface Volume {
  id: string;            // v01
  title: string;
  summary: string;       // 本卷剧情弧概述
  chapters: ChapterBeat[];
}

export interface Outline {
  premise: string;       // 一句话卖点
  genre: string;
  coreConflict: string;  // 主线冲突
  endingVision: string;  // 结局走向（agent 不得偏离）
  styleGuide: string;    // 文风约定：叙事人称、节奏、禁忌等
  volumes: Volume[];
}

export interface CharacterCard {
  id: string;
  name: string;
  role: string;          // 主角/配角/反派…
  personality: string;
  background: string;
  relations: string;
  speechHabit?: string;  // 口癖、说话方式
  state?: string;        // 当前状态（伤势、立场变化等，agent 记忆闭环可更新）
}

export interface ProjectMeta {
  slug: string;
  title: string;
  logline: string;
  createdAt: string;
  updatedAt: string;
}

export interface Suggestion {
  id: string;
  kind: 'character' | 'world';
  name: string;
  content: string;       // 建议补充的设定内容原文
  createdAt: string;
}

/** 创作向导中间产物 */
export interface Kernel {
  premise: string;
  genre: string;
  coreConflict: string;
  endingVision: string;
  styleGuide: string;
  volumeSummariesDraft?: string[]; // 简要分卷走向，供下一轮展开
}

/* ---------------- 模型配置 ---------------- */

export interface ProviderProfile {
  id: string;
  name: string;
  baseURL: string;       // 例：https://api.deepseek.com/v1
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  contextWindow?: number; // 单位 token，用于记忆预算估算
}

export interface AppConfig {
  providers: ProviderProfile[];
  creativeId: string | null;   // 创作模型槽位指向的 provider id
  assistId: string | null;     // 辅助模型槽位
  mockMode: boolean;           // 演示模式：不调用真实 API
}

/* ---------------- 运行时载荷 ---------------- */

/** 打开一个作品时一次性下发的全量数据 */
export interface Bundle {
  meta: ProjectMeta;
  outline: Outline | null;               // 可能尚未生成
  characters: CharacterCard[];
  worldview: string;
  summaries: Record<string, string>;   // chapterId -> 摘要
  suggestions: Suggestion[];
}

export interface ChapterFile {
  id: string;
  title: string;
  status: ChapterStatus;
  content: string;       // 正文（不含 frontmatter）
}

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

export type ProposalKind = 'polish' | 'expand' | 'condense' | 'rewrite' | 'custom';

export interface ProposalRequest {
  chapterId: string;
  start: number;
  end: number;
  original: string;
  instruction: string;
  kind: ProposalKind;
}

export const PROPOSAL_LABELS: Record<ProposalKind, string> = {
  polish: '润色',
  expand: '扩写',
  condense: '缩写',
  rewrite: '换个写法',
  custom: '自定义',
};

/* ---------------- 内置预设 ---------------- */

export const PROVIDER_PRESETS = [
  { label: 'DeepSeek 官方', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
  { label: 'SiliconFlow 硅基流动', baseURL: 'https://api.siliconflow.cn/v1', model: '' },
  { label: 'Moonshot Kimi', baseURL: 'https://api.moonshot.cn/v1', model: '' },
  { label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', model: '' },
  { label: '本地 Ollama', baseURL: 'http://localhost:11434/v1', model: '' },
];

export function defaultConfig(): AppConfig {
  return { providers: [], creativeId: null, assistId: null, mockMode: false };
}
