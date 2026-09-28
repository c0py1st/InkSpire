import type {
  ChapterBeat, CharacterCard, Foreshadow, Outline, VolumeRecap,
} from '../../../shared/src/types';
import { recapFingerprint } from '../../../shared/src/types';
import type { ChapterContext } from './prompts/prose';

/**
 * 上下文组装：决定"写第 N 章时，模型能看到什么"。
 * 预算策略：优先级为 本章约束 > 人物卡 > 前一章结尾 > 前情摘要（由近及远截断）。
 */

export function locateChapter(
  outline: Outline,
  chapterId: string,
): { volumeIndex: number; chapterIndex: number; volume: Outline['volumes'][number]; chapter: ChapterBeat } {
  for (let vi = 0; vi < outline.volumes.length; vi++) {
    const vol = outline.volumes[vi];
    const ci = vol.chapters.findIndex((c) => c.id === chapterId);
    if (ci >= 0) return { volumeIndex: vi, chapterIndex: ci, volume: vol, chapter: vol.chapters[ci] };
  }
  throw new Error(`大纲中找不到章节 ${chapterId}`);
}

const SUMMARY_BUDGET_CHARS = 12000;   // 前情摘要的总字数预算
const PREV_TAIL_CHARS = 1500;

export function buildSummariesText(
  outline: Outline,
  summaries: Record<string, string>,
  upToChapterId: string,
  recaps?: Record<string, VolumeRecap>,
): string {
  // 分层前情：目标之前的整卷若已有"新鲜"卷回本，用一条粗粒度回顾顶替该卷全部逐章摘要；
  // 当前卷、以及回本缺失/过期（指纹不符）的卷，仍逐章细粒度注入。
  // 不传 recaps 时退回纯逐章，与旧行为逐字节一致（向后兼容）。
  const lines: string[] = [];
  let budget = SUMMARY_BUDGET_CHARS;
  // 先按阅读顺序生成"条目"（章 或 卷回本），再从最近往旧填充预算——
  // 与旧实现一样保证最近章节/最新卷回本优先留在预算内。
  type Entry = { kind: 'ch'; label: string; text: string } | { kind: 'recap'; label: string; text: string };
  const ordered: Entry[] = [];
  let reached = false;
  for (const vol of outline.volumes) {
    if (reached) break;
    const targetInVol = vol.chapters.some((c) => c.id === upToChapterId);
    if (targetInVol) {
      // 目标章所在卷：只注入该章之前的逐章摘要，命中即停外层（防后续卷/剧透）
      for (const ch of vol.chapters) {
        if (ch.id === upToChapterId) { reached = true; break; }
        const s = summaries[ch.id];
        if (s) ordered.push({ kind: 'ch', label: ch.title, text: s });
      }
      break;
    }
    // 整卷都在目标之前：新鲜回本则一条顶替全卷
    const rc = recaps?.[vol.id];
    if (rc && rc.fingerprint === recapFingerprint(vol, summaries)) {
      ordered.push({ kind: 'recap', label: vol.title, text: rc.recap });
    } else {
      for (const ch of vol.chapters) {
        const s = summaries[ch.id];
        if (s) ordered.push({ kind: 'ch', label: ch.title, text: s });
      }
    }
  }
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (budget <= 0) break;
    const item = ordered[i];
    const text = item.text.length > budget ? item.text.slice(0, budget) + '…' : item.text;
    const line = item.kind === 'recap'
      ? `【卷回本·${item.label}】${text}`
      : `《${item.label}》：${text}`;
    lines.unshift(line);
    budget -= text.length;
  }
  return lines.join('\n');
}

/** 按大纲顺序展开全部章节 id（卷序 + 卷内序） */
export function flattenChapterIds(outline: Outline): string[] {
  const ids: string[] = [];
  for (const vol of outline.volumes) for (const ch of vol.chapters) ids.push(ch.id);
  return ids;
}

/**
 * 从 fromId（含）开始按阅读顺序取最多 count 个章节 id；跨卷自然衔接。
 * fromId 不在大纲中时抛错（复用 locateChapter 的报错语义）。
 */
export function nextChapterIds(outline: Outline, fromId: string, count: number): string[] {
  const all = flattenChapterIds(outline);
  const at = all.indexOf(fromId);
  if (at < 0) throw new Error(`大纲中找不到章节 ${fromId}`);
  return all.slice(at, at + Math.max(1, count));
}

export function buildChapterContext(args: {
  outline: Outline;
  chapterId: string;
  characters: CharacterCard[];
  worldview: string;
  summaries: Record<string, string>;
  recaps?: Record<string, VolumeRecap>;  // 已完成卷的卷回本（分层记忆）
  prevChapterContent?: string;   // 前一章全文（这里只取结尾）
  foreshadows?: Foreshadow[];    // 伏笔登记表
  currentVolumeOnlyCast?: boolean;
}): ChapterContext {
  const { outline, chapterId, characters } = args;
  const loc = locateChapter(outline, chapterId);
  const vol = loc.volume;
  const prev = loc.chapterIndex > 0 ? vol.chapters[loc.chapterIndex - 1] : undefined;
  const nextChapters = vol.chapters.slice(loc.chapterIndex + 1, loc.chapterIndex + 3);

  const names = new Set((loc.chapter.characters ?? []).map((n) => n.trim()).filter(Boolean));
  const cast = characters.filter((c) => names.has(c.name));
  // 出场名单里有但设定集中没有卡片的，也列出来防止模型张冠李戴
  const missing = [...names].filter((n) => !characters.some((c) => c.name === n));
  const mentionOnly = characters.filter((c) => !names.has(c.name) && (c.role === '主角' || c.role === '女主' || c.role === '反派')).slice(0, 4);
  const mentionOnlyAll = [...mentionOnly];
  if (missing.length) mentionOnlyAll.push(...missing.map((m) => ({ name: m, role: '未建档', personality: '按大纲情节行事', background: '', relations: '' } as CharacterCard)));

  const prevTail = args.prevChapterContent ? args.prevChapterContent.replace(/\s+$/, '').slice(-PREV_TAIL_CHARS) : '';

  return {
    outline,
    chapter: loc.chapter,
    prevChapter: prev,
    nextChapters,
    volumeTitle: vol.title,
    volumeSummary: vol.summary,
    prevTail,
    summaries: buildSummariesText(outline, args.summaries, chapterId, args.recaps),
    foreshadow: foreshadowText(outline, args.foreshadows ?? [], chapterId),
    cast,
    mentionOnly: mentionOnlyAll,
  };
}

/** 章 id → 《标题》(id) 展示格式；找不到章时退化为 (id) */
function chapterRef(outline: Outline, cid: string): string {
  for (const v of outline.volumes) {
    const c = v.chapters.find((x) => x.id === cid);
    if (c) return `《${c.title}》(${cid})`;
  }
  return `(${cid})`;
}

/**
 * 生成章节时注入的伏笔备忘：
 * 埋设章已在本章之前的未回收伏笔 + 指定本章回收的伏笔。
 */
export function foreshadowText(outline: Outline, items: Foreshadow[], chapterId: string): string {
  if (!items.length) return '';
  const order = flattenChapterIds(outline);
  const at = order.indexOf(chapterId);
  if (at < 0) return '';
  const titleOf = (cid: string) => chapterRef(outline, cid);
  const dueLines: string[] = [];
  const openLines: string[] = [];
  for (const f of items) {
    if (f.status === 'abandoned') continue;
    const dueHere = f.status === 'open' && f.payoffChapterId === chapterId;
    const buried = order.indexOf(f.setupChapterId);
    const openBefore = f.status === 'open' && buried >= 0 && buried <= at && f.setupChapterId !== chapterId;
    if (dueHere) dueLines.push(`- 本章必须回收：${f.content}（埋设于${titleOf(f.setupChapterId)}）`);
    else if (openBefore) {
      const plan = f.payoffChapterId ? `，计划回收于${titleOf(f.payoffChapterId)}` : '，回收章未定';
      openLines.push(`- 仍未回收（可推进线索，不要遗忘）：${f.content}（埋设于${titleOf(f.setupChapterId)}${plan}）`);
    }
  }
  return [...dueLines, ...openLines].join('\n');
}

/**
 * 全书（未打开章节）上下文用的未回收伏笔清单：
 * 埋设章与计划回收章都完整带上——曾有内联格式漏掉回收章，编辑据此答题会答成"回收章未定"。
 */
export function openForeshadowListText(outline: Outline, items: Foreshadow[]): string {
  const open = items.filter((f) => f.status === 'open');
  if (!open.length) return '';
  return open
    .map((f) => {
      const plan = f.payoffChapterId ? `，计划回收于${chapterRef(outline, f.payoffChapterId)}` : '，回收章未定';
      return `- 未回收：${f.content}（埋设于${chapterRef(outline, f.setupChapterId)}${plan}）`;
    })
    .join('\n');
}

/** 供改写/问答用的轻量上下文 */
export function selectionContext(chapterTitle: string, content: string, start: number, end: number): { before: string; after: string; original: string } {
  const safeStart = Math.max(0, Math.min(start, content.length));
  const safeEnd = Math.max(safeStart, Math.min(end, content.length));
  return {
    before: content.slice(Math.max(0, safeStart - 400), safeStart),
    after: content.slice(safeEnd, safeEnd + 300),
    original: content.slice(safeStart, safeEnd) || content,
  };
}
