import { Router } from 'express';
import {
  ChapterFile, CharacterCard, Foreshadow, Outline,
} from '../../../shared/src/types';
import { countChars } from '../../../shared/src/util';
import {
  listChapterBackups, listChapters, loadBundle, loadForeshadows, loadSummaries, readChapter, readChapterBackup,
  saveCharacters, saveChapterBody, saveOutline, saveForeshadows, saveSummaries, saveSuggestions, saveWorldview,
  searchChapters,
} from '../fs-store';

export const projectRouter = Router();

/** 打开作品：一次性全量下发 */
projectRouter.get('/:slug/bundle', (req, res) => {
  try {
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
      card.state = sug.content;
      saveCharacters(req.params.slug, chars);
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
