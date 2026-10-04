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
  /** 网文结构字段（可选，仅 webnovelMode 下编辑与注入；缺省 = 逐字节旧行为） */
  payoffPoint?: string;  // 本章爽点：读者情绪的兑现点
  chapterHook?: string;  // 章末钩子：驱动追读的悬念落点（同类钩子会做跨章去重）
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
  webnovelMode?: boolean;     // 网文模式：开启大纲页的爽点/钩子字段与节奏红线告警（默认关，老书零影响）
}

export interface Suggestion {
  id: string;
  kind: 'character' | 'world' | 'state' | 'outline';   // state=人物当前状态变更；outline=本章 beat 偏离修订
  name: string;              // outline 类 = 「《章题》·修订大纲」展示名
  content: string;           // 建议补充的设定内容原文（state=新状态一句话；outline=新 beat 文本）
  note?: string;             // 补充说明（state=剧情依据；outline=偏离描述）
  sourceChapterId?: string;    // 由哪一章的归档产生（旧数据可能没有；outline 类缺它则无法定位）
  sourceChapterTitle?: string;
  createdAt: string;
}

/**
 * 世界事件账本的一条（data/<书>/events.json，真相源、数组形）：
 * 故事世界里发生的、跨章仍有意义的事实——不同于人物状态（谁怎么样），事件记"发生了什么"。
 * 挂在来源章下排序（零填充章 id 字典序=阅读序）；whenInStory 为故事内时刻的自由文本
 * （"三年初冬""断臂之次日"，架空历法亦可），actors 是参与人物/势力的自由名单。
 */
export interface StoryEvent {
  id: string;
  chapterId: string;               // 来源章（必填，定位与排序键）
  title: string;                   // 事件一句话
  detail?: string;                 // 展开说明
  actors?: string[];               // 参与人物/势力（自由文本名单）
  whenInStory?: string;            // 故事内时刻提示（自由文本）
  source: 'auto' | 'manual';       // 归档提取 vs 作者补记
  at: string;                      // 落盘时间 ISO
}

/**
 * 世界书（Lorebook）条目（data/<书>/lorebook.json，真相源、数组形）：
 * "设定按需激活"——正文生成时只在章级语料命中触发词时，才把该条设定注入 prompt，
 * 避免世界观全文每章都吃预算。参考 SillyTavern 的角色书机制（只抄思想不抄代码，AGPL）。
 * 语义要点：
 * - keys 用**子串**匹配（中文没有词边界，不设全词匹配）；constant 常驻条豁免触发但吃预算；
 * - contract 大纲契约条豁免预算（力量体系铁律这类，少而精，溢出也不丢）；
 * - scope 限定生效章区间（含端点，按阅读序）；volumeId 限卷；都不填=全书；
 * - priority 大者优先填预算，同值按文件序（稳定）。
 */
export interface LoreEntry {
  id: string;
  title: string;                 // 条名（展示与留痕用）
  keys: string[];                // 触发词，任一在语料中出现即激活
  content: string;               // 注入的设定正文
  scope?: {
    volumeId?: string;           // 仅该卷生效
    chapterFrom?: string;        // 自本章（含，阅读序）起生效
    chapterTo?: string;          // 至本章（含）生效
  };
  constant?: boolean;            // 常驻：不查触发词直接激活
  contract?: boolean;            // 大纲契约：豁免预算裁剪
  priority?: number;             // 预算竞争排序，默认 0
  enabled?: boolean;             // 临时停用开关，缺省视为 true
}

/** 世界书激活留痕的一条（可重建缓存 .index/lore-activated.json，只记摘要不进真相源） */
export interface LoreTraceItem { id: string; title: string; chars: number }
/** style* 段：A2 风格范文的激活/溢出（与 lorebook 同文件分键存储，预算各自独立） */
export interface LoreTraceEntry {
  activated: LoreTraceItem[];
  dropped: LoreTraceItem[];
  styleActivated?: LoreTraceItem[];
  styleDropped?: LoreTraceItem[];
  at: string;
}

/** 采纳大纲修订建议：把 content 写回 sourceChapterId 章的 beat。命中返回 true（就地修改传入的 outline） */
export function applyOutlineSuggestion(outline: Outline, sug: Suggestion): boolean {
  if (!sug.sourceChapterId) return false;
  for (const v of outline.volumes) {
    const ch = v.chapters.find((c) => c.id === sug.sourceChapterId);
    if (ch) { ch.beat = sug.content; return true; }
  }
  return false;
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

/* ---------------- 体检与用量（前后端共用的线上形状） ---------------- */

export interface CacheCounters { calls: number; prompt: number; cached: number; miss: number }
export interface CacheStatEntry {
  at: string;               // ISO 时间
  source: string;           // prose | prose-cont | summary | recap | chat | beats | consistency
  chapterId?: string;
  prompt: number;
  cached: number;
  miss: number;
}
/** 模型调用 usage 与前缀缓存命中统计（data/<书>/.index/cache-stats.json，可重建观测缓存） */
export interface CacheStats {
  version: 1;
  totals: CacheCounters;
  bySource: Record<string, CacheCounters>;
  recent: CacheStatEntry[];
}

/** 体检报告：GET /api/projects/:slug/health 的响应 */
export interface HealthReport {
  progress: { total: number; archived: number; totalWords: number };
  foreshadow: {
    open: number; resolved: number; abandoned: number;
    overdue: Array<{ id: string; content: string; payoffChapterId: string; payoffTitle: string }>;
  };
  appearances: Array<{ name: string; role: string; chapters: number; stateNodes: number }>;
  l0: {
    high: number; medium: number; low: number;
    chapters: Array<{ chapterId: string; title: string; high: number; medium: number; low: number }>;
  };
  usage: CacheStats;
  /** 网文节奏分析（E3）：始终计算，UI 仅在 webnovelMode 下展示 */
  pacing: WebnovelPacing;
}

/** 一段"爽点断档"：从 fromTitle 到 toTitle 连续 length 章没标爽点 */
export interface PacingDryRun { fromChapterId: string; toChapterId: string; length: number }

export interface WebnovelPacing {
  chapters: number;          // 大纲总章数
  payoffChapters: number;    // 标了爽点的章数
  hookChapters: number;      // 标了章末钩子的章数
  longestDry: number;        // 最长爽点断档（连续无爽点章数）
  warnAfter: number;         // 断档红线阈值：longestDry ≥ 此值应告警
  dryRuns: PacingDryRun[];   // 断档区间（按长度降序，前 5 段，仅 ≥2 章的）
  missingHook: Array<{ chapterId: string; title: string }>;  // 缺钩子的章（前 12 个）
}

/* ---------------- 读者模拟评审（E2） ---------------- */

/** 一条抱怨：quote 必须逐字摘自正文，服务端做引证落地校验 */
export interface ReviewGrievance {
  quote: string;
  issue: string;
  verified?: 'exact' | 'loose' | false;   // 同 ConsistencyIssue 的引证验真口径
}
export interface ReviewPersona {
  name: string;
  overall: number;              // 1~10
  wouldContinue: boolean;       // 愿不愿意接着读下去
  praise: string;               // 最多一句好话
  grievances: ReviewGrievance[];
}
export interface ReaderReview {
  personas: ReviewPersona[];
  verdict: string;              // 一句话总评
  topFixes: string[];           // ≤3 条按影响排序的可执行修改
  highlights?: ReviewHighlight[];  // 评审顺带挑出的"值得模仿"段落（A2 提取入口；缺省 = 旧结构不变）
}

/**
 * 评审挑出的风格范文候选（A2）：excerpt 必须逐字摘自本章正文，
 * 服务端 verifyQuote 验真——未通过的直接丢弃，范文库不收模型编造的"原文"。
 * keys 是场景触发词（与 F 世界书同语义），供写同类场景的章时命中注入。
 */
export interface ReviewHighlight {
  excerpt: string;
  keys: string[];
  sceneTag?: string;            // 场景归类自由文本（打斗/对话/环境/心理…）
  verified?: 'exact' | 'loose'; // 验真通过的口径（未通过的根本不出现）
}

/**
 * 风格范文库的一条（data/<书>/exemplars.json，真相源、数组形）：
 * 本书已被读者验证过的好段落，写章时按触发词命中注入 prompt 作笔法样本。
 * 字段与 LoreEntry 结构兼容（title/keys/content/constant/enabled），注入复用 activateLore。
 */
export interface StyleExemplar {
  id: string;
  title: string;                // 展示名（收录时自动生成「《章题》·场景标签」）
  content: string;              // 范文正文（逐字验真的原文摘录）
  keys: string[];               // 触发词——与 F 同语义（子串命中章级语料）
  sceneTag?: string;
  sourceChapterId?: string;
  sourceChapterTitle?: string;
  constant?: boolean;           // 常驻：每章都注入（吃范文预算）
  enabled?: boolean;            // 缺省 true
  at: string;
}

/* ---------------- 黄金三章评审（E4） ---------------- */

export type GoldenVerdict = 'GO' | 'REVISE' | 'REWRITE';

export interface GoldenChapter {
  index: number;                       // 第几章（1 起）
  title: string;
  chapterId: string;
  verdict: GoldenVerdict;
  hookNote: string;                    // 章末钩子/追读力一句评
  grievances: ReviewGrievance[];       // 带引证，服务端验真
}
export interface GoldenThreeReview {
  chapters: GoldenChapter[];
  retentionScore: number;              // 0~10：三章合力把读者留住的把握
  overall: string;                     // 一句话开篇诊断
  fixes: string[];                     // 按影响排序
}

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
