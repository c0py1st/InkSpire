import { readIndexJsonRaw, writeIndexJson } from './fs-store';
import type { L0Finding } from '../../shared/src/l0';

/**
 * L0 体检报告缓存：data/<书>/.index/l0-report.json
 * 章 id -> 最近一次预检结果。纯派生数据（正文一变即可重跑），删了零损失，
 * 与 chapters.db / cache-stats.json 同属 .index 可重建层，不进备份。
 */

export interface L0ChapterReport { at: string; findings: L0Finding[] }
export type L0Report = Record<string, L0ChapterReport>;

const CODES = new Set(['title-leak', 'repeated-block', 'modern-word', 'indent-style', 'length-skew']);
const SEVS = new Set(['high', 'medium', 'low']);

export function sanitizeL0Report(input: unknown): L0Report {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: L0Report = {};
  for (const [cid, v] of Object.entries(input as Record<string, unknown>).slice(0, 4000)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const e = v as Record<string, unknown>;
    if (!Array.isArray(e.findings)) continue;
    const findings: L0Finding[] = e.findings.filter((f) => {
      if (!f || typeof f !== 'object' || Array.isArray(f)) return false;
      const x = f as Record<string, unknown>;
      return typeof x.code === 'string' && CODES.has(x.code) && typeof x.severity === 'string' && SEVS.has(x.severity) && typeof x.message === 'string';
    }).map((f) => {
      const x = f as Record<string, unknown>;
      return {
        code: x.code as L0Finding['code'], severity: x.severity as L0Finding['severity'],
        message: String(x.message).slice(0, 300),
        ...(typeof x.quote === 'string' ? { quote: x.quote.slice(0, 200) } : {}),
        ...(typeof x.at === 'number' && Number.isFinite(x.at) ? { at: Math.max(0, Math.floor(x.at)) } : {}),
      };
    });
    out[cid.slice(0, 24)] = { at: typeof e.at === 'string' ? String(e.at).slice(0, 40) : '', findings };
  }
  return out;
}

export function loadL0Report(slug: string): L0Report {
  return sanitizeL0Report(readIndexJsonRaw(slug, 'l0-report.json'));
}

export function saveChapterL0(slug: string, chapterId: string, findings: L0Finding[]): void {
  const rep = loadL0Report(slug);
  rep[chapterId] = { at: new Date().toISOString(), findings };
  writeIndexJson(slug, 'l0-report.json', rep);
}
