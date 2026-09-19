import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  Bundle, ChapterFile, ChapterStatus, CharacterCard, Foreshadow, Outline, ProjectMeta,
  SearchHit, Suggestion,
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

export function loadSuggestions(slug: string): Suggestion[] {
  return readJson<Suggestion[]>(jfile(slug, 'suggestions.json'), []);
}

export function loadForeshadows(slug: string): Foreshadow[] {
  return readJson<Foreshadow[]>(jfile(slug, 'foreshadows.json'), []);
}

export function saveForeshadows(slug: string, items: Foreshadow[]): void {
  writeJson(jfile(slug, 'foreshadows.json'), items);
}

export function loadBundle(slug: string): Bundle {
  getMeta(slug); // 校验存在
  return {
    meta: getMeta(slug),
    outline: loadOutline(slug),
    characters: loadCharacters(slug),
    worldview: loadWorldview(slug),
    summaries: loadSummaries(slug),
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

/** 解析章节 markdown 的 frontmatter + 正文 */
function parseChapterFile(raw: string, fallbackId: string): ChapterDoc {
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

const SNIP = 30;

/**
 * 全书正文检索：忽略大小写，按阅读顺序返回命中点偏移与上下文摘录。
 * 路由 GET /:slug/search 与 agent 工具 search_chapters 共用此函数。
 */
export function searchChapters(slug: string, q: string, limitIn = 40): SearchHit[] {
  const query = q.trim();
  if (!query) return [];
  const limit = Math.max(1, Math.min(80, limitIn || 40));
  const outline = loadOutline(slug);
  const volTitle = new Map<string, string>();
  if (outline) for (const vol of outline.volumes) for (const ch of vol.chapters) volTitle.set(ch.id, vol.title);
  const chapters = listChapters(slug); // 按 id 升序 = 阅读顺序
  const needle = query.toLowerCase();
  const hits: SearchHit[] = [];
  for (const ch of chapters) {
    const hay = ch.content.toLowerCase();
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      const s = Math.max(0, at - SNIP);
      const pre = ch.content.slice(s, at).replace(/\n/g, ' ');
      const hit = ch.content.slice(at, at + query.length);
      const post = ch.content.slice(at + query.length, at + query.length + SNIP).replace(/\n/g, ' ');
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
  return hits;
}

function writeTextIfMissing(file: string, text: string): void {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  }
}
