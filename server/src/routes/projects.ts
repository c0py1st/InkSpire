import { Router } from 'express';
import { ChapterFile, CharacterCard, Outline } from '../../../shared/src/types';
import { chapterId as mkChapterId, countChars, volumeId } from '../../../shared/src/util';
import { buildBookArchive } from '../backup';
import {
  createProject, deleteProject, getMeta, listChapters, listProjects, loadOutline, saveProjectBundle,
} from '../fs-store';

export const projectsRouter = Router();

projectsRouter.get('/', (_req, res) => {
  res.json(listProjects());
});

/** 新建空项目（不走向导的快速入口） */
projectsRouter.post('/', (req, res) => {
  const { title, logline } = req.body as { title: string; logline?: string };
  try {
    res.json(createProject({ title, logline: logline ?? '' }));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 向导完成后一次性落盘 */
projectsRouter.post('/complete', (req, res) => {
  const body = req.body as {
    meta: { title: string; logline: string; wordsPerChapter?: number };
    outline: Outline;
    characters: CharacterCard[];
    worldview: string;
  };
  try {
    if (!body.outline?.volumes?.length) throw new Error('大纲为空');
    const chapters: ChapterFile[] = [];
    for (const [vi, vol] of body.outline.volumes.entries()) {
      vol.id = volumeId(vi + 1);
      for (const [ci, ch] of vol.chapters.entries()) {
        ch.id = mkChapterId(vi + 1, ci + 1);
        ch.status = 'todo';
        ch.wordCount = 0;
        chapters.push({ id: ch.id, title: ch.title, status: 'todo', content: '' });
      }
    }
    const meta = saveProjectBundle(
      { outline: body.outline, characters: body.characters ?? [], worldview: body.worldview ?? '', summaries: {}, suggestions: [], foreshadows: [] },
      { title: body.meta.title, logline: body.meta.logline ?? '', wordsPerChapter: body.meta.wordsPerChapter },
      chapters,
    );
    res.json(meta);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

projectsRouter.delete('/:slug', (req, res) => {
  try {
    deleteProject(req.params.slug);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 整本备份：目录树打包 tar.gz 下载（含历史版本，不含密钥） */
projectsRouter.get('/:slug/backup', (req, res) => {
  try {
    const { buffer, filename } = buildBookArchive(req.params.slug);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(buffer);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 整本导出 */
projectsRouter.get('/:slug/export', (req, res) => {
  const slug = req.params.slug;
  const format = (req.query.format as string) === 'txt' ? 'txt' : 'md';
  try {
    const meta = getMeta(slug);
    const outline = loadOutline(slug);
    if (!outline) throw new Error('本书还没有大纲');
    const chapters = listChapters(slug);
    const byId = new Map(chapters.map((c) => [c.id, c]));

    const parts: string[] = [`# ${meta.title}\n`];
    if (meta.logline) parts.push(`> ${meta.logline}\n`);
    for (const vol of outline.volumes) {
      parts.push(`\n## ${vol.title}\n`);
      for (const ch of vol.chapters) {
        const body = byId.get(ch.id);
        parts.push(`\n### ${ch.title}\n\n${body?.content?.trim() ? body.content.trim() : '（未完成）'}\n`);
      }
    }
    let text = parts.join('\n');
    if (format === 'txt') text = text.replace(/^# /gm, '').replace(/^> /gm, '').replace(/\*\*/g, '');

    // 直接下发，不再落盘副本；下载文件名用 slug（title 可能含路径非法字符）
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${meta.slug}.${format}`)}`);
    res.send(text);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/* 供 /api/projects/:slug/bundle 等使用的工具移到 project.ts；这里再暴露一个统计接口 */
projectsRouter.get('/:slug/stats', (req, res) => {
  try {
    const outline = loadOutline(req.params.slug);
    const chapters = listChapters(req.params.slug);
    const byId = new Map(chapters.map((c) => [c.id, c]));
    let total = 0;
    let done = 0;
    if (outline) {
      for (const vol of outline.volumes) {
        for (const ch of vol.chapters) {
          const body = byId.get(ch.id);
          const wc = body ? countChars(body.content) : 0;
          ch.wordCount = wc;
          total += wc;
          if (wc > 0) done++;
        }
      }
    }
    res.json({ totalWords: total, chaptersDone: done });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
