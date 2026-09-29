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

/**
 * 人物状态时间线的一个节点：采纳某章归档产生的「状态变更」建议时写入。
 * chapterId 形如 v01c003——零填充使字典序恰好等于阅读序，
 * 因此"写到某章时该人物处于什么状态"可以直接比字符串，无需加载大纲。
 */
export interface StateEntry {
  chapterId: string;     // 该状态由哪一章的归档产生（必填）
  chapterTitle: string;
  state: string;         // 该章末尾时点的人物状态
  reason?: string;       // 剧情依据（建议的 note）
  at: string;            // 落盘时间 ISO
}

export interface CharacterCard {
  id: string;
  name: string;
  role: string;          // 主角/配角/反派…
  personality: string;
  background: string;
  relations: string;
  speechHabit?: string;  // 口癖、说话方式
  state?: string;        // 当前状态（=时间线最新节点，冗余保留供旧数据与提示词直接用）
  stateHistory?: StateEntry[];  // 按章的状态时间线（追加式；旧卡可能没有）
}

const CHAPTER_ID_RE = /^v\d{2,}c\d{3,}$/;

/**
 * 写/查第 chapterId 章时，该人物"当时"的状态。
 * - 没有时间线的旧卡 → 退回当前值（行为与从前逐字节一致）；
 * - 有时间线但没有早于本章的节点 → undefined（第一章之前无状态可述，
 *   也防止重写旧章时把后文才有的状态剧透进去）。
 * 同章多次采纳（重归档）时以推入顺序靠后的为准。
 */
export function stateAtChapter(card: CharacterCard, chapterId: string): string | undefined {
  const hist = card.stateHistory;
  if (!Array.isArray(hist) || hist.length === 0) return card.state;
  let best: StateEntry | undefined;
  for (const e of hist) {
    if (!e?.state?.trim() || typeof e.chapterId !== 'string' || !CHAPTER_ID_RE.test(e.chapterId)) continue;
    if (e.chapterId >= chapterId) continue;
    if (!best || e.chapterId >= best.chapterId) best = e;
  }
  return best?.state;
}

/** 采纳「状态变更」建议 = 更新当前值 + 追加时间线节点（来源章缺失时只更新当前值） */
export function applyStateSuggestion(card: CharacterCard, sug: Suggestion): void {
  card.state = sug.content;
  if (!sug.sourceChapterId || !CHAPTER_ID_RE.test(sug.sourceChapterId)) return;
  const hist = (card.stateHistory = Array.isArray(card.stateHistory) ? card.stateHistory : []);
  const last = hist[hist.length - 1];
  if (last && last.chapterId === sug.sourceChapterId && last.state === sug.content) return; // 重复采纳同一观察
  hist.push({
    chapterId: sug.sourceChapterId,
    chapterTitle: sug.sourceChapterTitle ?? '',
    state: sug.content,
    ...(sug.note?.trim() ? { reason: sug.note.trim() } : {}),
    at: new Date().toISOString(),
  });
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
  /** 派生字段（GET /api/settings 下发）：真实密钥从不出网。保存时留空 apiKey = 保持已存密钥 */
  hasKey?: boolean;
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
  recaps: Record<string, VolumeRecap>; // volumeId -> 卷回本（可重建缓存）
  suggestions: Suggestion[];
  foreshadows: Foreshadow[];
}

/**
 * 卷回本：已完成卷的压缩回顾，长程记忆的粗粒度层。
 * fingerprint 由该卷全部章摘要算出——章摘要一变即失效，
 * 注入时自动退回逐章摘要，绝不拿过期回本当事实。
 */
export interface VolumeRecap {
  recap: string;
  fingerprint: string;
  updatedAt: string;
}

/**
 * 卷摘要指纹：对该卷「有序 (章id, 章摘要)」序列做 FNV-1a。
 * 纯函数、跨端一致——前端据此标注"卷回本已过期"，后端据此决定注入回本还是逐章。
 */
export function recapFingerprint(vol: Volume, summaries: Record<string, string>): string {
  let h = 0x811c9dc5;
  const s = vol.chapters.map((c) => `${c.id}\u0000${summaries[c.id] ?? ''}`).join('\u0001');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
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

/* ---------------- 对话持久化（data/<书>/chat.json） ---------------- */

/** ReAct 工具轨迹的落盘形态（恢复后一律视为已完成） */
export interface ChatStepRecord { name: string; detail: string; done: boolean }
/** 对话提案卡的落盘形态：未决策的提案刷新后仍可点采纳/放弃 */
export interface ChatProposalRecord {
  id: number;
  kind: 'chapter' | 'summary';
  chapterId: string;
  content: string;
  decided: boolean;
}
export interface ChatMessageRecord {
  role: 'user' | 'assistant';
  content: string;
  steps?: ChatStepRecord[];
  proposals?: ChatProposalRecord[];
  /** 落盘时间 ISO；仅记录用途，界面不显示 */
  at: string;
}

/* ---------------- Agent 工具调用（OpenAI 兼容协议） ---------------- */

/** 模型发起的一次工具调用（arguments 是 JSON 字符串，由服务端解析校验） */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** 发给模型的函数 schema 定义 */
export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
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

/** 一致性检查的一条问题（severity: high | medium | low）
 *  verified：服务端对 quote 做的引证落地校验——'exact' 逐字命中 / 'loose' 忽略空白命中 /
 *  false 正文里找不到（引文系模型编造，UI 须降级展示、不得当作确定问题） */
export interface ConsistencyIssue {
  severity: string;
  quote: string;
  description: string;
  verified?: 'exact' | 'loose' | false;
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
