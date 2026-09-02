import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  AppConfig, ChapterBeat, CharacterCard, Kernel, Outline, ProposalRequest, ProviderProfile, Suggestion, Volume,
} from '../../../shared/src/types';
import { loadConfig, isMock } from '../config';
import { chatOnce, streamChat } from '../ai/provider';
import { extractJson } from '../ai/json';
import { Sse, abortOnClose } from '../ai/sse';
import { buildChapterContext, buildSummariesText, locateChapter, selectionContext } from '../ai/memory';
import { kernelPrompt } from '../ai/prompts/kernel';
import { volumesPrompt } from '../ai/prompts/volumes';
import { beatsPrompt } from '../ai/prompts/beats';
import { biblePrompt } from '../ai/prompts/bible';
import { continuePrompt, prosePrompt } from '../ai/prompts/prose';
import { revisePrompt } from '../ai/prompts/revise';
import { chatPrompt } from '../ai/prompts/chat';
import { summaryPrompt } from '../ai/prompts/summary';
import { consistencyPrompt } from '../ai/prompts/consistency';
import {
  listChapters, loadBundle, loadOutline, loadSuggestions, readChapter,
  saveOutline, saveSuggestions, saveSummaries, touchMeta,
} from '../fs-store';

export const aiRouter = Router();

function pick(cfg: AppConfig, id: string | null | undefined, fallbackCreative = false): ProviderProfile | null {
  const found = cfg.providers.find((p) => p.id === id);
  if (found) return found;
  if (fallbackCreative) return cfg.providers[0] ?? null;
  return null;
}

function creativeProfile(cfg: AppConfig): ProviderProfile | null {
  return pick(cfg, cfg.creativeId, true);
}

function assistProfile(cfg: AppConfig): ProviderProfile | null {
  return pick(cfg, cfg.assistId) ?? creativeProfile(cfg);
}

/** 通用流式封装：把一个 prompt 任务的 delta 推给前端，结束时回传 full */
function streamTask(
  req: Request,
  res: Response,
  run: (sse: Sse, signal: AbortSignal) => Promise<void>,
): void {
  const controller = new AbortController();
  const sse = new Sse(res);
  abortOnClose(req, res, () => controller.abort());
  run(sse, controller.signal)
    .then(() => sse.end())
    .catch((err) => {
      if (!controller.signal.aborted) sse.error(err);
      else sse.end();
    });
}

async function streamToTask(
  sse: Sse,
  signal: AbortSignal,
  profile: ProviderProfile | null,
  cfg: AppConfig,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  kind: 'json' | 'prose' | 'summary',
  maxTokens?: number,
): Promise<string> {
  let full = '';
  for await (const delta of streamChat(cfg, profile!, messages, { signal, kind, maxTokens })) {
    full += delta;
    sse.delta(delta);
  }
  return full;
}

/* ================= 创作向导（无状态：上下文由前端带回传） ================= */

aiRouter.post('/wizard/kernel', (req, res) => {
  const { ideaPrompt, scale } = req.body as { ideaPrompt: string; scale: { volumeCount: number; chaptersPerVolume: number; wordsPerChapter: number } };
  const cfg = loadConfig();
  const prompt = kernelPrompt(ideaPrompt, scale);
  streamTask(req, res, async (sse, signal) => {
    const full = await streamToTask(sse, signal, creativeProfile(cfg), cfg, [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ], 'json', 8192);
    sse.send({ type: 'final', kernel: extractJson<Kernel>(full) });
  });
});

aiRouter.post('/wizard/volumes', (req, res) => {
  const { kernel, volumeCount } = req.body as { kernel: Kernel; volumeCount: number };
  const cfg = loadConfig();
  const prompt = volumesPrompt(kernel, volumeCount);
  streamTask(req, res, async (sse, signal) => {
    const full = await streamToTask(sse, signal, creativeProfile(cfg), cfg, [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ], 'json', 8192);
    sse.send({ type: 'final', volumes: extractJson<{ volumes: Array<{ title: string; summary: string }> }>(full).volumes });
  });
});

aiRouter.post('/wizard/beats', (req, res) => {
  const { kernel, volumes, volIndex, chapterCount } = req.body as {
    kernel: Kernel; volumes: Volume[]; volIndex: number; chapterCount: number;
  };
  const cfg = loadConfig();
  const vol = volumes[volIndex];
  if (!vol) return res.status(400).json({ error: '卷不存在' });
  const neighbors = [volumes[volIndex - 1], volumes[volIndex + 1]].filter(Boolean)
    .map((v) => ({ title: v.title, summary: v.summary }));
  const prompt = beatsPrompt(kernel, vol.title, vol.summary, chapterCount, neighbors);
  streamTask(req, res, async (sse, signal) => {
    const full = await streamToTask(sse, signal, creativeProfile(cfg), cfg, [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ], 'json', 8192);
    sse.send({ type: 'final', chapters: extractJson<{ chapters: Array<{ title: string; beat: string; pov?: string; characters?: string[] }> }>(full).chapters });
  });
});

aiRouter.post('/wizard/bible', (req, res) => {
  const { kernel, volumes } = req.body as { kernel: Kernel; volumes: Volume[] };
  const cfg = loadConfig();
  const prompt = biblePrompt(kernel, volumes);
  streamTask(req, res, async (sse, signal) => {
    const full = await streamToTask(sse, signal, creativeProfile(cfg), cfg, [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ], 'json', 8192);
    sse.send({ type: 'final', bible: extractJson<{ characters: CharacterCard[]; worldview: string }>(full) });
  });
});

/* ================= 正文生成 ================= */

aiRouter.post('/projects/:slug/generate-chapter/:chapterId', (req, res) => {
  const { slug, chapterId } = req.params;
  const mode = (req.body?.mode as 'full' | 'continue') ?? 'full';
  const cfg = loadConfig();
  const outline = loadOutline(slug);
  if (!outline) return res.status(400).json({ error: '本书还没有大纲' });
  const bundle = loadBundle(slug);
  const existing = mode === 'continue' ? readChapter(slug, chapterId) : null;

  streamTask(req, res, async (sse, signal) => {
    const chapters = listChapters(slug);
    const prevId = (() => {
      try {
        const loc = locateChapter(outline, chapterId);
        if (loc.chapterIndex > 0) return loc.volume.chapters[loc.chapterIndex - 1].id;
        if (loc.volumeIndex > 0) {
          const prevVol = outline.volumes[loc.volumeIndex - 1];
          return prevVol.chapters[prevVol.chapters.length - 1]?.id;
        }
      } catch { /* ignore */ }
      return undefined;
    })();
    const prevContent = prevId ? chapters.find((c) => c.id === prevId)?.content : undefined;

    const ctx = buildChapterContext({
      outline,
      chapterId,
      characters: bundle.characters,
      worldview: bundle.worldview,
      summaries: bundle.summaries,
      prevChapterContent: prevContent,
    });
    const prompt = existing && existing.content.trim() ? continuePrompt(ctx, existing.content) : prosePrompt(ctx);
    touchMeta(slug);
    await streamToTask(sse, signal, creativeProfile(cfg), cfg, [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ], 'prose');
    sse.send({ type: 'final', chapterId });
  });
});

/** 章节完稿：生成摘要、探测新设定，写入 suggestions */
aiRouter.post('/projects/:slug/finalize-chapter/:chapterId', async (req, res) => {
  const { slug, chapterId } = req.params;
  try {
    const cfg = loadConfig();
    const outline = loadOutline(slug);
    if (!outline) return res.status(400).json({ error: '本书还没有大纲' });
    // 优先从磁盘读最新正文，避免依赖前端传入、也容错空传参
    let content = String(req.body?.content ?? '').trim();
    if (!content) {
      try { content = readChapter(slug, chapterId).content.trim(); } catch { /* 忽略 */ }
    }
    if (!content) return res.status(400).json({ error: '正文为空' });

    const loc = locateChapter(outline, chapterId);
    const bundle = loadBundle(slug);
    const prompt = summaryPrompt({
      chapterTitle: loc.chapter.title,
      content: content.slice(0, 20000),
      knownCharacters: bundle.characters.map((c) => c.name),
    });
    // 辅助 JSON 任务：deepseek 推理型模型需要为思考预留 token，给足 max_tokens
    const raw = await chatOnce(cfg, assistProfile(cfg), [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ], { kind: 'json', temperature: 0.3, maxTokens: 4000 });
    const parsed = extractJson<{ summary: string; newCharacters: Array<{ name: string; reason: string }>; worldNotes: string[] }>(raw);

    const summaries = { ...bundle.summaries, [chapterId]: parsed.summary };
    saveSummaries(slug, summaries);

    const suggestions = loadSuggestions(slug);
    const existingNames = new Set(bundle.characters.map((c) => c.name));
    const added: Suggestion[] = [];
    for (const nc of parsed.newCharacters ?? []) {
      if (!nc.name?.trim() || existingNames.has(nc.name.trim())) continue;
      existingNames.add(nc.name.trim());
      added.push({
        id: `sug-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        kind: 'character',
        name: nc.name.trim(),
        content: nc.reason ?? '',
        createdAt: new Date().toISOString(),
      });
    }
    const worldAdded: Suggestion[] = (parsed.worldNotes ?? []).filter((w) => w?.trim()).map((w) => ({
      id: `sug-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: 'world' as const,
      name: '世界观补充',
      content: w,
      createdAt: new Date().toISOString(),
    }));
    const all = [...suggestions, ...added, ...worldAdded].slice(-50);
    saveSuggestions(slug, all);

    res.json({ summary: parsed.summary, newSuggestions: [...added, ...worldAdded] });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ================= 批注抽屉 ================= */

aiRouter.post('/projects/:slug/chat', (req, res) => {
  const { slug } = req.params;
  const { messages, chapterId, selection } = req.body as {
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    chapterId?: string;
    selection?: string;
  };
  const cfg = loadConfig();
  const outline = loadOutline(slug);
  const bundle = loadBundle(slug);
  const question = messages[messages.length - 1]?.content ?? '';
  const history = messages.slice(0, -1).slice(-8);

  let chapterTitle: string | undefined;
  let chapterBeat: string | undefined;
  let chapterContent: string | undefined;
  if (chapterId && outline) {
    try {
      const loc = locateChapter(outline, chapterId);
      chapterTitle = loc.chapter.title;
      chapterBeat = loc.chapter.beat;
      chapterContent = readChapter(slug, chapterId).content.slice(0, 16000);
    } catch { /* 大纲中没有该章 */ }
  }

  const charsText = bundle.characters
    .map((c) => `- ${c.name}（${c.role}）：${c.personality}；${c.background}；关系 ${c.relations}`)
    .join('\n');
  const prompt = chatPrompt({
    outline: outline ?? { premise: '', genre: '', coreConflict: '', endingVision: '', styleGuide: '', volumes: [] },
    worldview: bundle.worldview,
    characters: charsText,
    summaries: outline ? buildSummariesText(outline, bundle.summaries, chapterId ?? '') : '',
    chapterTitle,
    chapterBeat,
    chapterContent,
    selection,
    history,
    question,
  });

  streamTask(req, res, async (sse, signal) => {
    await streamToTask(sse, signal, creativeProfile(cfg), cfg, [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ], 'prose');
  });
});

aiRouter.post('/projects/:slug/propose', (req, res) => {
  const { slug } = req.params;
  const body = req.body as ProposalRequest;
  const cfg = loadConfig();
  const outline = loadOutline(slug);
  if (!outline) return res.status(400).json({ error: '本书还没有大纲' });
  const bundle = loadBundle(slug);
  const chapter = readChapter(slug, body.chapterId);
  const { before, after, original } = selectionContext(chapter.title, chapter.content, body.start, body.end);
  let beat = '';
  try {
    beat = locateChapter(outline, body.chapterId).chapter.beat;
  } catch { /* ignore */ }
  const cast = bundle.characters.filter((c) => body.original.includes(c.name)).slice(0, 4);

  const prompt = revisePrompt({
    chapterTitle: chapter.title,
    chapterBeat: beat,
    styleGuide: outline.styleGuide,
    cast,
    before,
    after,
    original,
    kind: body.kind,
    instruction: body.instruction,
  });

  streamTask(req, res, async (sse, signal) => {
    await streamToTask(sse, signal, creativeProfile(cfg), cfg, [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ], 'prose');
  });
});

aiRouter.post('/projects/:slug/check-consistency/:chapterId', async (req, res) => {
  const { slug, chapterId } = req.params;
  try {
    const cfg = loadConfig();
    const outline = loadOutline(slug);
    if (!outline) return res.status(400).json({ error: '本书还没有大纲' });
    const loc = locateChapter(outline, chapterId);
    const bundle = loadBundle(slug);
    const content = readChapter(slug, chapterId).content;
    const prompt = consistencyPrompt({
      chapterTitle: loc.chapter.title,
      content,
      beat: loc.chapter.beat,
      characters: bundle.characters,
      summaries: buildSummariesText(outline, bundle.summaries, chapterId),
      worldview: bundle.worldview,
    });
    const raw = await chatOnce(cfg, assistProfile(cfg), [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ], { kind: 'json', temperature: 0.2, maxTokens: 4000 });
    res.json(extractJson<{ issues: Array<{ severity: string; quote: string; description: string }> }>(raw));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** 对已存项目里的某一卷重新细化章节 beat（AI 重写该卷细纲） */
aiRouter.post('/projects/:slug/refine-volume/:volIndex', async (req, res) => {
  const { slug, volIndex } = req.params;
  try {
    const cfg = loadConfig();
    const outline = loadOutline(slug);
    if (!outline) return res.status(400).json({ error: '本书还没有大纲' });
    const vi = Number(volIndex);
    const vol = outline.volumes[vi];
    if (!vol) return res.status(404).json({ error: '卷不存在' });
    const keepStatus = new Map(vol.chapters.map((c) => [c.id, c.status]));
    const chapterCount = Math.max(1, Math.min(40, Number(req.body?.chapterCount) || vol.chapters.length || 10));
    const kernel: Kernel = {
      premise: outline.premise,
      genre: outline.genre,
      coreConflict: outline.coreConflict,
      endingVision: outline.endingVision,
      styleGuide: outline.styleGuide,
    };
    const neighbors = [outline.volumes[vi - 1], outline.volumes[vi + 1]].filter(Boolean)
      .map((v) => ({ title: v.title, summary: v.summary }));
    const prompt = beatsPrompt(kernel, vol.title, vol.summary, chapterCount, neighbors);
    const raw = await chatOnce(cfg, creativeProfile(cfg), [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ], { kind: 'json', maxTokens: 8192 });
    const parsed = extractJson<{ chapters: Array<{ title: string; beat: string; pov?: string; characters?: string[] }> }>(raw);
    const keepIds = vol.chapters.map((c, i) => c.id).slice(0, parsed.chapters.length);
    const { chapterId: mkId } = await import('../../../shared/src/util');
    vol.chapters = parsed.chapters.map((c, i) => {
      const id = keepIds[i] ?? mkId(vi + 1, i + 1);
      return {
        id,
        title: c.title,
        beat: c.beat,
        pov: c.pov,
        characters: c.characters,
        status: keepStatus.get(id) ?? 'todo',
      } satisfies ChapterBeat;
    });
    saveOutline(slug, outline);
    res.json({ ok: true, volume: vol });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
