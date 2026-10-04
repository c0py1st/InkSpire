import { Router } from 'express';
import {
  applyOutlineSuggestion, applyStateSuggestion, ChapterFile, CharacterCard, Foreshadow, Outline, StoryEvent,
} from '../../../shared/src/types';
import { countChars } from '../../../shared/src/util';
import {
  getMeta, listChapterBackups, listChapters, loadBundle, loadChat, loadEvents, loadExemplars, loadForeshadows, loadLoreActivated, loadLorebook, loadOutline, loadRecaps, loadSummaries, readChapter, readChapterBackup,
  sanitizeLoreEntries, sanitizeStyleExemplars, saveCharacters, saveChapterBody, saveChat, saveEvents, saveExemplars, saveLorebook, saveMeta, saveOutline, saveForeshadows, saveSummaries, saveSuggestions, saveWorldview,
} from '../fs-store';
import { buildChapterContext, chapterCorpus, flattenChapterIds, locateChapter, LORE_BUDGET_CHARS, STYLE_BUDGET_CHARS } from '../ai/memory';
import { explainLoreActivation } from '../../../shared/src/lore';
import { searchChapters } from '../chapter-index';
import { loadCacheStats, resetCacheStats } from '../cache-stats';

export const projectRouter = Router();

/** 打开作品：一次性全量下发 */
projectRouter.get('/:slug/bundle', (req, res) => {  try {
    const bundle = loadBundle(req.params.slug);
    const chapters = listChapters(req.params.slug);
    const wc: Record<string, number> = {};
    for (const ch of chapters) wc[ch.id] = countChars(ch.content);
    if (bundle.outline) {
      for (const vol of bundle.outline.volumes) {
        for (const ch of vol.chapters) ch.wordCount = wc[ch.id] ?? 0;
      }
    }
    res.json({ ...bundle, wordCounts: wc, chapterTitles: Object.fromEntries(chapters.map((c) => [c.id, c.title])) });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

/** 通读模式正文：全部章节按章序连排下发（只读视图，零模型调用；章 id 零填充，字典序即阅读序） */
projectRouter.get('/:slug/read-through', (req, res) => {
  try {
    const chapters = listChapters(req.params.slug);
    res.json(chapters.map((c) => ({ id: c.id, title: c.title, content: c.content })));
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

/** 作品级开关：白名单只收 webnovelMode（网文模式），其余 meta 字段不可经此改 */
projectRouter.put('/:slug/meta', (req, res) => {
  try {
    const meta = getMeta(req.params.slug);
    if (typeof req.body?.webnovelMode === 'boolean') meta.webnovelMode = req.body.webnovelMode;
    saveMeta(req.params.slug, meta);
    res.json({ ok: true, webnovelMode: !!meta.webnovelMode });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

projectRouter.get('/:slug/chapter/:chapterId', (req, res) => {
  try {
    res.json(readChapter(req.params.slug, req.params.chapterId));
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

/** 前文检索：在全部章节正文里找查询词，返回命中点偏移与上下文摘录 */
/** 前文检索：在全部章节正文里找查询词，返回命中点偏移与上下文摘录 */
projectRouter.get('/:slug/search', (req, res) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 1) return res.json([]);
    res.json(searchChapters(req.params.slug, q, Number(req.query.limit) || 40));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 某章的历史备份列表（新的在前） */
projectRouter.get('/:slug/chapter/:chapterId/backups', (req, res) => {
  try {
    res.json(listChapterBackups(req.params.slug, req.params.chapterId));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 读取一份历史备份的正文 */
projectRouter.get('/:slug/chapter/:chapterId/backups/:stamp', (req, res) => {
  try {
    res.json(readChapterBackup(req.params.slug, req.params.chapterId, req.params.stamp));
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

projectRouter.put('/:slug/chapter/:chapterId', (req, res) => {
  try {
    const { content, status, title, backup } = req.body as { content: string; status?: ChapterFile['status']; title?: string; backup?: boolean };
    const existing = readChapter(req.params.slug, req.params.chapterId);
    const wordCount = saveChapterBody(req.params.slug, {
      id: req.params.chapterId,
      title: title ?? existing.title,
      status: status ?? existing.status,
      content: content ?? existing.content,
    }, Boolean(backup));
    res.json({ ok: true, wordCount });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

projectRouter.put('/:slug/outline', (req, res) => {
  try {
    const outline = req.body as Outline;
    if (!outline || !Array.isArray(outline.volumes)) throw new Error('outline 结构不合法');
    saveOutline(req.params.slug, outline);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 只保留字段完整的条目，脏数据不进盘 */
export function sanitizeForeshadows(body: unknown): Foreshadow[] {
  if (!Array.isArray(body)) return [];
  return body
    .filter((f): f is Foreshadow => !!f && typeof f.id === 'string' && typeof f.content === 'string'
      && typeof f.setupChapterId === 'string'
      && (f.status === 'open' || f.status === 'resolved' || f.status === 'abandoned'))
    .map((f) => ({
      id: f.id,
      setupChapterId: f.setupChapterId,
      content: f.content,
      ...(f.payoffChapterId ? { payoffChapterId: f.payoffChapterId } : {}),
      status: f.status,
      createdAt: typeof f.createdAt === 'string' ? f.createdAt : new Date().toISOString(),
    }));
}

projectRouter.get('/:slug/foreshadows', (req, res) => {
  try {
    res.json(loadForeshadows(req.params.slug));
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

projectRouter.put('/:slug/foreshadows', (req, res) => {
  try {
    const items = sanitizeForeshadows(req.body);
    saveForeshadows(req.params.slug, items);
    res.json({ ok: true, count: items.length });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/* ---------------- 世界事件账本（时间线，真相源 events.json） ---------------- */

projectRouter.get('/:slug/events', (req, res) => {
  try {
    res.json(loadEvents(req.params.slug));
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

/** 作者手动补记一条事件（来源章必须在大纲里；标 manual，重归档不会被覆盖） */
projectRouter.post('/:slug/events', (req, res) => {
  try {
    const body = req.body as { chapterId?: string; title?: string; detail?: string; actors?: string[]; whenInStory?: string };
    const chapterId = String(body?.chapterId ?? '');
    const title = String(body?.title ?? '').trim();
    if (!title) return res.status(400).json({ error: '事件标题不能为空' });
    const outline = loadOutline(req.params.slug);
    if (!outline) return res.status(400).json({ error: '本书还没有大纲' });
    const known = outline.volumes.some((v) => v.chapters.some((c) => c.id === chapterId));
    if (!known) return res.status(400).json({ error: `来源章「${chapterId}」不在大纲中` });
    const evt: StoryEvent = {
      id: `ev-${chapterId}-m${Date.now()}`,
      chapterId,
      title: title.slice(0, 160),
      ...(body.detail?.trim() ? { detail: body.detail.trim().slice(0, 600) } : {}),
      ...((body.actors ?? []).some((a) => a?.trim()) ? { actors: (body.actors ?? []).map((a) => a.trim().slice(0, 30)).filter(Boolean).slice(0, 8) } : {}),
      ...(body.whenInStory?.trim() ? { whenInStory: body.whenInStory.trim().slice(0, 60) } : {}),
      source: 'manual',
      at: new Date().toISOString(),
    };
    const next = [...loadEvents(req.params.slug), evt].sort((a, b) => a.chapterId.localeCompare(b.chapterId) || a.at.localeCompare(b.at));
    saveEvents(req.params.slug, next);
    res.json({ ok: true, id: evt.id, events: next });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

projectRouter.delete('/:slug/events/:id', (req, res) => {
  try {
    const all = loadEvents(req.params.slug);
    const next = all.filter((e) => e.id !== req.params.id);
    if (next.length === all.length) return res.status(404).json({ error: '事件不存在' });
    saveEvents(req.params.slug, next);
    res.json({ ok: true, events: next });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/* ---------------- 世界书（lorebook.json，真相源；命中激活在生成时算） ---------------- */

projectRouter.get('/:slug/lorebook', (req, res) => {
  try {
    res.json(loadLorebook(req.params.slug));
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

/** 整表覆盖：服务端消毒后落盘并回显规范化结果（脏条目丢弃不报错，前端以回显为准） */
projectRouter.put('/:slug/lorebook', (req, res) => {
  try {
    const clean = sanitizeLoreEntries(req.body);
    saveLorebook(req.params.slug, clean);
    res.json({ ok: true, entries: clean });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 各章最近一次生成的激活留痕（UI 展示"哪条被激活/被挤掉"） */
projectRouter.get('/:slug/lorebook/trace', (req, res) => {
  try {
    res.json(loadLoreActivated(req.params.slug));
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

/* ---------------- 风格范文库（exemplars.json，真相源） ---------------- */

projectRouter.get('/:slug/exemplars', (req, res) => {
  try {
    res.json(loadExemplars(req.params.slug));
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

/** 整表覆盖：消毒回显同 lorebook；「一键收录」是 append 后整写，去重在前端/调用侧做 */
projectRouter.put('/:slug/exemplars', (req, res) => {
  try {
    const clean = sanitizeStyleExemplars(req.body);
    saveExemplars(req.params.slug, clean);
    res.json({ ok: true, entries: clean });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** B2 激活测试器：对所选章逐条解释"为什么注入/没注入"——语料构造、预算、判定函数全部与真实生成同源 */
projectRouter.get('/:slug/lore-test/:chapterId', (req, res) => {
  try {
    const { slug, chapterId } = req.params;
    const kind = req.query.kind === 'style' ? 'style' : 'lore';
    const outline = loadOutline(slug);
    if (!outline) return res.status(400).json({ error: '本书还没有大纲' });
    const loc = locateChapter(outline, chapterId);
    // prevTail 与生成路径同法取（跨卷衔接）
    const chapters = listChapters(slug);
    let prevId: string | undefined;
    if (loc.chapterIndex > 0) prevId = loc.volume.chapters[loc.chapterIndex - 1].id;
    else if (loc.volumeIndex > 0) { const pv = outline.volumes[loc.volumeIndex - 1]; prevId = pv.chapters[pv.chapters.length - 1]?.id; }
    const ctx = buildChapterContext({
      outline, chapterId, characters: [], worldview: '',
      summaries: loadSummaries(slug), recaps: loadRecaps(slug),
      prevChapterContent: prevId ? chapters.find((c) => c.id === prevId)?.content : undefined,
      foreshadows: loadForeshadows(slug),
    });
    const entries = kind === 'style' ? loadExemplars(slug) : loadLorebook(slug);
    const { items, used, budget } = explainLoreActivation({
      entries,
      order: flattenChapterIds(outline),
      chapterId,
      volumeId: loc.volume.id,
      corpus: chapterCorpus(loc.chapter, ctx.prevTail, ctx.summaries),
      budgetChars: kind === 'style' ? STYLE_BUDGET_CHARS : LORE_BUDGET_CHARS,
    });
    res.json({ kind, used, budget, items });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 对话记录：整读整写（前端防抖落盘），服务端消毒后回存 */
projectRouter.get('/:slug/chat', (req, res) => {
  try {
    res.json(loadChat(req.params.slug));
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

projectRouter.get('/:slug/cache-stats', (req, res) => {
  try {
    res.json(loadCacheStats(req.params.slug));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

projectRouter.delete('/:slug/cache-stats', (req, res) => {
  try {
    resetCacheStats(req.params.slug);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

projectRouter.put('/:slug/chat', (req, res) => {
  try {
    const saved = saveChat(req.params.slug, (req.body as { messages?: unknown })?.messages);
    res.json({ ok: true, count: saved.length });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 单条章节摘要写入（agent 提案采纳用；readChapter 校验章 id 合法与存在） */
projectRouter.put('/:slug/summary/:chapterId', (req, res) => {
  try {
    const summary = String(req.body?.summary ?? '').trim();
    if (!summary) return res.status(400).json({ error: '摘要为空' });
    readChapter(req.params.slug, req.params.chapterId); // 非法/不存在章会抛错
    const summaries = loadSummaries(req.params.slug);
    summaries[req.params.chapterId] = summary;
    saveSummaries(req.params.slug, summaries);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

projectRouter.put('/:slug/characters', (req, res) => {
  try {
    saveCharacters(req.params.slug, req.body as CharacterCard[]);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

projectRouter.put('/:slug/worldview', (req, res) => {
  try {
    saveWorldview(req.params.slug, String(req.body?.text ?? ''));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 处理"建议补充设定"：接受 => 追加人物卡/更新状态；忽略 => 删除建议 */
projectRouter.post('/:slug/suggestions/:id/accept', (req, res) => {
  try {
    const bundle = loadBundle(req.params.slug);
    const sug = bundle.suggestions.find((s) => s.id === req.params.id);
    if (!sug) return res.status(404).json({ error: '建议不存在' });
    const chars = bundle.characters;
    if (sug.kind === 'character' && !chars.some((c) => c.name === sug.name)) {
      chars.push({
        id: `ch-${Date.now()}`,
        name: sug.name,
        role: '待定',
        personality: sug.content,
        background: '',
        relations: '',
      });
      saveCharacters(req.params.slug, chars);
    }
    if (sug.kind === 'state') {
      const card = chars.find((c) => c.name === sug.name);
      if (!card) return res.status(400).json({ error: `人物「${sug.name}」已不在设定集，无法更新状态` });
      applyStateSuggestion(card, sug);
      saveCharacters(req.params.slug, chars);
    }
    if (sug.kind === 'outline') {
      const oc = loadOutline(req.params.slug);
      if (!oc) return res.status(400).json({ error: '本书还没有大纲，无从修订' });
      if (!applyOutlineSuggestion(oc, sug)) return res.status(400).json({ error: '大纲里找不到这条建议对应的章节' });
      saveOutline(req.params.slug, oc);
    }
    saveSuggestions(req.params.slug, bundle.suggestions.filter((s) => s.id !== req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

projectRouter.delete('/:slug/suggestions/:id', (req, res) => {
  try {
    const bundle = loadBundle(req.params.slug);
    saveSuggestions(req.params.slug, bundle.suggestions.filter((s) => s.id !== req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
