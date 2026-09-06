import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  AppConfig, ChapterBeat, ChapterStatus, CharacterCard, Kernel, ProposalRequest, ProviderProfile, Suggestion, Volume,
} from '../../../shared/src/types';
import { loadConfig } from '../config';
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
  getMeta, listChapters, loadBundle, loadOutline, loadSuggestions, readChapter,
  saveChapterBody, saveOutline, saveSuggestions, saveSummaries,
} from '../fs-store';
import { countChars, ensureParagraphIndent } from '../../../shared/src/util';

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
  res.status(410).json({ error: '此接口已升级为服务端后台生成：/generate-bg' });
});

/* ================= 服务端后台生成 =================
   生成任务在服务端执行并直接落盘：浏览器切走/刷新/关闭都不影响。
   页面通过 status 轮询 + progress SSE 订阅进度。 */

interface BgGenTask {
  slug: string;
  chapterId: string;
  mode: 'full' | 'continue';
  status: 'running' | 'done' | 'error' | 'cancelled';
  chars: number;
  error?: string;
  wordCount?: number;
  /** finish_reason=length：正文达到输出上限被截断，可续写补完 */
  truncated?: boolean;
  ctl: AbortController;
}

let bgGen: BgGenTask | null = null;
const genSubscribers = new Set<(line: string) => void>();

function emitGen(evt: unknown): void {
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const fn of genSubscribers) fn(line);
}

async function runBgGeneration(task: BgGenTask): Promise<void> {
  const { slug, chapterId, mode } = task;
  let acc = '';
  try {
    const cfg = loadConfig();
    const outline = loadOutline(slug);
    if (!outline) throw new Error('本书还没有大纲');
    const bundle = loadBundle(slug);
    const existing = mode === 'continue' ? readChapter(slug, chapterId) : null;
    if (mode === 'continue' && !existing?.content.trim()) throw new Error('本章还没有正文，无法续写');

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

    const targetWords = getMeta(slug).wordsPerChapter ?? undefined;
    let prompt;
    if (existing && existing.content.trim()) {
      const cur = countChars(existing.content);
      const remain = targetWords ? Math.max(0, targetWords - cur) : 0;
      const budget = remain > 300 ? `约 ${Math.min(remain, 3000)} 字` : '300~600 字（收尾即可，不必硬撑到目标字数）';
      prompt = continuePrompt(ctx, existing.content, budget);
    } else {
      prompt = prosePrompt(ctx, targetWords);
    }

    const loc = locateChapter(outline, chapterId);
    const title = loc.chapter.title;
    const prevStatus = loc.chapter.status;
    const status: ChapterStatus = prevStatus === 'todo' ? 'draft' : prevStatus;

    if (mode === 'continue' && existing) acc = existing.content;
    const startChars = countChars(acc);
    let finishReason = '';

    // 上游偶发返回空流（高峰期网关过载），自动重试并留间隔
    for (let attempt = 1; attempt <= 3; attempt++) {
      finishReason = '';
      for await (const delta of streamChat(cfg, creativeProfile(cfg), [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ], {
        signal: task.ctl.signal, kind: 'prose',
        onMeta: (m) => {
          finishReason = m.finishReason ?? finishReason;
          if (m.usage) console.error('[moge:bggen] usage:', JSON.stringify(m.usage), 'finish:', finishReason);
        },
      })) {
        acc += delta;
        task.chars = countChars(acc);
        emitGen({ type: 'delta', text: delta });
      }
      if (countChars(acc) > startChars || task.ctl.signal.aborted) break;
      if (attempt < 3) {
        acc = mode === 'continue' && existing ? existing.content : '';
        task.chars = countChars(acc);
        console.error('[moge:bggen] 模型未返回正文（空流），2 秒后自动重试', attempt);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    if (countChars(acc) <= startChars) {
      throw new Error('模型未返回任何正文（已自动重试 3 次），请稍后再试');
    }

    acc = ensureParagraphIndent(acc);
    const wordCount = saveChapterBody(slug, { id: chapterId, title, status, content: acc });
    task.status = 'done';
    task.wordCount = wordCount;
    task.truncated = finishReason === 'length';
    emitGen({ type: 'done', wordCount, truncated: task.truncated });
  } catch (err) {
    const aborted = task.ctl.signal.aborted;
    // 出错/停止时同样保留已生成部分，直接落盘
    try {
      if (acc.trim()) {
        const outline = loadOutline(slug);
        const loc = outline ? locateChapter(outline, chapterId) : null;
        const title = loc?.chapter.title ?? chapterId;
        const prevStatus = loc?.chapter.status ?? 'draft';
        const status: ChapterStatus = prevStatus === 'todo' ? 'draft' : prevStatus;
        const wordCount = saveChapterBody(slug, { id: chapterId, title, status, content: ensureParagraphIndent(acc) });
        task.wordCount = wordCount;
      }
    } catch { /* 保存部分结果失败则忽略 */ }
    task.status = aborted ? 'cancelled' : 'error';
    task.error = aborted ? '已停止' : (err as Error).message;
    emitGen({ type: 'error', message: task.error });
  }
}

aiRouter.post('/projects/:slug/generate-bg/:chapterId', (req, res) => {
  const { slug, chapterId } = req.params;
  const mode = (req.body?.mode as 'full' | 'continue') ?? 'full';
  if (bgGen && bgGen.status === 'running') {
    return res.status(409).json({ error: '已有生成任务进行中，请等待完成或先停止' });
  }
  const outline = loadOutline(slug);
  if (!outline) return res.status(400).json({ error: '本书还没有大纲' });
  try {
    locateChapter(outline, chapterId);
  } catch (err) {
    return res.status(404).json({ error: (err as Error).message });
  }
  const task: BgGenTask = {
    slug, chapterId, mode: mode === 'continue' ? 'continue' : 'full',
    status: 'running', chars: 0, ctl: new AbortController(),
  };
  bgGen = task;
  void runBgGeneration(task);
  res.json({ started: true });
});

aiRouter.get('/projects/:slug/generation-status/:chapterId', (req, res) => {
  const { slug, chapterId } = req.params;
  if (!bgGen || bgGen.slug !== slug || bgGen.chapterId !== chapterId) {
    return res.json({ status: 'idle', chars: 0 });
  }
  res.json({ status: bgGen.status, chars: bgGen.chars, error: bgGen.error, wordCount: bgGen.wordCount, truncated: bgGen.truncated });
});

aiRouter.post('/projects/:slug/generation-cancel/:chapterId', (req, res) => {
  const { slug, chapterId } = req.params;
  if (bgGen && bgGen.slug === slug && bgGen.chapterId === chapterId && bgGen.status === 'running') {
    bgGen.ctl.abort();
  }
  res.json({ ok: true });
});

/** 进度订阅：SSE。页面冻结/关闭只影响预览，不影响服务端生成与落盘。 */
aiRouter.get('/projects/:slug/generation-progress/:chapterId', (req, res) => {
  const { slug, chapterId } = req.params;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  if (bgGen && bgGen.slug === slug && bgGen.chapterId === chapterId) {
    res.write(`data: ${JSON.stringify({ type: 'chars', chars: bgGen.chars })}\n\n`);
  }
  const sub = (line: string) => {
    try { res.write(line); } catch { /* ignore */ }
  };
  genSubscribers.add(sub);
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 15000);
  req.on('close', () => {
    clearInterval(ping);
    genSubscribers.delete(sub);
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
    const keepIds = vol.chapters.map((ch) => ch.id).slice(0, parsed.chapters.length);
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
