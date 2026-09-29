import type { CacheStats, CharacterCard, Foreshadow, HealthReport, Outline } from '../../shared/src/types';
import type { L0Report } from './l0-report';
import { countChars } from '../../shared/src/util';

/**
 * 体检报告聚合：纯函数、零模型调用。输入都是已加载的真相源数据 + .index 缓存，
 * 路由只做取数与调用，判定逻辑全部在这里可测。HealthReport 线上形状见 shared。
 */

export interface HealthInput {
  outline: Outline;
  summaries: Record<string, string>;
  foreshadows: Foreshadow[];
  characters: CharacterCard[];
  /** 章 id -> 正文（仅已有文件的章） */
  bodies: Array<{ id: string; content: string }>;
  l0: L0Report;
  usage: CacheStats;
}

export function buildHealthReport(input: HealthInput): HealthReport {
  const { outline, summaries, foreshadows, characters, bodies, l0: rep, usage } = input;
  const order: string[] = [];
  const titleOf = new Map<string, string>();
  for (const v of outline.volumes) for (const c of v.chapters) { order.push(c.id); titleOf.set(c.id, c.title); }
  const bodyOf = new Map(bodies.map((b) => [b.id, b.content]));

  let archived = 0;
  let lastArchivedIdx = -1;
  order.forEach((cid, i) => {
    if ((summaries[cid] ?? '').trim()) { archived++; lastArchivedIdx = i; }
  });
  const totalWords = bodies.reduce((a, b) => a + countChars(b.content), 0);

  let open = 0; let resolved = 0; let abandoned = 0;
  const overdue: HealthReport['foreshadow']['overdue'] = [];
  for (const f of foreshadows) {
    if (f.status === 'resolved') { resolved++; continue; }
    if (f.status === 'abandoned') { abandoned++; continue; }
    open++;
    const pIdx = f.payoffChapterId ? order.indexOf(f.payoffChapterId) : -1;
    if (pIdx >= 0 && pIdx <= lastArchivedIdx) {
      overdue.push({
        id: f.id, content: f.content.slice(0, 80),
        payoffChapterId: f.payoffChapterId!, payoffTitle: titleOf.get(f.payoffChapterId!) ?? f.payoffChapterId!,
      });
    }
  }

  const appearances = characters.map((c) => ({
    name: c.name, role: c.role,
    chapters: order.reduce((n, cid) => n + ((bodyOf.get(cid) ?? '').includes(c.name) ? 1 : 0), 0),
    stateNodes: Array.isArray(c.stateHistory) ? c.stateHistory.length : 0,
  }));

  const l0Agg: HealthReport['l0'] = { high: 0, medium: 0, low: 0, chapters: [] };
  for (const [cid, e] of Object.entries(rep)) {
    const c = { high: 0, medium: 0, low: 0 };
    for (const f of e.findings) c[f.severity]++;
    l0Agg.high += c.high; l0Agg.medium += c.medium; l0Agg.low += c.low;
    if (c.high + c.medium + c.low > 0) l0Agg.chapters.push({ chapterId: cid, title: titleOf.get(cid) ?? cid, ...c });
  }
  l0Agg.chapters.sort((a, b) => (a.high !== b.high ? b.high - a.high : (b.medium + b.low) - (a.medium + a.low)));

  return {
    progress: { total: order.length, archived, totalWords },
    foreshadow: { open, resolved, abandoned, overdue },
    appearances,
    l0: l0Agg,
    usage,
  };
}
