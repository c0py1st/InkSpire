import { describe, expect, it } from 'vitest';
import { auditNamePairs, cleanSeeds, heuristicSeeds, quoteSeeds } from './name-audit';

const T = (id: string, title: string, text: string) => ({ id, title, text });

describe('启发种子（heuristicSeeds）', () => {
  it('抓地名/器物尾字候选，前导虚词窗口被滤、碎片后缀去重', () => {
    const s = heuristicSeeds('沈砚之到了临江城。临江城西门守着两个衙役。他听说临沂城闹匪。腰悬青冥剑。');
    const words = s.map((x) => x.word);
    expect(words).toContain('临江城');
    expect(words).toContain('临沂城');
    expect(words).toContain('青冥剑');
    // "江城"是"临江城"的后缀 → 丢弃；"了临"类前导虚词不成词
    expect(words).not.toContain('江城');
    expect(s.every((x) => x.source === 'quote')).toBe(true);
  });
});

describe('专名串改扫描（auditNamePairs）', () => {
  it('近似对一多一少 → 上报低频方与出现位置', () => {
    const texts = [
      T('v01c001', '第一章', '沈砚之到了临江城。临江城西门守着两个衙役。'),
      T('v01c002', '第二章', '沈砚之听说临沂城闹了匪患，改道往北。'),
      T('v01c003', '第三章', '临江城的水门夜里落闸，沈砚之在驿栈磨刀。'),
    ];
    const r = auditNamePairs([{ word: '临江城', source: 'card' }, { word: '临沂城', source: 'quote' }], texts);
    expect(r).toHaveLength(1);
    expect(r[0].a).toBe('临江城');
    expect(r[0].b).toBe('临沂城');
    expect(r[0].ca).toBe(3);
    expect(r[0].cb).toBe(1);
    expect(r[0].bothSeeded).toBe(false);
    expect(r[0].hits[0].chapterId).toBe('v01c002');
    expect(r[0].hits[0].context).toContain('临沂城');
  });

  it('两方都高频（合法双实体）→ 不报', () => {
    const texts = [T('v01c001', '一', '临江城临沂城临江城临沂城临江城临沂城')];
    expect(auditNamePairs([{ word: '临江城', source: 'card' }, { word: '临沂城', source: 'lore' }], texts)).toEqual([]);
  });

  it('两方都有权威出处且一多一少 → 报但标 bothSeeded', () => {
    const texts = [
      T('v01c001', '一', '沈砚之在青冥剑下退三步。青冥剑青光暴涨。另有一柄青溟剑藏于匣中。青冥剑再出。青冥剑归鞘。'),
    ];
    const r = auditNamePairs([{ word: '青冥剑', source: 'lore' }, { word: '青溟剑', source: 'card' }], texts);
    expect(r).toHaveLength(1);
    expect(r[0].a).toBe('青冥剑');
    expect(r[0].b).toBe('青溟剑');
    expect(r[0].bothSeeded).toBe(true);
  });

  it('距离阈值：3 字对差 2 不报，4 字对差 2 报', () => {
    const texts = [T('v01c001', '一', '白鹤川来了三回。玄鹤江出现一次。白鹤川又至。白鹤川归。')];
    expect(auditNamePairs([{ word: '白鹤川', source: 'card' }, { word: '玄鹤江', source: 'quote' }], texts)).toEqual([]);
    const t2 = [T('v01c001', '一', '司徒无咎拔剑。司马无巨倒地。司徒无咎收剑。司徒无咎复又出城。')];
    expect(auditNamePairs([{ word: '司徒无咎', source: 'card' }, { word: '司马无巨', source: 'quote' }], t2)).toHaveLength(1);
  });

  it('一个低频词只挂最高频近似主（防刷屏）', () => {
    const texts = [T('v01c001', '一', '临江城临江城临江城临江城照江城沈砚')];
    const r = auditNamePairs(
      [{ word: '临江城', source: 'card' }, { word: '照江城', source: 'quote' }, { word: '沈砚', source: 'card' }],
      texts,
    );
    expect(r).toHaveLength(1);
    expect(r[0].a).toBe('临江城');
    expect(r[0].b).toBe('照江城');
  });
});

describe('种子收集（cleanSeeds / quoteSeeds）', () => {
  it('清洗：长度 2~8、纯中文、按强弱出处去重', () => {
    const c = cleanSeeds([
      { word: ' 沈砚之 ', source: 'quote' },
      { word: '沈砚之', source: 'card' },
      { word: '剑', source: 'card' },
      { word: 'Bob', source: 'lore' },
      { word: '长'.repeat(9), source: 'lore' },
    ]);
    expect(c).toEqual([{ word: '沈砚之', source: 'card' }]);
  });

  it('正文「」引用：≥2 次且纯中文 2~8 字才成种子', () => {
    const s = quoteSeeds('「照胆」出鞘，另有「照胆」与「雨。夜」和「玄冰剑」「玄冰剑」与「A」。');
    expect(s.map((x) => x.word)).toEqual(['照胆', '玄冰剑']);
  });
});
