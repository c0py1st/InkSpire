import type { CacheStats, CharacterCard, Foreshadow, HealthReport, Outline, PacingDryRun, WebnovelPacing } from '../../shared/src/types';
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

/**
 * 网文节奏分析（E3）：从大纲的爽点/钩子标记纯派生，零模型调用。
 * 判据来自中文连载经验共识：爽点可以小但不能长期断档——连续 ≥DRY_WARN 章
 * 无爽点即亮红线；章末钩子缺失的章列出来供补列（不判死活，只报缺口）。
 */
const DRY_WARN = 5;

export function analyzePacing(outline: Outline): WebnovelPacing {
  const chapters = outline.volumes.flatMap((v) => v.chapters);
  const payoff = chapters.map((c) => !!c.payoffPoint?.trim());
  const hook = chapters.map((c) => !!c.chapterHook?.trim());

  const dryRuns: PacingDryRun[] = [];
  let runStart = -1;
  for (let i = 0; i <= chapters.length; i++) {
    const isDry = i < chapters.length && !payoff[i];
    if (isDry && runStart < 0) runStart = i;
    if (!isDry && runStart >= 0) {
      dryRuns.push({ fromChapterId: chapters[runStart].id, toChapterId: chapters[i - 1].id, length: i - runStart });
      runStart = -1;
    }
  }
  dryRuns.sort((a, b) => b.length - a.length);

  return {
    chapters: chapters.length,
    payoffChapters: payoff.filter(Boolean).length,
    hookChapters: hook.filter(Boolean).length,
    longestDry: dryRuns.length ? dryRuns[0].length : 0,
    warnAfter: DRY_WARN,
    dryRuns: dryRuns.filter((r) => r.length >= 2).slice(0, 5),   // 单章空洞不值得说，≥2 才算断档
    missingHook: chapters.filter((c, i) => !hook[i]).slice(0, 12).map((c) => ({ chapterId: c.id, title: c.title })),
  };
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
    pacing: analyzePacing(outline),
  };
}
