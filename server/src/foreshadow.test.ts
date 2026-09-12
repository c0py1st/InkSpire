import { describe, expect, it } from 'vitest';
import { sanitizeForeshadows } from './routes/project';

const valid = {
  id: 'f1', setupChapterId: 'v01c001', content: '铜牌', status: 'open', createdAt: '2026-01-01',
};

describe('sanitizeForeshadows', () => {
  it('保留结构完整的条目', () => {
    const out = sanitizeForeshadows([valid]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('铜牌');
  });

  it('非数组/脏对象/坏状态一律丢弃', () => {
    expect(sanitizeForeshadows('x')).toEqual([]);
    expect(sanitizeForeshadows([null, { id: 1 }, { ...valid, status: 'weird' }])).toEqual([]);
  });

  it('缺 createdAt 时补当前时间，payoffChapterId 空串转 undefined', () => {
    const out = sanitizeForeshadows([
      { ...valid, createdAt: undefined, payoffChapterId: '' },
    ]);
    expect(out).toHaveLength(1);
    expect(Number.isNaN(Date.parse(out[0].createdAt))).toBe(false);
    expect(out[0].payoffChapterId).toBeUndefined();
  });
});
