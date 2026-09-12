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

/** 向导生成任务只需要卷的标题与梗概（不依赖章节结构） */
export interface VolumeBrief {
  title: string;
  summary: string;
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
  wordsPerChapter?: number;   // 每章目标字数（向导里设置，用于编辑器进度提示）
}

export interface Suggestion {
  id: string;
  kind: 'character' | 'world' | 'state';   // state = 已建档人物的当前状态变更建议
  name: string;
  content: string;       // 建议补充的设定内容原文（state 类 = 新状态一句话）
  note?: string;         // 补充说明（state 类 = 剧情依据）
  sourceChapterId?: string;    // 由哪一章的归档产生（旧数据可能没有）
  sourceChapterTitle?: string;
  createdAt: string;
}

/** 伏笔登记：埋设章 -> 内容 -> 计划回收章 -> 状态。生成与检查时按章注入 */
export interface Foreshadow {
  id: string;
  setupChapterId: string;    // 埋设（或揭示线索）的章
  content: string;           // 伏笔内容一句话
  payoffChapterId?: string;  // 计划回收的章（可留空=未定）
  status: 'open' | 'resolved' | 'abandoned';
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
  foreshadows: Foreshadow[];
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
  /** 迭代改写：上一版提案文本 + 针对它的新反馈，一起回传给模型定向改进 */
  prevText?: string;
}

/** 前文检索命中：章节 + 正文内偏移 + 上下文片段 */
export interface SearchHit {
  chapterId: string;
  chapterTitle: string;
  volumeTitle: string;
  /** 命中点在章节正文（去 frontmatter）内的偏移，供编辑器定位 */
  offset: number;
  /** 带上下文的一行摘录，命中词用〔〕包裹 */
  snippet: string;
}

/** 一致性检查的一条问题（severity: high | medium | low） */
export interface ConsistencyIssue {
  severity: string;
  quote: string;
  description: string;
}

/** 后台生成队列的单章结果（status 轮询与 SSE 事件的线上形状） */
export interface GenChapterResult {
  chapterId: string;
  status: 'done' | 'skipped' | 'error' | 'cancelled';
  wordCount?: number;
  /** 自动补完一次后仍达输出上限：结尾可能不完整 */
  truncated?: boolean;
  /** 自动归档（摘要+建议探测）是否成功 */
  archived?: boolean;
  error?: string;
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
