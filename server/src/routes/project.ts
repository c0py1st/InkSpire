import { Router } from 'express';
import {
  ChapterFile, CharacterCard, Outline, SearchHit,
} from '../../../shared/src/types';
import { countChars } from '../../../shared/src/util';
import {
  listChapterBackups, listChapters, loadBundle, loadOutline, readChapter, readChapterBackup, saveCharacters,
  saveChapterBody, saveOutline, saveSuggestions, saveWorldview,
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
const SNIP = 30;
projectRouter.get('/:slug/search', (req, res) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 1) return res.json([]);
    const limit = Math.max(1, Math.min(80, Number(req.query.limit) || 40));
    const outline = loadOutline(req.params.slug);
    const volTitle = new Map<string, string>();
    if (outline) for (const vol of outline.volumes) for (const ch of vol.chapters) volTitle.set(ch.id, vol.title);
    const chapters = listChapters(req.params.slug); // 按 id 升序 = 阅读顺序
    const needle = q.toLowerCase();
    const hits: SearchHit[] = [];
    for (const ch of chapters) {
      const hay = ch.content.toLowerCase();
      let from = 0;
      for (;;) {
        const at = hay.indexOf(needle, from);
        if (at < 0) break;
        const s = Math.max(0, at - SNIP);
        const pre = ch.content.slice(s, at).replace(/\n/g, ' ');
        const hit = ch.content.slice(at, at + q.length);
        const post = ch.content.slice(at + q.length, at + q.length + SNIP).replace(/\n/g, ' ');
        hits.push({
          chapterId: ch.id, chapterTitle: ch.title, volumeTitle: volTitle.get(ch.id) ?? '',
          offset: at,
          snippet: `${s > 0 ? '…' : ''}${pre}〔${hit}〕${post}…`,
        });
        from = at + Math.max(1, needle.length);
        if (hits.length >= limit) break;
      }
      if (hits.length >= limit) break;
    }
    res.json(hits);
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

/** 处理"建议补充设定"：接受 => 追加人物卡；忽略 => 删除建议 */
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
