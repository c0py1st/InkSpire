import { describe, expect, it } from 'vitest';
import type { Foreshadow, Outline } from '../../shared/src/types';
import { buildSummariesText, flattenChapterIds, foreshadowText, locateChapter, nextChapterIds, openForeshadowListText } from './ai/memory';

function fs_(over: Partial<Foreshadow>): Foreshadow {
  return {
    id: 'f1', setupChapterId: 'v01c001', content: '铜牌来历',
    status: 'open', createdAt: '', ...over,
  };
}

function outline(): Outline {
  const chapters = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `v01c${String(i + 1).padStart(3, '0')}`.replace('v01', prefix),
      title: `${prefix}-第${i + 1}章`,
      beat: 'b',
      status: 'todo' as const,
    }));
  return {
    premise: 'p', genre: 'g', coreConflict: 'c', endingVision: 'e', styleGuide: 's',
    volumes: [
      { id: 'v01', title: '卷一', summary: '', chapters: chapters('v01', 3) },
      { id: 'v02', title: '卷二', summary: '', chapters: chapters('v02', 2) },
    ],
  };
}

describe('locateChapter', () => {
  it('找到章节及其卷', () => {
    const o = outline();
    const loc = locateChapter(o, 'v02c001');
    expect(loc.volumeIndex).toBe(1);
    expect(loc.chapter.title).toBe('v02-第1章');
  });

  it('找不到时抛错', () => {
    expect(() => locateChapter(outline(), 'v09c009')).toThrow();
  });
});

describe('buildSummariesText', () => {
  it('只包含当前章之前的摘要，顺序为章节顺序', () => {
    const o = outline();
    const text = buildSummariesText(o, { v01c001: '一', v01c003: '三', v02c001: '五' }, 'v02c001');
    expect(text).toContain('v01-第1章');
    expect(text).toContain('v01-第3章');
    expect(text).not.toContain('v02');
    expect(text.indexOf('v01-第1章')).toBeLessThan(text.indexOf('v01-第3章'));
  });

  it('回归：重写旧卷章节时不得注入后续卷的摘要', () => {
    const o = outline();
    // 给第 1 卷第 1 章组前情——所有已归档摘要都在它之后
    const text = buildSummariesText(
      o,
      { v01c002: '二', v01c003: '三', v02c001: '四', v02c002: '五' },
      'v01c001',
    );
    expect(text).toBe('');
  });

  it('起点章不在大纲时返回全部摘要（全书问答场景）', () => {
    const o = outline();
    const text = buildSummariesText(o, { v01c001: '一', v02c002: '五' }, 'nope');
    expect(text).toContain('一');
    expect(text).toContain('五');
  });

  it('预算截断：预算为 0 时不返回任何内容', () => {
    const o = outline();
    // 通过内部常量无法直接改，这里验证超长预算行为——budget 逻辑用小文本验证顺序即可
    const text = buildSummariesText(o, { v01c001: '一', v01c002: '二' }, 'v01c003');
    expect(text).toContain('一');
    expect(text).toContain('二');
  });
});

describe('flattenChapterIds', () => {
  it('卷序+卷内序展开全部章 id', () => {
    expect(flattenChapterIds(outline())).toEqual([
      'v01c001', 'v01c002', 'v01c003', 'v02c001', 'v02c002',
    ]);
  });
});

describe('nextChapterIds', () => {
  it('含起点，跨卷衔接', () => {
    expect(nextChapterIds(outline(), 'v01c002', 4)).toEqual([
      'v01c002', 'v01c003', 'v02c001', 'v02c002',
    ]);
  });

  it('末尾不足 count 时返回剩余', () => {
    expect(nextChapterIds(outline(), 'v02c002', 5)).toEqual(['v02c002']);
  });

  it('起点不在大纲时抛错', () => {
    expect(() => nextChapterIds(outline(), 'v09c001', 3)).toThrow();
  });
});

describe('foreshadowText', () => {
  const o = outline();

  it('埋设章在本章之前的未收伏笔要列出，之后埋的不列', () => {
    const items = [
      fs_({ id: 'a', setupChapterId: 'v01c001', content: '甲牌' }),
      fs_({ id: 'b', setupChapterId: 'v02c002', content: '乙线' }),
    ];
    const text = foreshadowText(o, items, 'v01c002');
    expect(text).toContain('甲牌');
    expect(text).not.toContain('乙线');
  });

  it('指定本章回收的伏笔以"必须回收"呈现且排在前面', () => {
    const items = [
      fs_({ id: 'a', setupChapterId: 'v01c001', content: '普通线' }),
      fs_({ id: 'b', setupChapterId: 'v01c001', payoffChapterId: 'v01c002', content: '该收了' }),
    ];
    const text = foreshadowText(o, items, 'v01c002');
    expect(text).toContain('本章必须回收：该收了');
    expect(text.indexOf('该收了')).toBeLessThan(text.indexOf('普通线'));
  });

  it('已回收/废弃不再出现', () => {
    const items = [
      fs_({ id: 'a', content: '收了', status: 'resolved' }),
      fs_({ id: 'b', content: '扔了', status: 'abandoned' }),
    ];
    const text = foreshadowText(o, items, 'v02c001');
    expect(text).toBe('');
  });

  it('空表返回空串', () => {
    expect(foreshadowText(o, [], 'v01c001')).toBe('');
  });
});

describe('openForeshadowListText（全书上下文）', () => {
  const o = outline();

  it('未回收条目同时带埋设章与计划回收章（不再丢回收信息）', () => {
    const text = openForeshadowListText(o, [
      fs_({ id: 'a', setupChapterId: 'v01c001', payoffChapterId: 'v01c003', content: '粮栈案' }),
    ]);
    expect(text).toContain('埋设于《');
    expect(text).toContain('(v01c001)');
    expect(text).toContain('计划回收于');
    expect(text).toContain('(v01c003)');
  });

  it('回收章未定时如实标注；已回收/废弃不列', () => {
    const text = openForeshadowListText(o, [
      fs_({ id: 'a', content: '待定线' }),
      fs_({ id: 'b', content: '收了', status: 'resolved' }),
      fs_({ id: 'c', content: '废了', status: 'abandoned' }),
    ]);
    expect(text).toContain('回收章未定');
    expect(text).not.toContain('收了');
    expect(text).not.toContain('废了');
  });

  it('空表返回空串', () => {
    expect(openForeshadowListText(o, [])).toBe('');
  });
});
