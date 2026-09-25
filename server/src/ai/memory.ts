import type {
  ChapterBeat, CharacterCard, Foreshadow, Outline,
} from '../../../shared/src/types';
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
): string {
  const lines: string[] = [];
  let budget = SUMMARY_BUDGET_CHARS;
  // 从最后一章向前收集，保证最近章节的摘要在预算内
  const ordered: Array<{ title: string; text: string; volumeTitle: string }> = [];
  // 只收集"本章之前"的摘要：命中 upTo 后必须连外层卷循环一起停，
  // 否则后续卷的摘要会被当"前情"注入（回头重写旧章时造成剧透污染）
  let reached = false;
  for (const vol of outline.volumes) {
    if (reached) break;
    for (const ch of vol.chapters) {
      if (ch.id === upToChapterId) { reached = true; break; }
      const s = summaries[ch.id];
      if (s) ordered.push({ title: ch.title, text: s, volumeTitle: vol.title });
    }
  }
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (budget <= 0) break;
    const item = ordered[i];
    const text = item.text.length > budget ? item.text.slice(0, budget) + '…' : item.text;
    lines.unshift(`《${item.title}》：${text}`);
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
    summaries: buildSummariesText(outline, args.summaries, chapterId),
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
