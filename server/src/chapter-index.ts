import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import type { Outline, SearchHit } from '../../shared/src/types';
import { DATA_DIR } from './config';
import { parseChapterFile } from './fs-store';

/* ============================================================
   章节全文索引 —— 文件是真相源，SQLite(FTS5 trigram) 只是可重建缓存。
   - node:sqlite 需 Node ≥ 22.5；低版本运行时经 createRequire 探测失败后
     自动退回全文件扫描，行为与旧实现完全一致（含大小写不敏感子串语义）。
   - 索引只负责"哪些章可能含该子串"的候选筛选与去 IO；
     offset/摘录仍由逐章精确扫描产出，保证命中位置绝对准确。
   ============================================================ */

type SqliteModule = typeof import('node:sqlite');
let sqliteMod: SqliteModule | null = null;
try {
  sqliteMod = createRequire(import.meta.url)('node:sqlite') as SqliteModule;
} catch {
  sqliteMod = null; // 旧版 Node：没有内置 sqlite，静默降级
}

/** 索引能力探测（诊断/测试用） */
export const indexSupported = (): boolean => sqliteMod !== null;

const SNIP = 30;

function bookDir(slug: string, dataDir: string): string {
  return path.join(dataDir, slug);
}

function listChapterFiles(slug: string, dataDir: string): Array<{ id: string; file: string; mtime: number; size: number }> {
  const dir = path.join(bookDir(slug, dataDir), 'chapters');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { id: f.slice(0, -3), file: path.join(dir, f), mtime: st.mtimeMs, size: st.size };
    });
}

function readOutlineForTitles(slug: string, dataDir: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const o = JSON.parse(fs.readFileSync(path.join(bookDir(slug, dataDir), 'outline.json'), 'utf8')) as Outline;
    for (const vol of o.volumes) for (const ch of vol.chapters) map.set(ch.id, vol.title);
  } catch { /* 无大纲则卷名为空串，与旧行为一致 */ }
  return map;
}

/* ---------------- 索引库打开与同步 ---------------- */

function openBookDb(dbFile: string): DatabaseSync {
  if (!sqliteMod) throw new Error('node:sqlite 不可用');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new sqliteMod.DatabaseSync(dbFile);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (id TEXT PRIMARY KEY, mtime REAL NOT NULL, size INTEGER NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS ch_fts USING fts5(cid UNINDEXED, body, tokenize='trigram');
    `);
    return db;
  } catch (err) {
    db.close();
    // 库文件损坏/版本不兼容：删掉重建（真相源在 .md，索引随时可弃）
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(dbFile + suffix, { force: true }); } catch { /* ignore */ }
    }
    const retry = new sqliteMod.DatabaseSync(dbFile);
    retry.exec(`
      CREATE TABLE IF NOT EXISTS meta (id TEXT PRIMARY KEY, mtime REAL NOT NULL, size INTEGER NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS ch_fts USING fts5(cid UNINDEXED, body, tokenize='trigram');
    `);
    void err;
    return retry;
  }
}

/** 对齐 chapters/*.md 与库内容：mtime+size 变了才重读，消失的章清行 */
function syncIndex(db: DatabaseSync, slug: string, dataDir: string): void {
  const files = listChapterFiles(slug, dataDir);
  const onDisk = new Map<string, { mtime: number; size: number }>(
    (db.prepare('SELECT id, mtime, size FROM meta').all() as Array<{ id: string; mtime: number; size: number }>)
      .map((r) => [r.id, { mtime: r.mtime, size: r.size }]),
  );
  const updMeta = db.prepare('INSERT OR REPLACE INTO meta (id, mtime, size) VALUES (?, ?, ?)');
  const delFts = db.prepare('DELETE FROM ch_fts WHERE cid = ?');
  const insFts = db.prepare('INSERT INTO ch_fts (cid, body) VALUES (?, ?)');
  const seen = new Set<string>();
  for (const f of files) {
    seen.add(f.id);
    const old = onDisk.get(f.id);
    if (old && old.mtime === f.mtime && old.size === f.size) continue;
    const doc = parseChapterFile(fs.readFileSync(f.file, 'utf8'), f.id);
    delFts.run(f.id);
    insFts.run(f.id, doc.content);
    updMeta.run(f.id, f.mtime, f.size);
  }
  const delMeta = db.prepare('DELETE FROM meta WHERE id = ?');
  for (const id of onDisk.keys()) {
    if (!seen.has(id)) {
      delFts.run(id);
      delMeta.run(id);
    }
  }
}

/** 候选章 id：trigram 子串语义保证无漏报（假阳性交给下游精确扫描消化） */
function candidateIds(db: DatabaseSync, query: string): string[] {
  const phrase = `"${query.replace(/"/g, '""')}"`;
  const rows = db.prepare('SELECT cid FROM ch_fts WHERE ch_fts MATCH ?').all(phrase) as Array<{ cid: string }>;
  return rows.map((r) => r.cid);
}

/* ---------------- 精确扫描（与旧实现逐字节一致） ---------------- */

function scanOne(
  id: string, title: string, content: string, volumeTitle: string,
  query: string, needle: string, budget: number,
): SearchHit[] {
  const hits: SearchHit[] = [];
  const hay = content.toLowerCase();
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    const s = Math.max(0, at - SNIP);
    const pre = content.slice(s, at).replace(/\n/g, ' ');
    const hit = content.slice(at, at + query.length);
    const post = content.slice(at + query.length, at + query.length + SNIP).replace(/\n/g, ' ');
    hits.push({
      chapterId: id, chapterTitle: title, volumeTitle,
      offset: at,
      snippet: `${s > 0 ? '…' : ''}${pre}〔${hit}〕${post}…`,
    });
    from = at + Math.max(1, needle.length);
    if (hits.length >= budget) break;
  }
  return hits;
}

/* ---------------- 对外入口 ---------------- */

export function searchChapters(slug: string, q: string, limitIn = 40, dataDir: string = DATA_DIR): SearchHit[] {
  const query = q.trim();
  if (!query) return [];
  const limit = Math.max(1, Math.min(80, limitIn || 40));
  let files = listChapterFiles(slug, dataDir);
  if (!files.length) return [];

  // 长查询走索引筛选：只解析可能命中的章；短查询/无 sqlite/任何异常 → 全量扫描
  if (sqliteMod && query.length >= 3) {
    try {
      const db = openBookDb(path.join(bookDir(slug, dataDir), '.index', 'chapters.db'));
      try {
        syncIndex(db, slug, dataDir);
        const set = new Set(candidateIds(db, query));
        files = files.filter((f) => set.has(f.id));
      } finally {
        db.close();
      }
      if (!files.length) return [];
    } catch {
      files = listChapterFiles(slug, dataDir); // 索引任何闪失都回到全扫，结果绝不因它变错
    }
  }

  const volTitles = readOutlineForTitles(slug, dataDir);
  const needle = query.toLowerCase();
  const hits: SearchHit[] = [];
  for (const f of files) {
    const doc = parseChapterFile(fs.readFileSync(f.file, 'utf8'), f.id);
    for (const h of scanOne(f.id, doc.title, doc.content, volTitles.get(f.id) ?? '', query, needle, limit - hits.length)) {
      hits.push(h);
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

/** 删除作品目录时索引随书目录一起消失，无需显式清理；此函数留给"只清缓存"场景 */
export function dropIndex(slug: string, dataDir: string = DATA_DIR): void {
  fs.rmSync(path.join(bookDir(slug, dataDir), '.index'), { recursive: true, force: true });
}
