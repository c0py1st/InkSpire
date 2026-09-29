import fs from 'node:fs';
import { indexFile, readIndexJsonRaw, writeIndexJson } from './fs-store';
import { parseUsage, type UsageDelta } from './ai/usage';

/**
 * 前缀缓存命中率统计（观测面）：data/<书>/.index/cache-stats.json
 * 定位与 .index/chapters.db 一致——可重建缓存，删了不丢任何数据；
 * 备份（backup.ts 的 SKIP_IN_ARCHIVE）与导出都不带它。
 */

export interface CacheCounters { calls: number; prompt: number; cached: number; miss: number }
export interface CacheStatEntry {
  at: string;               // ISO 时间
  source: string;           // prose | prose-cont | summary | recap | chat
  chapterId?: string;
  prompt: number;
  cached: number;
  miss: number;
}
export interface CacheStats {
  version: 1;
  totals: CacheCounters;
  bySource: Record<string, CacheCounters>;
  recent: CacheStatEntry[];
}

export const CACHE_RECENT_MAX = 40;
export const CACHE_SOURCES_MAX = 16;

export function emptyCacheStats(): CacheStats {
  return { version: 1, totals: { calls: 0, prompt: 0, cached: 0, miss: 0 }, bySource: {}, recent: [] };
}

const nonNegInt = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** 白名单消毒：任何脏数据（手改/半写）都退化为合法形状，坏字段丢单不丢全档 */
export function sanitizeCacheStats(input: unknown): CacheStats {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return emptyCacheStats();
  const o = input as Record<string, unknown>;
  const counters = (v: unknown): CacheCounters => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { calls: 0, prompt: 0, cached: 0, miss: 0 };
    const c = v as Record<string, unknown>;
    return { calls: nonNegInt(c.calls), prompt: nonNegInt(c.prompt), cached: nonNegInt(c.cached), miss: nonNegInt(c.miss) };
  };
  const bySource: Record<string, CacheCounters> = {};
  if (o.bySource && typeof o.bySource === 'object' && !Array.isArray(o.bySource)) {
    for (const [k, v] of Object.entries(o.bySource).slice(0, CACHE_SOURCES_MAX)) {
      const key = str(k, 24);
      if (!key || !v || typeof v !== 'object' || Array.isArray(v)) continue; // 脏条目丢弃，不造假计数
      bySource[key] = counters(v);
    }
  }
  const recent = Array.isArray(o.recent)
    ? o.recent.slice(0, CACHE_RECENT_MAX).flatMap((x) => {
        if (!x || typeof x !== 'object' || Array.isArray(x)) return [];
        const e = x as Record<string, unknown>;
        if (typeof e.source !== 'string' || !e.source.trim()) return []; // 无来源的条目无法解释，丢弃
        return [{
          at: str(e.at, 40), source: str(e.source, 24),
          ...(e.chapterId ? { chapterId: str(e.chapterId, 24) } : {}),
          prompt: nonNegInt(e.prompt), cached: nonNegInt(e.cached), miss: nonNegInt(e.miss),
        }];
      })
    : [];
  return { version: 1, totals: counters(o.totals), bySource, recent };
}

export function loadCacheStats(slug: string): CacheStats {
  return sanitizeCacheStats(readIndexJsonRaw(slug, 'cache-stats.json'));
}

function addCounters(t: CacheCounters, u: UsageDelta): void {
  t.calls += 1;
  t.prompt += u.prompt;
  t.cached += u.cached;
  t.miss += u.miss;
}

/**
 * 记录一次调用的 usage。度量绝不反噬主流程：
 * 解析不出有效 usage → 静默跳过；文件/IO 出错 → 吞掉（观测数据可缺不可炸）。
 */
export function recordUsage(slug: string, args: { source: string; chapterId?: string; usage: unknown }): boolean {
  const u = parseUsage(args.usage);
  if (!u || u.prompt === 0) return false;
  try {
    const st = loadCacheStats(slug);
    addCounters(st.totals, u);
    const key = args.source.slice(0, 24) || 'unknown';
    st.bySource[key] = st.bySource[key] ?? { calls: 0, prompt: 0, cached: 0, miss: 0 };
    addCounters(st.bySource[key], u);
    st.recent.unshift({
      at: new Date().toISOString(), source: key,
      ...(args.chapterId ? { chapterId: args.chapterId.slice(0, 24) } : {}),
      prompt: u.prompt, cached: u.cached, miss: u.miss,
    });
    st.recent = st.recent.slice(0, CACHE_RECENT_MAX);
    writeIndexJson(slug, 'cache-stats.json', st);
    return true;
  } catch {
    return false;
  }
}

/** 重置统计（删除缓存文件本体，与"删 .index 重建"同语义） */
export function resetCacheStats(slug: string): void {
  try {
    fs.rmSync(indexFile(slug, 'cache-stats.json'), { force: true });
  } catch { /* 观测面永不反噬：删不掉就算了 */ }
}
