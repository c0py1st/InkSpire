import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  AppConfig, ChapterBeat, ChapterStatus, CharacterCard, ConsistencyIssue, GenChapterResult, Kernel, ProposalRequest, ProviderProfile, Suggestion, VolumeBrief,
} from '../../../shared/src/types';
import { loadConfig } from '../config';
import { chatOnce, streamChat } from '../ai/provider';
import { extractJson } from '../ai/json';
import { Sse, abortOnClose } from '../ai/sse';
import { buildChapterContext, buildSummariesText, foreshadowText, locateChapter, nextChapterIds, selectionContext } from '../ai/memory';
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
  const { kernel, volumes, volIndex, chapterCount } = req.body as {
    kernel: Kernel; volumes: VolumeBrief[]; volIndex: number; chapterCount: number;
  };
  const cfg = loadConfig();
  const profile = requireCreative(cfg, res);
  if (!profile) return;
  const vol = volumes[volIndex];
  if (!vol) return res.status(400).json({ error: '卷不存在' });
  const neighbors = [volumes[volIndex - 1], volumes[volIndex + 1]].filter(Boolean)
    .map((v) => ({ title: v.title, summary: v.summary }));
  const prompt = beatsPrompt(kernel, vol.title, vol.summary, chapterCount, neighbors);
  streamTask(req, res, async (sse, signal) => {
    const full = await streamToTask(sse, signal, profile, cfg, [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ], 'json', 8192);
    sse.send({ type: 'final', chapters: extractJson<{ chapters: Array<{ title: string; beat: string; pov?: string; characters?: string[] }> }>(full).chapters });
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
      prevChapterContent: prevContent,
      foreshadows: bundle.foreshadows,
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
          onMeta: (m) => { tailReason = m.finishReason ?? tailReason; },
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

/** 章节完稿：生成摘要、探测新设定，写入 suggestions */
/**
 * 章节归档核心（路由与连写队列共用）：
 * 生成摘要写入 summaries.json，探测新人物/新设定/人物状态变更并落建议卡。
 * contentIn 省略时从磁盘读最新正文。抛错由调用方处理。
 */
export async function finalizeChapterCore(
  slug: string, chapterId: string, contentIn?: string,
): Promise<{ summary: string; newSuggestions: Suggestion[] }> {
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
  });
  // 辅助 JSON 任务：deepseek 推理型模型需要为思考预留 token，给足 max_tokens
  const raw = await chatOnce(cfg, assistProfile(cfg), [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ], { kind: 'json', temperature: 0.3, maxTokens: 4000 });
  const parsed = extractJson<{
    summary: string;
    newCharacters: Array<{ name: string; reason: string }>;
    worldNotes: string[];
    stateChanges?: Array<{ name: string; newState: string; reason?: string }>;
  }>(raw);

  const summaries = { ...bundle.summaries, [chapterId]: parsed.summary };
  saveSummaries(slug, summaries);

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
  const superseded = new Set(stateAdded.map((s) => s.name));
  const kept = suggestions.filter((s) => !(s.kind === 'state' && superseded.has(s.name)));
  const all = [...kept, ...added, ...worldAdded, ...stateAdded].slice(-50);
  saveSuggestions(slug, all);

  return { summary: parsed.summary, newSuggestions: [...added, ...worldAdded, ...stateAdded] };
}

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

/* ================= 批注抽屉 ================= */

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
    summaries: outline ? buildSummariesText(outline, bundle.summaries, chapterId ?? '') : '',
    foreshadows: outline
      ? (chapterId
        ? foreshadowText(outline, bundle.foreshadows, chapterId)
        : bundle.foreshadows.filter((f) => f.status === 'open')
          .map((f) => `- 未回收：${f.content}（埋设于 ${f.setupChapterId}）`).join('\n'))
      : '',
    chapterTitle,
    chapterBeat,
    chapterContent,
    selection,
    history,
    question,
  });

  streamTask(req, res, async (sse, signal) => {
    let truncated = false;
    await streamToTask(sse, signal, profile, cfg, [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ], 'prose', undefined, undefined, (m) => { truncated = m.finishReason === 'length'; });
    if (truncated) sse.send({ type: 'final', truncated: true });
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
      characters: bundle.characters,
      summaries: buildSummariesText(outline, bundle.summaries, chapterId),
      worldview: bundle.worldview,
      foreshadows: foreshadowText(outline, bundle.foreshadows, chapterId),
    });
    const raw = await chatOnce(cfg, assistProfile(cfg), [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ], { kind: 'json', temperature: 0.2, maxTokens: 4000 });
    res.json(extractJson<{ issues: ConsistencyIssue[] }>(raw));
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
