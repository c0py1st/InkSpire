import type {
  ChapterBeat, CharacterCard, Outline,
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
  for (const vol of outline.volumes) {
    for (const ch of vol.chapters) {
      if (ch.id === upToChapterId) break;
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
    cast,
    mentionOnly: mentionOnlyAll,
  };
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
