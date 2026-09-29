import { describe, expect, it } from 'vitest';
import type { CharacterCard, Foreshadow, Outline } from '../../shared/src/types';
import { buildHealthReport } from './health-aggregate';
import { emptyCacheStats } from './cache-stats';
import type { L0Report } from './l0-report';

function outline3(): Outline {
  return {
    premise: 'p', genre: 'g', coreConflict: 'c', endingVision: 'e', styleGuide: 's',
    volumes: [{ id: 'v01', title: '卷一', summary: '', chapters: [
      { id: 'v01c001', title: '第一章', beat: 'b', status: 'revised' },
      { id: 'v01c002', title: '第二章', beat: 'b', status: 'revised' },
      { id: 'v01c003', title: '第三章', beat: 'b', status: 'todo' },
    ] }],
  };
}
const f_ = (over: Partial<Foreshadow>): Foreshadow => ({ id: 'f', setupChapterId: 'v01c001', content: '铜牌来历', status: 'open', createdAt: '', ...over });
const c_ = (over: Partial<CharacterCard>): CharacterCard => ({ id: 'x', name: '李慎', role: '主角', personality: '', background: '', relations: '', ...over });

describe('buildHealthReport', () => {
  const base = {
    outline: outline3(),
    summaries: { v01c001: '一', v01c002: '二' },                 // 归档进度 = 第二章
    foreshadows: [] as Foreshadow[],
    characters: [c_({ stateHistory: [{ chapterId: 'v01c001', chapterTitle: '第一章', state: '伤', at: '' }] })],
    bodies: [
      { id: 'v01c001', content: '李慎出场，提到王五名字' },
      { id: 'v01c002', content: '李慎again，王五不在场' },
    ],
    l0: {} as L0Report,
    usage: emptyCacheStats(),
  };

  it('进度与字数：归档数、总章数、去空白字数', () => {
    const h = buildHealthReport(base);
    expect(h.progress).toEqual({ total: 3, archived: 2, totalWords: 11 + 13 });
  });

  it('伏笔：回收章已越过进度的 open 计为逾期；未定/未到/已收不算', () => {
    const h = buildHealthReport({ ...base, foreshadows: [
      f_({ id: 'a', payoffChapterId: 'v01c002' }),          // 已到回收章且已归档 → 逾期
      f_({ id: 'b', payoffChapterId: 'v01c003' }),          // 回收章还没写到 → 不算
      f_({ id: 'c' }),                                      // 未定回收章 → 不算
      f_({ id: 'd', payoffChapterId: 'v01c001', status: 'resolved' }),
      f_({ id: 'e', payoffChapterId: 'v01c001', status: 'abandoned' }),
    ] });
    expect(h.foreshadow.open).toBe(3);
    expect(h.foreshadow.resolved).toBe(1);
    expect(h.foreshadow.abandoned).toBe(1);
    expect(h.foreshadow.overdue.map((o) => o.id)).toEqual(['a']);
    expect(h.foreshadow.overdue[0].payoffTitle).toBe('第二章');
  });

  it('人物出场：正文含名计章；stateHistory 节点数直读', () => {
    const h = buildHealthReport({ ...base, foreshadows: [] });
    expect(h.appearances).toEqual([{ name: '李慎', role: '主角', chapters: 2, stateNodes: 1 }]);
  });

  it('L0 汇总：分级计数 + 有问题的章按严重度排序', () => {
    const h = buildHealthReport({ ...base, foreshadows: [], l0: {
      v01c001: { at: 't', findings: [
        { code: 'title-leak', severity: 'high', message: 'x' },
        { code: 'modern-word', severity: 'medium', message: 'y' },
      ] },
      v01c002: { at: 't', findings: [{ code: 'repeated-block', severity: 'low', message: 'z' }] },
      v01c003: { at: 't', findings: [{ code: 'title-leak', severity: 'high', message: 'w' }] },
    } });
    expect(h.l0).toMatchObject({ high: 2, medium: 1, low: 1 });
    // 排序：high 数降序，其次 medium+low 降序 → v01c001(1h1m) 先于 v01c003(1h0m)，v01c002(0h1l) 最后
    expect(h.l0.chapters.map((c) => c.chapterId)).toEqual(['v01c001', 'v01c003', 'v01c002']);
  });
});
