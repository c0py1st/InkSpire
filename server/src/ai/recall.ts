/* A3 · FTS5 检索反哺：把本书前文按段落建可重建索引（.index/recall.sqlite，node:sqlite 内置零依赖），
 * 生成新章前用本章 beat 召回相关旧片段注入 prompt——世界书管「人设定的」，召回管「写过的」。
 * 宪法约束：索引是缓存不是真相源（删了自动重建）；node:sqlite 不可用 → JS 扫描降级；
 * 任何异常由调用方兜住静默跳过，绝不拖垮生成。 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA_DIR } from '../config';
import type { ChapterFile, Outline } from '../../../shared/src/types';

export const RECALL_BUDGET_CHARS = 1200;   // 注入片段总预算（与 lore 4000 / style 1500 相互独立）
const MAX_ITEMS = 5;
const ITEM_MAX_CHARS = 260;
const PARA_MAX = 260;

interface Stmt { run(...a: unknown[]): unknown; all(...a: unknown[]): Array<Record<string, string | number>> }
interface DB { exec(sql: string): void; prepare(sql: string): Stmt; close(): void }

let SqliteCtor: (new (p: string) => DB) | null = null;
try {
  const mod = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync?: new (p: string) => DB };
  SqliteCtor = mod.DatabaseSync ?? null;
} catch { SqliteCtor = null; }

/** sqlite 通道是否可用（单测/降级观测用）；false 时召回走纯 JS 扫描，功能不缺席只降速 */
export function recallAvailable(): boolean { return SqliteCtor !== null; }

/** 段落窗口：按行切，短尾并入前段，超长按句读硬切 */
export function splitParagraphs(content: string): string[] {
  const raw = content.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const seg of raw) {
    if (seg.length <= PARA_MAX) {
      if (seg.length < 15 && out.length) out[out.length - 1] += seg;
      else out.push(seg);
    } else {
      let buf = '';
      for (const s of seg.split(/(?<=[。！？…])/)) {
        if ((buf + s).length > PARA_MAX && buf) { out.push(buf); buf = s; }
        else buf += s;
      }
      if (buf) out.push(buf);
    }
  }
  return out;
}

function createDb(file: string): DB {
  if (!SqliteCtor) throw new Error('node:sqlite 不可用');
  const db = new SqliteCtor(file);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS meta(chapter_id TEXT PRIMARY KEY, hash TEXT NOT NULL);
             CREATE VIRTUAL TABLE IF NOT EXISTS paras USING fts5(chapter_id UNINDEXED, body, tokenize='trigram');`);
    return db;
  } catch (err) {
    // 损坏/版本不兼容：删库重建（真相源在 .md，索引随时可弃）——与 chapter-index 同款纪律
    db.close();
    for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(file + suffix, { force: true }); } catch { /* ignore */ } }
    const retry = new SqliteCtor(file);
    retry.exec(`CREATE TABLE IF NOT EXISTS meta(chapter_id TEXT PRIMARY KEY, hash TEXT NOT NULL);
                CREATE VIRTUAL TABLE IF NOT EXISTS paras USING fts5(chapter_id UNINDEXED, body, tokenize='trigram');`);
    void err;
    return retry;
  }
}

function openDb(slug: string): DB | null {
  if (!SqliteCtor) return null;
  const file = path.join(DATA_DIR, slug, '.index', 'recall.sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return createDb(file);
}

/** 增量对齐索引：sha1 变更章才删重插，已删章清行；返回 false = 走降级 */
function ensureIndex(db: DB, chapters: ChapterFile[]): boolean {
  const want = new Map<string, string>();
  for (const c of chapters) if (c.content.trim()) want.set(c.id, crypto.createHash('sha1').update(c.content).digest('hex'));
  const have = new Map<string, string>();
  for (const r of db.prepare('select chapter_id, hash from meta').all()) have.set(String(r.chapter_id), String(r.hash));
  const del = db.prepare('delete from paras where chapter_id = ?');
  const delMeta = db.prepare('delete from meta where chapter_id = ?');
  const insMeta = db.prepare('insert into meta(chapter_id, hash) values (?, ?)');
  const insPara = db.prepare('insert into paras(chapter_id, body) values (?, ?)');
  for (const cid of have.keys()) if (!want.has(cid)) { del.run(cid); delMeta.run(cid); }
  for (const c of chapters) {
    const h = want.get(c.id);
    if (!h || have.get(c.id) === h) continue;
    del.run(c.id);
    for (const p of splitParagraphs(c.content)) insPara.run(c.id, p);
    delMeta.run(c.id); insMeta.run(c.id, h);
  }
  return true;
}

/** 查询词抽取：出场人名 + 「」引用 + beat 标点切段（2~8 字）+ 超长段的 3 字滑窗 */
export function extractTerms(beat: string, castNames: string[]): string[] {
  const terms = new Set<string>();
  for (const n of castNames) { const t = n.trim(); if (t && beat.includes(t)) terms.add(t); }
  for (const m of beat.matchAll(/「([^」\n]{1,8})」/g)) terms.add(m[1].trim());
  for (const seg of beat.split(/[，。！？；：、\s“”‘’（）()《》,.!?;:]+/)) {
    const s = seg.trim();
    if (s.length >= 2 && s.length <= 8) terms.add(s);
    else if (s.length > 8) for (let i = 0; i + 3 <= s.length; i++) terms.add(s.slice(i, i + 3));
  }
  return [...terms].filter((t) => t && t.length <= 12).slice(0, 60);
}

function countHits(hay: string, needle: string): number {
  let c = 0; let i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) { c++; i += needle.length; }
  return c;
}

export interface RecallHit { chapterId: string; title: string; chars: number }
export interface RecallResult { text: string; hits: RecallHit[]; terms: number; via: 'fts' | 'scan' }

/** 主入口：在本章之前的章里召回与 terms 相关的旧片段，产出注入文本。sqlite 不可用/出错自动降级扫描。 */
export function recallForChapter(args: {
  slug: string;
  outline: Outline;
  chapterId: string;
  chapters: ChapterFile[];
  terms: string[];
  budgetChars?: number;
  noIndex?: boolean;   // 强制走扫描降级（测试/未来开关）
}): RecallResult {
  const { outline, chapterId, chapters, terms } = args;
  const budget = args.budgetChars ?? RECALL_BUDGET_CHARS;
  const titleOf = new Map<string, string>();
  for (const v of outline.volumes) for (const c of v.chapters) titleOf.set(c.id, c.title);
  const before = (cid: string): boolean => cid < chapterId; // 零填充章 id：字典序 = 阅读序
  const prior = chapters.filter((c) => before(c.id) && c.content.trim());
  if (!prior.length || !terms.length) return { text: '', hits: [], terms: terms.length, via: 'fts' };

  const empty = new Set<string>();
  for (const v of outline.volumes) for (const c of v.chapters) for (const n of c.characters ?? []) empty.add(n);
  const nameSet = empty;

  type Row = { cid: string; body: string; score: number };
  let candidates: Row[] = [];
  let via: 'fts' | 'scan' = 'scan';
  const longTerms = terms.filter((t) => t.length >= 3);
  const shortTerms = terms.filter((t) => t.length < 3);

  try {
    const db = args.noIndex ? null : openDb(args.slug);
    if (db) {
      try {
        if (ensureIndex(db, chapters)) {
          const seen = new Map<string, Row>();
          if (longTerms.length) {
            const match = longTerms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
            for (const r of db.prepare('select chapter_id as cid, body from paras where paras match ? limit 400').all(match)) {
              const cid = String(r.cid);
              if (before(cid)) seen.set(cid + '\u0000' + String(r.body), { cid, body: String(r.body), score: 0 });
            }
          }
          for (const t of shortTerms) {
            const esc = t.replace(/[\\%_]/g, (m) => '\\' + m);
            for (const r of db.prepare(`select chapter_id as cid, body from paras where body like ? ESCAPE '\\' limit 400`).all(`%${esc}%`)) {
              const cid = String(r.cid);
              if (before(cid)) seen.set(cid + '\u0000' + String(r.body), { cid, body: String(r.body), score: 0 });
            }
          }
          candidates = [...seen.values()];
          via = 'fts';
        }
      } finally { db.close(); }
    }
  } catch { via = 'scan'; candidates = []; }

  if (via === 'scan') {
    const seen = new Set<string>();
    const rows: Row[] = [];
    for (const c of prior) {
      for (const p of splitParagraphs(c.content)) {
        const key = c.id + '\u0000' + p;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ cid: c.id, body: p, score: 0 });
      }
    }
    candidates = rows;
  }

  // JS 统一复评（两通道同一评分函数，排序稳定性与引擎无关）：
  // 人名高权重、3 字以上普通词次之、非人名 2 字词低权防噪声；单词命中封顶防刷屏。
  for (const r of candidates) {
    let s = 0;
    for (const t of terms) {
      const w = t.length >= 3 ? (nameSet.has(t) ? 3 : 2) : (nameSet.has(t) ? 2 : 0.5);
      const cnt = countHits(r.body, t);
      if (cnt) s += w * Math.min(cnt, 3);
    }
    r.score = s;
  }
  candidates = candidates.filter((r) => r.score > 0);
  candidates.sort((a, b) => b.score - a.score || (a.cid < b.cid ? 1 : -1));

  const hits: RecallHit[] = [];
  const lines: string[] = [];
  let used = 0;
  for (const r of candidates) {
    if (hits.length >= MAX_ITEMS || used >= budget) break;
    const text = r.body.length > ITEM_MAX_CHARS ? r.body.slice(0, ITEM_MAX_CHARS) + '…' : r.body;
    if (used + text.length > budget && hits.length) continue;
    used += text.length;
    hits.push({ chapterId: r.cid, title: titleOf.get(r.cid) ?? r.cid, chars: text.length });
    lines.push(`· 《${titleOf.get(r.cid) ?? r.cid}》：${text}`);
  }
  return { text: lines.join('\n'), hits, terms: terms.length, via };
}
