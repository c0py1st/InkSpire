import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  AppConfig, ChapterBeat, ChapterStatus, CharacterCard, ConsistencyIssue, GenChapterResult, Kernel, ProposalRequest, ProviderProfile, Suggestion, ToolCall, VolumeBrief,
} from '../../../shared/src/types';
import { loadConfig } from '../config';
import { chatOnce, streamChat, type ChatMessage } from '../ai/provider';
import { TOOL_SPECS, executeTool } from '../ai/tools';
import { extractJson } from '../ai/json';
import { Sse, abortOnClose } from '../ai/sse';
import { buildChapterContext, buildSummariesText, flattenChapterIds, foreshadowText, locateChapter, nextChapterIds, openForeshadowListText, selectionContext } from '../ai/memory';
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
  getMeta, listChapters, loadBundle, loadEvents, loadLorebook, loadOutline, loadRecaps, loadSummaries, loadSuggestions, mergeChapterAutoEvents, readChapter,
  saveChapterBody, saveEvents, saveLoreActivated, saveOutline, saveRecaps, saveSuggestions, saveSummaries,
} from '../fs-store';
import { recapFingerprint, stateAtChapter } from '../../../shared/src/types';
import { loadCacheStats, recordUsage } from '../cache-stats';
import { l0Check, looksAncientSetting, type L0Finding } from '../../../shared/src/l0';
import { loadL0Report, saveChapterL0 } from '../l0-report';
import { verifyIssueQuotes, verifyQuote } from '../quote-verify';
import { readerReviewPrompt, normalizeReaderReview, goldenThreePrompt, normalizeGoldenThree } from '../ai/prompts/reader';
import { buildHealthReport } from '../health-aggregate';
import { recapPrompt } from '../ai/prompts/recap';
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

/** 路由入口统一做模型配置检查：未配置直接 400，流式函数内部不再兜 null */
function requireCreative(cfg: AppConfig, res: Response): ProviderProfile | null {
  const p = creativeProfile(cfg);
  if (!p) res.status(400).json({ error: '尚未配置模型，请先到设置页添加配置档' });
  return p;
}

async function streamToTask(
  sse: Sse,
  signal: AbortSignal,
  profile: ProviderProfile,
  cfg: AppConfig,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  kind: 'json' | 'prose' | 'summary',
  maxTokens?: number,
  temperature?: number,
  onMeta?: (meta: { finishReason?: string }) => void,
): Promise<string> {
  let full = '';
  for await (const delta of streamChat(cfg, profile, messages, { signal, kind, maxTokens, temperature, onMeta })) {
    full += delta;
    sse.delta(delta);
  }
  return full;
}

/* ================= 创作向导（无状态：上下文由前端带回传） ================= */

aiRouter.post('/wizard/kernel', (req, res) => {
  const { ideaPrompt, scale } = req.body as { ideaPrompt: string; scale: { volumeCount: number; chaptersPerVolume: number; wordsPerChapter: number } };
  const cfg = loadConfig();
  const profile = requireCreative(cfg, res);
  if (!profile) return;
  const prompt = kernelPrompt(ideaPrompt, scale);
  streamTask(req, res, async (sse, signal) => {
    const full = await streamToTask(sse, signal, profile, cfg, [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ], 'json', 8192);
    sse.send({ type: 'final', kernel: extractJson<Kernel>(full) });
  });
});

aiRouter.post('/wizard/volumes', (req, res) => {
  const { kernel, volumeCount } = req.body as { kernel: Kernel; volumeCount: number };
  const cfg = loadConfig();
  const profile = requireCreative(cfg, res);
  if (!profile) return;
  const prompt = volumesPrompt(kernel, volumeCount);
  streamTask(req, res, async (sse, signal) => {
    const full = await streamToTask(sse, signal, profile, cfg, [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ], 'json', 8192);
    sse.send({ type: 'final', volumes: extractJson<{ volumes: Array<{ title: string; summary: string }> }>(full).volumes });
  });
});

aiRouter.post('/wizard/beats', (req, res) => {
  const { kernel, volumes, volIndex, chapterCount, webnovel } = req.body as {
    kernel: Kernel; volumes: VolumeBrief[]; volIndex: number; chapterCount: number; webnovel?: boolean;
  };
  const cfg = loadConfig();
  const profile = requireCreative(cfg, res);
  if (!profile) return;
  const vol = volumes[volIndex];
  if (!vol) return res.status(400).json({ error: '卷不存在' });
  const neighbors = [volumes[volIndex - 1], volumes[volIndex + 1]].filter(Boolean)
    .map((v) => ({ title: v.title, summary: v.summary }));
  const prompt = beatsPrompt(kernel, vol.title, vol.summary, chapterCount, neighbors, { webnovel: !!webnovel });
  streamTask(req, res, async (sse, signal) => {
    const full = await streamToTask(sse, signal, profile, cfg, [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ], 'json', 8192);
    sse.send({ type: 'final', chapters: extractJson<{ chapters: Array<{ title: string; beat: string; pov?: string; characters?: string[]; payoffPoint?: string; chapterHook?: string }> }>(full).chapters });
  });
});

aiRouter.post('/wizard/bible', (req, res) => {
  const { kernel, volumes } = req.body as { kernel: Kernel; volumes: VolumeBrief[] };
  const cfg = loadConfig();
  const profile = requireCreative(cfg, res);
  if (!profile) return;
  const prompt = biblePrompt(kernel, volumes);
  streamTask(req, res, async (sse, signal) => {
    const full = await streamToTask(sse, signal, profile, cfg, [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ], 'json', 8192);
    sse.send({ type: 'final', bible: extractJson<{ characters: CharacterCard[]; worldview: string }>(full) });
  });
});

/* ================= 正文生成（服务端后台任务队列） =================
   生成在服务端执行并直接落盘：浏览器切走/刷新/关闭都不影响。
   单章生成 = 长度为 1 的队列；挂机连写 = 按大纲顺序排入 N 章。
   页面通过 status 轮询 + progress SSE 订阅进度。 */

interface QueueItem { chapterId: string; mode: 'full' | 'continue' }

type ChapterResult = GenChapterResult;

interface BgGenTask {
  slug: string;
  items: QueueItem[];
  /** 已完成/跳过的章结果（含建队时预知的 skipped） */
  results: ChapterResult[];
  index: number;
  status: 'running' | 'done' | 'error' | 'cancelled';
  /** 当前章本次已生成字数 */
  chars: number;
  error?: string;
  stopRequested: boolean;
  ctl: AbortController;
}

let bgGen: BgGenTask | null = null;
const genSubscribers = new Set<(line: string) => void>();

function emitGen(evt: unknown): void {
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const fn of genSubscribers) fn(line);
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

/** 请求的章是否属于当前队列（起点章、任一待写章、任一已出结果章都算） */
function queuedChapter(task: BgGenTask, chapterId: string): boolean {
  return task.items.some((i) => i.chapterId === chapterId)
    || task.results.some((r) => r.chapterId === chapterId);
}

function queueSummary(task: BgGenTask) {
  const cur = task.items[task.index]?.chapterId ?? '';
  const doneWordTotal = task.results.reduce((a, r) => a + (r.wordCount ?? 0), 0);
  const last = task.results[task.results.length - 1];
  return {
    status: task.status,
    chars: task.chars,
    error: task.error,
    wordCount: task.items.length === 1 ? (last?.wordCount ?? 0) : doneWordTotal,
    truncated: task.items.length === 1 ? last?.truncated : task.results.some((r) => r.truncated),
    currentChapterId: cur,
    queue: { index: task.index, total: task.items.length, results: task.results },
  };
}

/** 生成一章：空流重试、截断自动补一次、落盘（full 覆盖前强制备份）、自动归档 */
async function runOneChapter(task: BgGenTask, item: QueueItem): Promise<ChapterResult> {
  const { slug } = task;
  const { chapterId, mode } = item;
  let acc = '';
  const result: ChapterResult = { chapterId, status: 'done' };
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
      recaps: bundle.recaps,
      prevChapterContent: prevContent,
      foreshadows: bundle.foreshadows,
      lorebook: loadLorebook(slug),
    });
    if (ctx.loreTrace) {
      saveLoreActivated(slug, chapterId, ctx.loreTrace.activated, ctx.loreTrace.dropped);
    }

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
          if (m.usage) {
            recordUsage(slug, { source: 'prose', chapterId, usage: m.usage });
            console.error('[moge:bggen] usage:', JSON.stringify(m.usage), 'finish:', finishReason);
          }
        },
      })) {
        acc += delta;
        task.chars = countChars(acc);
        emitGen({ type: 'delta', chapterId, text: delta });
      }
      if (countChars(acc) > startChars || task.ctl.signal.aborted) break;
      if (attempt < 3) {
        acc = mode === 'continue' && existing ? existing.content : '';
        task.chars = countChars(acc);
        console.error('[moge:bggen] 模型未返回正文（空流），2 秒后自动重试', attempt);
        await sleep(2000);
      }
    }

    if (countChars(acc) <= startChars) {
      throw new Error('模型未返回任何正文（已自动重试 3 次），请稍后再试');
    }

    // 截断自动补完：续写一次收尾；仍截断则如实标记留给人工
    if (finishReason === 'length' && !task.ctl.signal.aborted) {
      let tailReason = '';
      const before = acc;
      const cont = continuePrompt(ctx, acc, '400~800 字，把本章收束到 beat 终点');
      try {
        for await (const delta of streamChat(cfg, creativeProfile(cfg), [
          { role: 'system', content: cont.system },
          { role: 'user', content: cont.user },
        ], {
          signal: task.ctl.signal, kind: 'prose',
          onMeta: (m) => {
            tailReason = m.finishReason ?? tailReason;
            if (m.usage) recordUsage(slug, { source: 'prose-cont', chapterId, usage: m.usage });
          },
        })) {
          acc += delta;
          task.chars = countChars(acc);
          emitGen({ type: 'delta', chapterId, text: delta });
        }
      } catch { /* 补完失败保留原截断稿 */ }
      if (countChars(acc) === countChars(before)) tailReason = finishReason; // 补完没产出，仍算截断
      finishReason = tailReason;
    }

    acc = ensureParagraphIndent(acc);
    // full 模式会覆盖盘上旧稿：无论长度先强制备份（旧稿很短时 <70% 规则不成立）
    const hadOld = mode === 'full' && !!readChapter(slug, chapterId).content.trim();
    const wordCount = saveChapterBody(slug, { id: chapterId, title, status, content: acc }, hadOld);
    result.wordCount = wordCount;
    result.truncated = finishReason === 'length';
    emitGen({ type: 'done', chapterId, wordCount, truncated: result.truncated });

    // 自动归档维持记忆闭环（连写下一章要读本章摘要）；归档失败只记录，不影响本章成功
    if (!task.stopRequested && !task.ctl.signal.aborted) {
      try {
        await finalizeChapterCore(slug, chapterId);
        result.archived = true;
      } catch (err) {
        result.archived = false;
        console.error('[moge:bggen] 自动归档失败：', (err as Error).message);
      }
    }
    return result;
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
        const hadOld = mode === 'full' && !!readChapter(slug, chapterId).content.trim();
        result.wordCount = saveChapterBody(slug, { id: chapterId, title, status, content: ensureParagraphIndent(acc) }, hadOld);
      }
    } catch { /* 保存部分结果失败则忽略 */ }
    result.status = aborted ? 'cancelled' : 'error';
    result.error = aborted ? '已停止' : (err as Error).message;
    return result;
  }
}

/** 队列主循环：逐章生成，失败即整队停止（已完成章保留），章间留喘息 */
async function runBgQueue(task: BgGenTask): Promise<void> {
  for (; task.index < task.items.length; task.index++) {
    if (task.stopRequested || task.ctl.signal.aborted) break;
    task.chars = 0;
    const item = task.items[task.index];
    emitGen({ type: 'chapter-start', chapterId: item.chapterId, index: task.index, total: task.items.length });
    const result = await runOneChapter(task, item);
    task.results.push(result);
    emitGen({ type: 'chapter-done', ...result });
    if (result.status === 'error') {
      task.error = result.error;
      task.status = 'error';
      break;
    }
    if (result.status === 'cancelled') { task.status = 'cancelled'; break; }
    if (task.index < task.items.length - 1) await sleep(1500); // 减轻高峰限流连锁
  }
  if (task.status === 'running') {
    task.status = task.stopRequested || task.ctl.signal.aborted ? 'cancelled' : 'done';
  }
  emitGen({ type: 'queue-done', status: task.status, error: task.error, results: task.results });
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
    slug,
    items: [{ chapterId, mode: mode === 'continue' ? 'continue' : 'full' }],
    results: [], index: 0,
    status: 'running', chars: 0, stopRequested: false, ctl: new AbortController(),
  };
  bgGen = task;
  void runBgQueue(task);
  res.json({ started: true });
});

/** 挂机连写：从指定章起按大纲顺序最多连写 count 章；已有正文的章跳过 */
aiRouter.post('/projects/:slug/generate-marathon', (req, res) => {
  const { slug } = req.params;
  const fromChapterId = String(req.body?.fromChapterId ?? '');
  const count = Math.max(1, Math.min(50, Number(req.body?.count) || 5));
  if (bgGen && bgGen.status === 'running') {
    return res.status(409).json({ error: '已有生成任务进行中，请等待完成或先停止' });
  }
  const outline = loadOutline(slug);
  if (!outline) return res.status(400).json({ error: '本书还没有大纲' });
  let planned: string[];
  try {
    planned = nextChapterIds(outline, fromChapterId, count);
  } catch (err) {
    return res.status(404).json({ error: (err as Error).message });
  }
  const task: BgGenTask = {
    slug, items: [], results: [], index: 0,
    status: 'running', chars: 0, stopRequested: false, ctl: new AbortController(),
  };
  for (const cid of planned) {
    let hasBody = false;
    try { hasBody = !!readChapter(slug, cid).content.trim(); } catch { /* 无文件视为空 */ }
    if (hasBody) task.results.push({ chapterId: cid, status: 'skipped' });
    else task.items.push({ chapterId: cid, mode: 'full' });
  }
  bgGen = task;
  void runBgQueue(task);
  res.json({ started: true, planned: task.items.length, skipped: task.results.length });
});

aiRouter.get('/projects/:slug/generation-status/:chapterId', (req, res) => {
  const { slug, chapterId } = req.params;
  if (!bgGen || bgGen.slug !== slug || !queuedChapter(bgGen, chapterId)) {
    return res.json({ status: 'idle', chars: 0 });
  }
  res.json(queueSummary(bgGen));
});

aiRouter.post('/projects/:slug/generation-cancel/:chapterId', (req, res) => {
  const { slug, chapterId } = req.params;
  if (bgGen && bgGen.slug === slug && queuedChapter(bgGen, chapterId) && bgGen.status === 'running') {
    bgGen.stopRequested = true;
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
  if (bgGen && bgGen.slug === slug && queuedChapter(bgGen, chapterId)) {
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

/**
 * 确保某卷的卷回本存在且新鲜。三种结果：
 * - 'fresh'：指纹已匹配，无需重算；
 * - 'incomplete'：该卷尚未逐章归档齐（回本无从压起），附进度；
 * - 'generated'：调辅助模型压出回本并落盘。
 * 指纹由「该卷有序章摘要」算出——任一章摘要变动即失效，下次自动重压。
 */
export async function ensureVolumeRecap(
  slug: string, volumeId: string,
): Promise<{ status: 'fresh' } | { status: 'incomplete'; done: number; total: number } | { status: 'generated' }> {
  const outline = loadOutline(slug);
  const vol = outline?.volumes.find((v) => v.id === volumeId);
  if (!vol || !vol.chapters.length) return { status: 'incomplete', done: 0, total: vol?.chapters.length ?? 0 };
  const summaries = loadSummaries(slug);
  const done = vol.chapters.filter((c) => (summaries[c.id] ?? '').trim()).length;
  if (done < vol.chapters.length) return { status: 'incomplete', done, total: vol.chapters.length };
  const fp = recapFingerprint(vol, summaries);
  const recaps = loadRecaps(slug);
  if (recaps[volumeId]?.fingerprint === fp) return { status: 'fresh' };
  const cfg = loadConfig();
  const prompt = recapPrompt({
    volumeTitle: vol.title,
    volumeSummary: vol.summary,
    chapters: vol.chapters.map((c) => ({ title: c.title, summary: summaries[c.id] })),
  });
  const raw = await chatOnce(cfg, assistProfile(cfg), [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ], {
    kind: 'json', temperature: 0.3, maxTokens: 2000,
    onMeta: (m) => { if (m.usage) recordUsage(slug, { source: 'recap', chapterId: volumeId, usage: m.usage }); },
  });
  const parsed = extractJson<{ recap: string }>(raw);
  if (!parsed.recap?.trim()) throw new Error('卷回本生成为空');
  recaps[volumeId] = { recap: parsed.recap.trim(), fingerprint: fp, updatedAt: new Date().toISOString() };
  saveRecaps(slug, recaps);
  return { status: 'generated' };
}

/** 章节完稿：生成摘要、探测新设定，写入 suggestions */
/**
 * 章节归档核心（路由与连写队列共用）：
 * 生成摘要写入 summaries.json，探测新人物/新设定/人物状态变更并落建议卡。
 * contentIn 省略时从磁盘读最新正文。抛错由调用方处理。
 */
export async function finalizeChapterCore(
  slug: string, chapterId: string, contentIn?: string,
): Promise<{ summary: string; newSuggestions: Suggestion[]; l0: L0Finding[] }> {
  const cfg = loadConfig();
  const outline = loadOutline(slug);
  if (!outline) throw new Error('本书还没有大纲');
  // 优先磁盘最新正文，避免依赖调用方传参、也容错空传参
  let content = String(contentIn ?? '').trim();
  if (!content) {
    try { content = readChapter(slug, chapterId).content.trim(); } catch { /* 忽略 */ }
  }
  if (!content) throw new Error('正文为空');

  const loc = locateChapter(outline, chapterId);
  const bundle = loadBundle(slug);
  const prompt = summaryPrompt({
    chapterTitle: loc.chapter.title,
    content: content.slice(0, 20000),
    knownCharacters: bundle.characters.map((c) => c.name),
    characterStates: bundle.characters.map((c) => ({ name: c.name, state: c.state ?? '' })),
    beat: loc.chapter.beat,
  });
  // 辅助 JSON 任务：deepseek 推理型模型需要为思考预留 token，给足 max_tokens
  const raw = await chatOnce(cfg, assistProfile(cfg), [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ], { kind: 'json', temperature: 0.3, maxTokens: 4000,
    onMeta: (m) => { if (m.usage) recordUsage(slug, { source: 'summary', chapterId, usage: m.usage }); } });
  const parsed = extractJson<{
    summary: string;
    newCharacters: Array<{ name: string; reason: string }>;
    worldNotes: string[];
    stateChanges?: Array<{ name: string; newState: string; reason?: string }>;
    beatDrift?: { drifted?: boolean; problem?: string; newBeat?: string };
    events?: Array<{ title?: string; detail?: string; actors?: string[]; when?: string }>;
  }>(raw);

  const summaries = { ...bundle.summaries, [chapterId]: parsed.summary };
  saveSummaries(slug, summaries);

  // 世界事件账本：本章旧的 auto 提取整批换新，作者 manual 补记不动；失败只记日志不拖累归档
  try {
    const autoEvents = (parsed.events ?? []).slice(0, 4).flatMap((ev, k) => {
      const title = ev?.title?.trim();
      if (!title) return [];
      return [{
        id: `ev-${chapterId}-${Date.now()}-${k}`,
        chapterId,
        title: title.slice(0, 160),
        ...(ev.detail?.trim() ? { detail: ev.detail.trim().slice(0, 600) } : {}),
        ...((ev.actors ?? []).some((a) => a?.trim()) ? { actors: (ev.actors ?? []).filter((a) => a?.trim()).map((a) => a.trim().slice(0, 30)).slice(0, 8) } : {}),
        ...(ev.when?.trim() ? { whenInStory: ev.when.trim().slice(0, 60) } : {}),
        source: 'auto' as const,
        at: new Date().toISOString(),
      }];
    });
    saveEvents(slug, mergeChapterAutoEvents(loadEvents(slug), chapterId, autoEvents));
  } catch (err) {
    console.error('[events] 事件提取落盘失败（不影响归档）：', (err as Error).message);
  }

  const suggestions = loadSuggestions(slug);
  const existingNames = new Set(bundle.characters.map((c) => c.name));
  const src = { sourceChapterId: chapterId, sourceChapterTitle: loc.chapter.title };
  const added: Suggestion[] = [];
  for (const nc of parsed.newCharacters ?? []) {
    if (!nc.name?.trim() || existingNames.has(nc.name.trim())) continue;
    existingNames.add(nc.name.trim());
    added.push({
      id: `sug-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: 'character',
      name: nc.name.trim(),
      content: nc.reason ?? '',
      ...src,
      createdAt: new Date().toISOString(),
    });
  }
  const worldAdded: Suggestion[] = (parsed.worldNotes ?? []).filter((w) => w?.trim()).map((w) => ({
    id: `sug-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind: 'world' as const,
    name: '世界观补充',
    content: w,
    ...src,
    createdAt: new Date().toISOString(),
  }));
  // 状态变更建议：只针对已建档人物；同名人物的旧待审状态卡被新观察覆盖
  const cardByName = new Map(bundle.characters.map((c) => [c.name, c]));
  const stateAdded: Suggestion[] = [];
  for (const sc of parsed.stateChanges ?? []) {
    const name = sc.name?.trim();
    const card = name ? cardByName.get(name) : undefined;
    if (!card || !sc.newState?.trim()) continue;
    if ((card.state ?? '').trim() === sc.newState.trim()) continue;
    if (stateAdded.some((s) => s.name === name)) continue;
    stateAdded.push({
      id: `sug-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: 'state',
      name,
      content: sc.newState.trim(),
      note: sc.reason?.trim() || undefined,
      ...src,
      createdAt: new Date().toISOString(),
    });
  }
  // 大纲修订建议卡：drifted=true 且给出新 beat 才生成（人采纳才改 outline，绝不静默改契约）。
  // 同一章若已有待审大纲卡，被本次新观察覆盖（与 state 卡去重同理）。
  const outlineAdded: Suggestion[] = [];
  if (parsed.beatDrift?.drifted && parsed.beatDrift.newBeat?.trim()) {
    outlineAdded.push({
      id: `sug-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: 'outline',
      name: loc.chapter.title,
      content: parsed.beatDrift.newBeat.trim(),
      note: parsed.beatDrift.problem?.trim() || undefined,
      ...src,
      createdAt: new Date().toISOString(),
    });
  }
  const superseded = new Set(stateAdded.map((s) => s.name));
  const supersededOutline = outlineAdded.length > 0 && src.sourceChapterId;
  const kept = suggestions.filter((s) =>
    !(s.kind === 'state' && superseded.has(s.name))
    && !(s.kind === 'outline' && supersededOutline && s.sourceChapterId === src.sourceChapterId));
  const all = [...kept, ...added, ...worldAdded, ...stateAdded, ...outlineAdded].slice(-50);
  saveSuggestions(slug, all);

  // L0 确定性预检（零模型成本）：归档顺手做一次体检，结果落 .index 缓存供体检面板消费。
  // 纯函数派生数据，失败绝不影响归档主流程。
  let l0Findings: L0Finding[] = [];
  try {
    l0Findings = runL0ForChapter(slug, chapterId, outline, content);
  } catch (err) {
    console.error('[l0] 预检失败（不影响归档）：', (err as Error).message);
  }

  // 本卷就此归档齐 → 顺带压一条卷回本（每卷至多一次模型调用）。
  // 失败只记日志：回本缺失时注入自动退回逐章摘要，不该连累归档主流程。
  try {
    await ensureVolumeRecap(slug, loc.volume.id);
  } catch (err) {
    console.error(`[recap] 卷回本生成失败（${loc.volume.id}）：`, (err as Error).message);
  }

  return { summary: parsed.summary, newSuggestions: [...added, ...worldAdded, ...stateAdded, ...outlineAdded], l0: l0Findings };
}

/** 跑一章的 L0 预检并写缓存：题材决定是否启用默认现代词表（都市题材必误报） */
function runL0ForChapter(slug: string, chapterId: string, outline: NonNullable<ReturnType<typeof loadOutline>>, content?: string): L0Finding[] {
  const text = content?.trim() ? content : readChapter(slug, chapterId).content;
  const targetWords = getMeta(slug).wordsPerChapter;
  const findings = l0Check(text, {
    targetWords,
    ancientSetting: looksAncientSetting(`${outline.genre} ${outline.styleGuide} ${outline.premise}`),
  });
  saveChapterL0(slug, chapterId, findings);
  return findings;
}

/** 手动/按需预检一章 */
aiRouter.post('/projects/:slug/l0/:chapterId', (req, res) => {
  const { slug, chapterId } = req.params;
  try {
    const outline = loadOutline(slug);
    if (!outline) return res.status(400).json({ error: '本书还没有大纲' });
    res.json({ findings: runL0ForChapter(slug, chapterId, outline) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 全书 L0 报告（.index 缓存投影；从未跑过的章不在表内，面板按需补跑） */
aiRouter.get('/projects/:slug/l0', (req, res) => {
  try {
    res.json(loadL0Report(req.params.slug));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 全书体检报告：纯统计 + 已有缓存汇总，零模型调用（冲突率类检查属一致性职责） */
aiRouter.get('/projects/:slug/health', (req, res) => {
  try {
    const { slug } = req.params;
    const bundle = loadBundle(slug);
    if (!bundle.outline) return res.status(400).json({ error: '本书还没有大纲' });
    res.json(buildHealthReport({
      outline: bundle.outline,
      summaries: bundle.summaries,
      foreshadows: bundle.foreshadows,
      characters: bundle.characters,
      bodies: listChapters(slug).map((c) => ({ id: c.id, content: c.content })),
      l0: loadL0Report(slug),
      usage: loadCacheStats(slug),
    }));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 全书 L0 重跑（纯代码零成本）：逐章预检并刷新缓存 */
aiRouter.post('/projects/:slug/l0-rerun', (req, res) => {
  try {
    const { slug } = req.params;
    const outline = loadOutline(slug);
    if (!outline) return res.status(400).json({ error: '本书还没有大纲' });
    const order = flattenChapterIds(outline);
    const existing = new Set(listChapters(slug).map((c) => c.id));
    let checked = 0; let flagged = 0; let high = 0;
    for (const cid of order) {
      if (!existing.has(cid)) continue; // 无正文的章不检
      checked++;
      try {
        const findings = runL0ForChapter(slug, cid, outline);
        if (findings.length) flagged++;
        high += findings.filter((f) => f.severity === 'high').length;
      } catch { /* 单章失败不拖垮全书 */ }
    }
    res.json({ checked, flagged, high });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

aiRouter.post('/projects/:slug/finalize-chapter/:chapterId', async (req, res) => {
  const { slug, chapterId } = req.params;
  try {
    res.json(await finalizeChapterCore(slug, chapterId, String(req.body?.content ?? '')));
  } catch (err) {
    const msg = (err as Error).message;
    const status = msg.includes('还没有大纲') || msg === '正文为空' ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

/** 手动（重）建某卷卷回本：归档时自动压过，这里供"整卷补齐旧章后回填""强制重压" */
aiRouter.post('/projects/:slug/volume-recap/:volumeId', async (req, res) => {
  const { slug, volumeId } = req.params;
  try {
    const out = await ensureVolumeRecap(slug, volumeId);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ================= 批注抽屉 ================= */

/** ReAct 循环预算：最多 5 轮；最后一轮禁工具，强制收敛到直接回答 */
const MAX_REACT_STEPS = 5;

async function runChatReact(
  sse: Sse,
  signal: AbortSignal,
  cfg: AppConfig,
  profile: ProviderProfile,
  slug: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<void> {
  const conversation: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  let toolsSupported = true;
  let stepsUsed = 0;
  let truncated = false;

  for (let step = 0; step < MAX_REACT_STEPS; step++) {
    if (signal.aborted) break;
    const isLast = step === MAX_REACT_STEPS - 1;
    const useTools = toolsSupported && !isLast;
    let finishReason = '';
    let calls: ToolCall[] = [];
    let text = '';
    try {
      for await (const delta of streamChat(cfg, profile, conversation, {
        signal, kind: 'prose',
        // 末轮不带 tools 即物理禁调用；tool_choice 只随 tools 一起发，
        // 否则部分平台对"有 tool_choice 无 tools"报 400
        ...(useTools ? { tools: TOOL_SPECS, toolChoice: 'auto' as const } : {}),
        onMeta: (m) => {
          finishReason = m.finishReason ?? finishReason;
          if (m.usage) recordUsage(slug, { source: 'chat', usage: m.usage });
        },
        onToolCalls: (c) => { calls = c; },
      })) {
        text += delta;
        sse.delta(delta);
      }
    } catch (err) {
      // 平台不认识 tools 参数（请求建立期即 400，无任何增量）：降级为普通对话重试本轮
      const msg = (err as Error).message ?? '';
      if (useTools && text === '' && /tool|400|not support|unsupported|invalid/i.test(msg)) {
        toolsSupported = false;
        sse.send({ type: 'tool', phase: 'end', name: '_degraded', detail: '该平台不支持工具调用，已降级为普通对话' });
        step--; // 降级重试不消耗轮次预算
        continue;
      }
      throw err;
    }
    if (signal.aborted) break;

    if (finishReason === 'tool_calls' && calls.length && !isLast) {
      stepsUsed++;
      conversation.push({ role: 'assistant', content: text || null, tool_calls: calls });
      for (const call of calls) {
        sse.send({ type: 'tool', phase: 'start', name: call.function.name, detail: '' });
        const outcome = executeTool(slug, call);
        if (outcome.proposal) sse.send({ type: 'proposal', ...outcome.proposal });
        sse.send({ type: 'tool', phase: 'end', name: call.function.name, detail: outcome.detail });
        conversation.push({ role: 'tool', tool_call_id: call.id, content: outcome.content });
      }
      continue;
    }

    truncated = finishReason === 'length';
    break; // 正常文本收尾
  }

  sse.send({ type: 'final', steps: stepsUsed, truncated: truncated || undefined });
}

aiRouter.post('/projects/:slug/chat', (req, res) => {
  const { slug } = req.params;
  const { messages, chapterId, selection } = req.body as {
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    chapterId?: string;
    selection?: string;
  };
  const cfg = loadConfig();
  const profile = requireCreative(cfg, res);
  if (!profile) return;
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
    summaries: outline ? buildSummariesText(outline, bundle.summaries, chapterId ?? '', bundle.recaps) : '',
    foreshadows: outline
      ? (chapterId
        ? foreshadowText(outline, bundle.foreshadows, chapterId)
        : openForeshadowListText(outline, bundle.foreshadows))
      : '',
    chapterTitle,
    chapterBeat,
    chapterContent,
    selection,
    history,
    question,
  });

  streamTask(req, res, async (sse, signal) => {
    await runChatReact(sse, signal, cfg, profile, slug,
      prompt.system + '\n\n工作方式：你可以调用工具查书（搜索前文、读人物卡、读伏笔表、读世界事件时间线、读世界书条目、读任意章原文）后再回答，不要凭记忆瞎猜；'
      + '作者要求"记一下伏笔"时用 register_foreshadow；涉及修改整章正文或重写摘要时，'
      + '只能用 propose_chapter_content / propose_summary 提交提案（由作者采纳），绝不声称已经直接改好了正文。'
      + '指令执行原则：作者已给出明确指令（说清了目标章与想要的动作）时，查证事实后直接完成它——该提提案就提提案、该登记就登记，不要再追问方向或请求确认；'
      + '只有当关键信息确实缺失、或与大纲/前情存在明显冲突时才反问，且一次性把所有问题问完。',
      prompt.user);
  });
});

aiRouter.post('/projects/:slug/propose', (req, res) => {
  const { slug } = req.params;
  const body = req.body as ProposalRequest;
  const cfg = loadConfig();
  const profile = requireCreative(cfg, res);
  if (!profile) return;
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
    prevText: body.prevText,
  });

  // 按任务的发散度定温度：保语义任务低温求稳，求变化任务略高但不放纵；
  // 迭代改写在上版基础上定向修改，取更稳的 0.7
  const kindTemperature: Record<string, number> = {
    polish: 0.7, condense: 0.7, expand: 0.95, rewrite: 1.0, custom: 0.9,
  };

  streamTask(req, res, async (sse, signal) => {
    await streamToTask(sse, signal, profile, cfg, [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ], 'prose', undefined, body.prevText ? 0.7 : (kindTemperature[body.kind] ?? 0.9));
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
      characters: bundle.characters.map((c) =>
        Array.isArray(c.stateHistory) && c.stateHistory.length ? { ...c, state: stateAtChapter(c, chapterId) } : c),
      summaries: buildSummariesText(outline, bundle.summaries, chapterId, bundle.recaps),
      worldview: bundle.worldview,
      foreshadows: foreshadowText(outline, bundle.foreshadows, chapterId),
    });
    const raw = await chatOnce(cfg, assistProfile(cfg), [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ], { kind: 'json', temperature: 0.2, maxTokens: 4000,
      onMeta: (m) => { if (m.usage) recordUsage(slug, { source: 'consistency', chapterId, usage: m.usage }); } });
    res.json({ issues: verifyIssueQuotes(extractJson<{ issues: ConsistencyIssue[] }>(raw).issues ?? [], content) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** 读者模拟评审（E2）：三 persona 独立给本章的阅读体验打分，抱怨必须带逐字引证并服务端验真 */
aiRouter.post('/projects/:slug/review/:chapterId', async (req, res) => {
  const { slug, chapterId } = req.params;
  try {
    const cfg = loadConfig();
    const outline = loadOutline(slug);
    if (!outline) return res.status(400).json({ error: '本书还没有大纲' });
    const loc = locateChapter(outline, chapterId);
    const content = readChapter(slug, chapterId).content;
    if (!content.trim()) return res.status(400).json({ error: '本章还没有正文，先写/生成再评审' });
    const webnovel = !!getMeta(slug).webnovelMode;
    const prompt = readerReviewPrompt({
      chapterTitle: loc.chapter.title,
      content: content.slice(0, 20000),
      webnovel,
      ...(loc.chapter.payoffPoint?.trim() ? { payoffPoint: loc.chapter.payoffPoint.trim() } : {}),
      ...(loc.chapter.chapterHook?.trim() ? { chapterHook: loc.chapter.chapterHook.trim() } : {}),
    });
    const raw = await chatOnce(cfg, creativeProfile(cfg), [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ], { kind: 'json', temperature: 0.5, maxTokens: 4000,
      onMeta: (m) => { if (m.usage) recordUsage(slug, { source: 'review', chapterId, usage: m.usage }); } });
    const report = normalizeReaderReview(extractJson<unknown>(raw));
    if (!report) return res.status(502).json({ error: '评审返回结构不可用，请重试' });
    // 引证验真：每条 grievance 的 quote 落地到本章正文（与一致性检查同一口径）
    for (const p of report.personas) for (const g of p.grievances) g.verified = verifyQuote(g.quote, content);
    // A2：范文候选验真——编造的"原文"不配进范文库，未逐字命中的直接丢弃
    if (report.highlights?.length) {
      report.highlights = report.highlights.flatMap((h) => {
        const v = verifyQuote(h.excerpt, content);
        return v ? [{ ...h, verified: v }] : [];
      });
      if (!report.highlights.length) delete report.highlights;
    }
    res.json({ report });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** 黄金三章评审（E4）：开篇当批送审，逐章 GO/REVISE/REWRITE + 综合留存评分，引证逐字验真 */
aiRouter.post('/projects/:slug/golden-three', async (req, res) => {
  const { slug } = req.params;
  try {
    const cfg = loadConfig();
    const outline = loadOutline(slug);
    if (!outline) return res.status(400).json({ error: '本书还没有大纲' });
    const order = flattenChapterIds(outline);
    const titleOf = new Map<string, string>();
    const hookOf = new Map<string, string>();
    for (const v of outline.volumes) for (const c of v.chapters) {
      titleOf.set(c.id, c.title);
      if (c.chapterHook?.trim()) hookOf.set(c.id, c.chapterHook.trim());
    }
    // 取有正文的前三章（不足三章就有几章评审几章）
    const firstChapters: Array<{ index: number; title: string; content: string; chapterHook?: string; id: string }> = [];
    for (const cid of order) {
      const content = readChapter(slug, cid).content;
      if (content.trim()) {
        firstChapters.push({ index: firstChapters.length + 1, title: titleOf.get(cid) ?? cid, id: cid, content, ...(hookOf.get(cid) ? { chapterHook: hookOf.get(cid) } : {}) });
        if (firstChapters.length >= 3) break;
      }
    }
    if (firstChapters.length === 0) return res.status(400).json({ error: '还没有任何有正文的章节，无法评审开篇' });
    const prompt = goldenThreePrompt({
      chapters: firstChapters.map((c) => ({ index: c.index, title: c.title, content: c.content, ...(c.chapterHook ? { chapterHook: c.chapterHook } : {}) })),
      genre: outline.genre,
    });
    const raw = await chatOnce(cfg, creativeProfile(cfg), [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ], { kind: 'json', temperature: 0.4, maxTokens: 4000,
      onMeta: (m) => { if (m.usage) recordUsage(slug, { source: 'golden', usage: m.usage }); } });
    const report = normalizeGoldenThree(extractJson<unknown>(raw));
    if (!report) return res.status(502).json({ error: '评审返回结构不可用，请重试' });
    // 章节身份按位置以真实前三章覆盖：模型只许裁决，不许自报坐标（echo 错位/漏 index 会毁掉验真与跳转）
    report.chapters = report.chapters.slice(0, firstChapters.length).map((ch, i) => ({
      ...ch,
      index: i + 1,
      title: firstChapters[i].title,
      chapterId: firstChapters[i].id,
    }));
    // 每章引证按各自正文验真
    for (const ch of report.chapters) {
      const src = firstChapters[ch.index - 1];
      for (const g of ch.grievances) g.verified = src ? verifyQuote(g.quote, src.content) : false;
    }
    res.json({ report, reviewed: firstChapters.map((c) => ({ id: c.id, title: c.title })) });
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
    const webnovel = !!getMeta(slug).webnovelMode;
    const prompt = beatsPrompt(kernel, vol.title, vol.summary, chapterCount, neighbors, { webnovel });
    const raw = await chatOnce(cfg, creativeProfile(cfg), [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ], { kind: 'json', maxTokens: 8192,
      onMeta: (m) => { if (m.usage) recordUsage(slug, { source: 'beats', usage: m.usage }); } });
    const parsed = extractJson<{ chapters: Array<{ title: string; beat: string; pov?: string; characters?: string[]; payoffPoint?: string; chapterHook?: string }> }>(raw);
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
        ...(webnovel && c.payoffPoint?.trim() ? { payoffPoint: c.payoffPoint.trim() } : {}),
        ...(webnovel && c.chapterHook?.trim() ? { chapterHook: c.chapterHook.trim() } : {}),
      } satisfies ChapterBeat;
    });
    saveOutline(slug, outline);
    res.json({ ok: true, volume: vol });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
