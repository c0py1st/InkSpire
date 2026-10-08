import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  Bundle, ChapterFile, ChapterStatus, CharacterCard, ChatMessageRecord, ChatProposalRecord, ChatStepRecord,
  Foreshadow, LoreEntry, LoreTraceEntry, LoreTraceItem, Outline, ProjectMeta, StoryEvent, StyleExemplar, Suggestion, VolumeRecap,
} from '../../shared/src/types';
import { countChars } from '../../shared/src/util';
import { DATA_DIR } from './config';

/**
 * 磁盘存储层：data/<slug>/ 下的普通文件。
 * 所有写入都是"临时文件 + rename"的原子操作；正文被大幅删改前自动留一份备份。
 */

const CHAPTER_ID_RE = /^v\d{2}c\d{3}$/;

function projectDir(slug: string): string {
  if (!/^[\w\u4e00-\u9fa5-]+$/.test(slug)) throw new Error(`非法项目 slug：${slug}`);
  return path.join(DATA_DIR, slug);
}

function chaptersDir(slug: string): string {
  return path.join(projectDir(slug), 'chapters');
}

function chapterPath(slug: string, id: string): string {
  if (!CHAPTER_ID_RE.test(id)) throw new Error(`非法章节 id：${id}`);
  return path.join(chaptersDir(slug), `${id}.md`);
}

function jfile(slug: string, ...segs: string[]): string {
  return path.join(projectDir(slug), ...segs);
}

/** .index/ 下的可重建附属文件（索引/统计），备份时随 .index 一起排除 */
export function indexFile(slug: string, name: string): string {
  return jfile(slug, '.index', name);
}

export function writeIndexJson(slug: string, name: string, obj: unknown): void {
  writeJson(indexFile(slug, name), obj);
}

export function readIndexJsonRaw(slug: string, name: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(indexFile(slug, name), 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function atomicWriteText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/* ---------------- 项目级 ---------------- */

export function listProjects(): ProjectMeta[] {
  if (!fs.existsSync(DATA_DIR)) return [];
  const metas: ProjectMeta[] = [];
  for (const name of fs.readdirSync(DATA_DIR)) {
    try {
      const p = path.join(DATA_DIR, name, 'meta.json');
      if (fs.statSync(path.join(DATA_DIR, name)).isDirectory() && fs.existsSync(p)) {
        metas.push(JSON.parse(fs.readFileSync(p, 'utf8')));
      }
    } catch {
      /* 忽略坏目录 */
    }
  }
  return metas.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

function nextFreeSlug(base: string): string {
  let slug = base;
  let i = 2;
  while (fs.existsSync(path.join(DATA_DIR, slug))) slug = `${base}-${i++}`;
  return slug;
}

export function createProject(meta: Omit<ProjectMeta, 'slug' | 'createdAt' | 'updatedAt'> & { slug?: string }): ProjectMeta {
  const slug = meta.slug?.trim() || nextFreeSlug(requireSlug(meta.title));
  const dir = projectDir(slug);
  if (fs.existsSync(dir)) throw new Error(`目录已存在：${slug}`);
  const now = new Date().toISOString();
  const full: ProjectMeta = { ...meta, title: meta.title.trim() || slug, slug, createdAt: now, updatedAt: now };
  writeJson(jfile(slug, 'meta.json'), full);
  writeJson(jfile(slug, 'outline.json'), null);
  writeJson(jfile(slug, 'bible', 'characters.json'), []);
  writeTextIfMissing(jfile(slug, 'bible', 'worldview.md'), '');
  fs.mkdirSync(chaptersDir(slug), { recursive: true });
  return full;
}

function requireSlug(title: string): string {
  const s = title
    .replace(/[\\/:*?"<>|.]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  if (!s) throw new Error('书名不能为空');
  return s;
}

/** 完整落盘一份由向导生成的书稿骨架 */
export function saveProjectBundle(
  input: Omit<Bundle, 'meta'>,
  metaInput: { title: string; logline: string; wordsPerChapter?: number },
  chapters: ChapterFile[],
): ProjectMeta {
  // 先在内存里把章节正文写入临时目录，避免半成品；简化做法：先建项目再依次写
  const meta = createProject({
    title: metaInput.title,
    logline: metaInput.logline,
    ...(metaInput.wordsPerChapter ? { wordsPerChapter: metaInput.wordsPerChapter } : {}),
  });
  const slug = meta.slug;
  try {
    writeJson(jfile(slug, 'outline.json'), input.outline);
    writeJson(jfile(slug, 'bible', 'characters.json'), input.characters);
    atomicWriteText(jfile(slug, 'bible', 'worldview.md'), input.worldview ?? '');
    for (const ch of chapters) saveChapterBody(slug, ch);
  } catch (err) {
    deleteProject(slug);
    throw err;
  }
  return meta;
}

/**
 * 删除 = 移入 data/.trash/<时间戳>_<slug>，不是真删。
 * 本地工具不可逆删除太危险；.trash 在 DATA_DIR 根部，listProjects
 * 只认"含 meta.json 的目录"所以不会把回收站当书列出。
 */
export function deleteProject(slug: string): void {
  const dir = projectDir(slug);
  if (!fs.existsSync(dir) || !fs.existsSync(path.join(dir, 'meta.json'))) {
    throw new Error('项目不存在');
  }
  const trash = path.join(DATA_DIR, '.trash');
  fs.mkdirSync(trash, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.renameSync(dir, path.join(trash, `${stamp}_${slug}`));
}

/** 启动时清理回收站里超过保留期的旧书（30 天）；失败静默跳过 */
export function purgeTrash(days: number = 30): void {
  const trash = path.join(DATA_DIR, '.trash');
  if (!fs.existsSync(trash)) return;
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  for (const name of fs.readdirSync(trash)) {
    try {
      const full = path.join(trash, name);
      // 删除时间取目录名前缀时间戳（刚写入 .trash 的目录 mtime 未必刷新）；
      // 名字解析不出时退回 mtime
      const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/);
      const deletedAt = m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : NaN;
      const when = Number.isFinite(deletedAt) ? deletedAt : fs.statSync(full).mtimeMs;
      if (when < cutoff) fs.rmSync(full, { recursive: true, force: true });
    } catch { /* 忽略 */ }
  }
}

export function getMeta(slug: string): ProjectMeta {
  const meta = readJson<ProjectMeta | null>(jfile(slug, 'meta.json'), null);
  if (!meta) throw new Error(`项目不存在：${slug}`);
  return meta;
}

export function touchMeta(slug: string): void {
  const meta = getMeta(slug);
  meta.updatedAt = new Date().toISOString();
  writeJson(jfile(slug, 'meta.json'), meta);
}

/** 覆盖写 meta（调用方负责只改允许的字段）；顺带刷新 updatedAt */
export function saveMeta(slug: string, meta: ProjectMeta): void {
  writeJson(jfile(slug, 'meta.json'), { ...meta, updatedAt: new Date().toISOString() });
}

/* ---------------- 读取 ---------------- */

export function loadOutline(slug: string): Outline | null {
  return readJson<Outline | null>(jfile(slug, 'outline.json'), null);
}

export function loadCharacters(slug: string): CharacterCard[] {
  return readJson<CharacterCard[]>(jfile(slug, 'bible', 'characters.json'), []);
}

export function loadWorldview(slug: string): string {
  return readText(jfile(slug, 'bible', 'worldview.md'));
}

export function loadSummaries(slug: string): Record<string, string> {
  return readJson<Record<string, string>>(jfile(slug, 'summaries.json'), {});
}

/* ---------------- 卷回本（recaps.json，可重建缓存） ---------------- */

/** 消毒：只收 {recap,fingerprint,updatedAt} 三字段字符串对象，其余丢弃 */
export function sanitizeRecaps(input: unknown): Record<string, VolumeRecap> {
  const out: Record<string, VolumeRecap> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [volId, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!/^v\d{2,}$/.test(volId) || !raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const recap = typeof r.recap === 'string' ? r.recap.slice(0, 4000) : '';
    const fingerprint = typeof r.fingerprint === 'string' ? r.fingerprint.slice(0, 32) : '';
    if (!recap.trim() || !fingerprint) continue;
    out[volId] = {
      recap, fingerprint,
      updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt.slice(0, 40) : new Date().toISOString(),
    };
  }
  return out;
}

export function loadRecaps(slug: string): Record<string, VolumeRecap> {
  return sanitizeRecaps(readJson<unknown>(jfile(slug, 'recaps.json'), {}));
}

export function saveRecaps(slug: string, recaps: Record<string, VolumeRecap>): void {
  writeJson(jfile(slug, 'recaps.json'), recaps);
}

export function loadSuggestions(slug: string): Suggestion[] {
  return readJson<Suggestion[]>(jfile(slug, 'suggestions.json'), []);
}

export function loadForeshadows(slug: string): Foreshadow[] {
  return readJson<Foreshadow[]>(jfile(slug, 'foreshadows.json'), []);
}

export function saveForeshadows(slug: string, items: Foreshadow[]): void {
  writeJson(jfile(slug, 'foreshadows.json'), items);
}

/* ---------------- 世界事件账本（events.json，真相源） ---------------- */

/** 白名单消毒：脏条目丢弃不丢全档；source 缺省按 manual（手改文件漏字段不算废） */
export function sanitizeStoryEvents(input: unknown): StoryEvent[] {
  if (!Array.isArray(input)) return [];
  const out: StoryEvent[] = [];
  for (const e of input.slice(0, 2000)) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const x = e as Record<string, unknown>;
    if (typeof x.id !== 'string' || !x.id.trim()) continue;
    if (typeof x.chapterId !== 'string' || !CHAPTER_ID_RE.test(x.chapterId)) continue;
    if (typeof x.title !== 'string' || !x.title.trim()) continue;
    const actors = Array.isArray(x.actors)
      ? x.actors.filter((a): a is string => typeof a === 'string' && !!a.trim()).map((a) => a.trim().slice(0, 30)).slice(0, 8)
      : [];
    out.push({
      id: x.id.slice(0, 40),
      chapterId: x.chapterId,
      title: x.title.trim().slice(0, 160),
      ...(typeof x.detail === 'string' && x.detail.trim() ? { detail: x.detail.trim().slice(0, 600) } : {}),
      ...(actors.length ? { actors } : {}),
      ...(typeof x.whenInStory === 'string' && x.whenInStory.trim() ? { whenInStory: x.whenInStory.trim().slice(0, 60) } : {}),
      source: x.source === 'auto' ? 'auto' : 'manual',
      at: typeof x.at === 'string' ? x.at.slice(0, 40) : new Date().toISOString(),
    });
  }
  return out;
}

export function loadEvents(slug: string): StoryEvent[] {
  return sanitizeStoryEvents(readJson<unknown>(jfile(slug, 'events.json'), []));
}

export function saveEvents(slug: string, items: StoryEvent[]): void {
  writeJson(jfile(slug, 'events.json'), items);
}

/** 重归档某章：其旧的 auto 事件整批换成新提取，manual 补记永不受影响；按章序+落盘序归位 */
export function mergeChapterAutoEvents(existing: StoryEvent[], chapterId: string, incoming: StoryEvent[]): StoryEvent[] {
  const kept = existing.filter((e) => !(e.source === 'auto' && e.chapterId === chapterId));
  return [...kept, ...incoming].sort((a, b) => a.chapterId.localeCompare(b.chapterId) || a.at.localeCompare(b.at));
}

/* ---------------- 世界书（lorebook.json，真相源） ---------------- */

const LORE_MAX_ENTRIES = 500;

/** 白名单消毒：脏条目整条丢弃不丢全档（与 sanitizeStoryEvents 同一纪律） */
export function sanitizeLoreEntries(input: unknown): LoreEntry[] {
  if (!Array.isArray(input)) return [];
  const out: LoreEntry[] = [];
  for (const e of input.slice(0, LORE_MAX_ENTRIES)) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const x = e as Record<string, unknown>;
    if (typeof x.id !== 'string' || !x.id.trim()) continue;
    if (typeof x.title !== 'string' || !x.title.trim()) continue;
    if (typeof x.content !== 'string' || !x.content.trim()) continue;
    const keys = Array.isArray(x.keys)
      ? x.keys.filter((k): k is string => typeof k === 'string' && !!k.trim()).map((k) => k.trim().slice(0, 40)).slice(0, 20)
      : [];
    const entry: LoreEntry = {
      id: x.id.trim().slice(0, 40),
      title: x.title.trim().slice(0, 80),
      keys,
      content: x.content.trim().slice(0, 4000),
    };
    if (x.scope && typeof x.scope === 'object' && !Array.isArray(x.scope)) {
      const s = x.scope as Record<string, unknown>;
      const vol = typeof s.volumeId === 'string' && s.volumeId.trim() ? s.volumeId.trim().slice(0, 12) : '';
      const from = typeof s.chapterFrom === 'string' && CHAPTER_ID_RE.test(s.chapterFrom.trim()) ? s.chapterFrom.trim() : '';
      const to = typeof s.chapterTo === 'string' && CHAPTER_ID_RE.test(s.chapterTo.trim()) ? s.chapterTo.trim() : '';
      if (vol || from || to) entry.scope = { ...(vol ? { volumeId: vol } : {}), ...(from ? { chapterFrom: from } : {}), ...(to ? { chapterTo: to } : {}) };
    }
    if (x.constant === true) entry.constant = true;
    if (x.contract === true) entry.contract = true;
    // mustInclude 仅对契约条有意义：非契约条直接丢弃，避免脏数据混进自检
    if (entry.contract === true && Array.isArray(x.mustInclude)) {
      const mi = x.mustInclude
        .filter((t): t is string => typeof t === 'string' && !!t.trim())
        .map((t) => t.trim().slice(0, 40))
        .slice(0, 12);
      if (mi.length) entry.mustInclude = mi;
    }
    if (typeof x.priority === 'number' && Number.isFinite(x.priority)) entry.priority = Math.max(-100, Math.min(100, Math.round(x.priority)));
    if (x.enabled === false) entry.enabled = false;
    out.push(entry);
  }
  return out;
}

export function loadLorebook(slug: string): LoreEntry[] {
  return sanitizeLoreEntries(readJson<unknown>(jfile(slug, 'lorebook.json'), []));
}

export function saveLorebook(slug: string, entries: LoreEntry[]): void {
  writeJson(jfile(slug, 'lorebook.json'), entries);
}

/* ---- 激活留痕（.index/lore-activated.json，可重建缓存）：每章最近一次生成的命中/丢弃 ---- */

const LORE_TRACE_MAX_CHAPTERS = 300;

function traceItems(list: LoreEntry[]): LoreTraceItem[] {
  return list.map((e) => ({ id: e.id, title: e.title, chars: e.content.length }));
}

/** 留痕只记 id/标题/字数——真相源与缓存各安其位，删缓存零损失；style* 段为 A2 范文激活情况 */
export function saveLoreActivated(slug: string, chapterId: string, trace: {
  activated: LoreEntry[]; dropped: LoreEntry[];
  styleActivated?: LoreEntry[]; styleDropped?: LoreEntry[];
}): void {
  const file = indexFile(slug, 'lore-activated.json');
  const store = (readJson<Record<string, unknown>>(file, {}) ?? {}) as Record<string, LoreTraceEntry>;
  store[chapterId] = {
    activated: traceItems(trace.activated), dropped: traceItems(trace.dropped),
    ...(trace.styleActivated ? { styleActivated: traceItems(trace.styleActivated) } : {}),
    ...(trace.styleDropped && trace.styleDropped.length ? { styleDropped: traceItems(trace.styleDropped) } : {}),
    at: new Date().toISOString(),
  };
  const ids = Object.keys(store);
  if (ids.length > LORE_TRACE_MAX_CHAPTERS) {
    for (const id of ids.sort().slice(0, ids.length - LORE_TRACE_MAX_CHAPTERS)) delete store[id];
  }
  writeJson(file, store);
}

export function loadLoreActivated(slug: string): Record<string, LoreTraceEntry> {
  return (readJson<Record<string, unknown>>(indexFile(slug, 'lore-activated.json'), {}) ?? {}) as Record<string, LoreTraceEntry>;
}

/* ---------------- 风格范文库（exemplars.json，真相源） ---------------- */

const EXEMPLAR_MAX = 100;

/** 白名单消毒：脏条目整条丢弃不丢全档（同 lorebook 纪律） */
export function sanitizeStyleExemplars(input: unknown): StyleExemplar[] {
  if (!Array.isArray(input)) return [];
  const out: StyleExemplar[] = [];
  for (const e of input.slice(0, EXEMPLAR_MAX)) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const x = e as Record<string, unknown>;
    if (typeof x.id !== 'string' || !x.id.trim()) continue;
    if (typeof x.title !== 'string' || !x.title.trim()) continue;
    if (typeof x.content !== 'string' || !x.content.trim()) continue;
    const keys = Array.isArray(x.keys)
      ? x.keys.filter((k): k is string => typeof k === 'string' && !!k.trim()).map((k) => k.trim().slice(0, 40)).slice(0, 5)
      : [];
    const ex: StyleExemplar = {
      id: x.id.trim().slice(0, 40),
      title: x.title.trim().slice(0, 80),
      keys,
      content: x.content.trim().slice(0, 600),
      at: typeof x.at === 'string' ? x.at.slice(0, 40) : new Date().toISOString(),
    };
    if (typeof x.sceneTag === 'string' && x.sceneTag.trim()) ex.sceneTag = x.sceneTag.trim().slice(0, 20);
    if (typeof x.sourceChapterId === 'string' && CHAPTER_ID_RE.test(x.sourceChapterId.trim())) ex.sourceChapterId = x.sourceChapterId.trim();
    if (typeof x.sourceChapterTitle === 'string' && x.sourceChapterTitle.trim()) ex.sourceChapterTitle = x.sourceChapterTitle.trim().slice(0, 60);
    if (x.constant === true) ex.constant = true;
    if (x.enabled === false) ex.enabled = false;
    out.push(ex);
  }
  return out;
}

export function loadExemplars(slug: string): StyleExemplar[] {
  return sanitizeStyleExemplars(readJson<unknown>(jfile(slug, 'exemplars.json'), []));
}

export function saveExemplars(slug: string, items: StyleExemplar[]): void {
  writeJson(jfile(slug, 'exemplars.json'), items);
}

/* ---------------- 对话持久化（chat.json） ---------------- */

/** 落盘上限：超出的旧消息从头部丢弃，保证文件不会无限膨胀 */
export const CHAT_MAX_MESSAGES = 200;
const CHAT_MAX_CONTENT = 20000;
const CHAT_MAX_STEPS = 12;
const CHAT_MAX_PROPOSALS = 6;

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/**
 * 消毒前端传来的对话记录：只保留白名单字段、类型与长度全部收敛。
 * 目的——落盘文件必然会被 agent/前端/手工三方编辑，读取时绝不信任其形状。
 * 纯函数，不碰磁盘，单测直接喂各种畸形输入。
 */
export function sanitizeChatRecords(input: unknown): ChatMessageRecord[] {
  if (!Array.isArray(input)) return [];
  const out: ChatMessageRecord[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as Record<string, unknown>;
    const role = m.role === 'user' || m.role === 'assistant' ? m.role : null;
    const content = str(m.content, CHAT_MAX_CONTENT);
    if (!role || !content.trim()) continue;
    const rec: ChatMessageRecord = { role, content, at: str(m.at, 40) || new Date().toISOString() };

    if (Array.isArray(m.steps)) {
      const steps: ChatStepRecord[] = [];
      for (const s of m.steps.slice(0, CHAT_MAX_STEPS)) {
        if (!s || typeof s !== 'object') continue;
        const so = s as Record<string, unknown>;
        const name = str(so.name, 60);
        if (!name) continue;
        steps.push({ name, detail: str(so.detail, 200), done: so.done !== false });
      }
      if (steps.length) rec.steps = steps;
    }
    if (Array.isArray(m.proposals)) {
      const props: ChatProposalRecord[] = [];
      for (const p of m.proposals.slice(0, CHAT_MAX_PROPOSALS)) {
        if (!p || typeof p !== 'object') continue;
        const po = p as Record<string, unknown>;
        const kind = po.kind === 'chapter' || po.kind === 'summary' ? po.kind : null;
        const cid = str(po.chapterId, 20);
        const body = str(po.content, 12000);
        if (!kind || !CHAPTER_ID_RE.test(cid) || !body.trim()) continue;
        props.push({
          id: Number.isFinite(po.id as number) ? Number(po.id) : props.length + 1,
          kind, chapterId: cid, content: body, decided: po.decided === true,
        });
      }
      if (props.length) rec.proposals = props;
    }
    out.push(rec);
  }
  return out.length > CHAT_MAX_MESSAGES ? out.slice(out.length - CHAT_MAX_MESSAGES) : out;
}

export function loadChat(slug: string): ChatMessageRecord[] {
  return sanitizeChatRecords(readJson<unknown>(jfile(slug, 'chat.json'), []));
}

export function saveChat(slug: string, messages: unknown): ChatMessageRecord[] {
  const clean = sanitizeChatRecords(messages);
  writeJson(jfile(slug, 'chat.json'), clean);
  return clean;
}

export function loadBundle(slug: string): Bundle {
  getMeta(slug); // 校验存在
  return {
    meta: getMeta(slug),
    outline: loadOutline(slug),
    characters: loadCharacters(slug),
    worldview: loadWorldview(slug),
    summaries: loadSummaries(slug),
    recaps: loadRecaps(slug),
    suggestions: loadSuggestions(slug),
    foreshadows: loadForeshadows(slug),
  };
}

/* ---------------- 写入 ---------------- */

export function saveOutline(slug: string, outline: Outline): void {
  writeJson(jfile(slug, 'outline.json'), outline);
  touchMeta(slug);
}

export function saveCharacters(slug: string, chars: CharacterCard[]): void {
  writeJson(jfile(slug, 'bible', 'characters.json'), chars);
  touchMeta(slug);
}

export function saveWorldview(slug: string, text: string): void {
  atomicWriteText(jfile(slug, 'bible', 'worldview.md'), text);
}

export function saveSuggestions(slug: string, sugs: Suggestion[]): void {
  writeJson(jfile(slug, 'suggestions.json'), sugs);
}

export function saveSummaries(slug: string, summaries: Record<string, string>): void {
  writeJson(jfile(slug, 'summaries.json'), summaries);
}

const MAX_BACKUPS = 20;

function backupChapter(slug: string, id: string, prevContent: string): void {
  const dir = path.join(chaptersDir(slug), '.backups', id);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, `${stamp}.md`), prevContent, 'utf8');
  const olds = fs.readdirSync(dir).sort();
  while (olds.length > MAX_BACKUPS) fs.rmSync(path.join(dir, olds.shift()!), { force: true });
}

interface ChapterDoc {
  id: string;
  title: string;
  status: ChapterStatus;
  content: string;
}

/** 解析章节 markdown 的 frontmatter + 正文（chapter-index 建索引复用） */
export function parseChapterFile(raw: string, fallbackId: string): ChapterDoc {
  let content = raw.replace(/^\uFEFF/, '');
  let title = '';
  let status: ChapterStatus = 'todo';
  if (content.startsWith('---')) {
    const end = content.indexOf('\n---', 3);
    if (end > 0) {
      try {
        const fm = YAML.parse(content.slice(4, end)) as Record<string, unknown>;
        title = typeof fm.title === 'string' ? fm.title : '';
        status = fm.status === 'draft' || fm.status === 'revised' ? fm.status : 'todo';
      } catch {
        /* frontmatter 坏了当纯文本 */
      }
      content = content.slice(end + 4);
    }
  }
  content = content.replace(/^\r?\n/, '');
  if (!title) title = fallbackId;
  return { id: fallbackId, title, status, content };
}

function toRaw(doc: ChapterDoc): string {
  const fm = ['---', `id: ${doc.id}`, `title: ${YAML.stringify(doc.title).trim()}`, `status: ${doc.status}`, '---', ''].join('\n');
  return fm + doc.content;
}

/** 保存正文，返回字数。新内容比旧内容短 30% 以上（或 forceBackup）时先把旧稿存入备份。 */
export function saveChapterBody(slug: string, ch: ChapterFile, forceBackup = false): number {
  const file = chapterPath(slug, ch.id);
  const prevRaw = readText(file);
  if (forceBackup || (prevRaw && ch.content.length < prevRaw.length * 0.7)) {
    backupChapter(slug, ch.id, prevRaw);
  }
  atomicWriteText(file, toRaw(ch));
  touchMeta(slug);
  return countChars(ch.content);
}

export function readChapter(slug: string, id: string): ChapterFile {
  const doc = parseChapterFile(readText(chapterPath(slug, id)), id);
  return doc;
}

export interface BackupInfo { stamp: string; epoch: number; chars: number; title: string }

/** 某章的全部历史备份，新的在前 */
export function listChapterBackups(slug: string, id: string): BackupInfo[] {
  if (!CHAPTER_ID_RE.test(id)) throw new Error(`非法章节 id：${id}`);
  const dir = path.join(chaptersDir(slug), '.backups', id);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse()
    .map((f) => {
      const doc = parseChapterFile(readText(path.join(dir, f)), id);
      // 文件名是"冒号/点换成 -"的 ISO 时间，还原成可解析的 ISO 后取 epoch
      const iso = f.replace(/\.md$/, '').replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1T$2:$3:$4.$5Z');
      const epoch = Date.parse(iso) || 0;
      return { stamp: f, epoch, chars: countChars(doc.content), title: doc.title };
    });
}

/** 读取一份历史备份 */
export function readChapterBackup(slug: string, id: string, stamp: string): ChapterFile {
  if (!CHAPTER_ID_RE.test(id)) throw new Error(`非法章节 id：${id}`);
  if (!/^[\w\-]+\.md$/.test(stamp)) throw new Error(`非法备份文件名：${stamp}`);
  const file = path.join(chaptersDir(slug), '.backups', id, stamp);
  return parseChapterFile(readText(file), id);
}

/** 全部章节的索引信息（含字数），按 id 排序 */
export function listChapters(slug: string): ChapterFile[] {
  const dir = chaptersDir(slug);
  if (!fs.existsSync(dir)) return [];
  const out: ChapterFile[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const id = f.slice(0, -3);
    if (!CHAPTER_ID_RE.test(id)) continue;
    out.push(parseChapterFile(readText(path.join(dir, f)), id));
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

function writeTextIfMissing(file: string, text: string): void {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  }
}
