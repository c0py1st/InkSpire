import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StoryEvent } from '../../shared/src/types';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moge-events-'));
process.env.INKSPIRE_DATA_DIR = tmp;
const { sanitizeStoryEvents, loadEvents, saveEvents, mergeChapterAutoEvents } = await import('./fs-store');

const ev = (over: Partial<StoryEvent>): StoryEvent => ({
  id: 'e1', chapterId: 'v01c002', title: '盐仓被焚', source: 'auto', at: '2026-01-01T00:00:00Z', ...over,
});

describe('sanitizeStoryEvents', () => {
  it('合法条目保留，可选字段归一', () => {
    const out = sanitizeStoryEvents([ev({ actors: ['李慎', ' 周主簿 ', ''], whenInStory: '三年冬', detail: '  ' })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ chapterId: 'v01c002', title: '盐仓被焚', source: 'auto', actors: ['李慎', '周主簿'] });
    expect(out[0].detail).toBeUndefined(); // 空白 detail 归一为缺省
  });

  it('脏条目丢弃不丢全档：非法章号/空标题/非对象/重复 actor 截断', () => {
    const out = sanitizeStoryEvents([
      'nope', null, { id: 'x', chapterId: '乱码', title: 'a' }, { id: 'y', chapterId: 'v01c001', title: '  ' },
      ev({ id: 'ok', actors: Array.from({ length: 20 }, (_, i) => `甲${i}`) }),
    ]);
    expect(out.map((e) => e.id)).toEqual(['ok']);
    expect(out[0].actors).toHaveLength(8); // actors 上限
  });

  it('source 缺省/乱值按 manual 处理（手改文件漏字段不算废）', () => {
    const out = sanitizeStoryEvents([ev({ source: undefined as never }), ev({ id: 'e2', source: 'weird' as never })]);
    expect(out.every((e) => e.source === 'manual')).toBe(true);
  });

  it('非数组整体 → 空表', () => {
    expect(sanitizeStoryEvents({})).toEqual([]);
    expect(sanitizeStoryEvents('x')).toEqual([]);
  });
});

describe('mergeChapterAutoEvents（重归档整批换 auto、manual 不动）', () => {
  it('同章 auto 被新批替换；他章与 manual 保留；结果按章序归位', () => {
    const existing = [
      ev({ id: 'a1', chapterId: 'v01c001', title: '旧一' }),
      ev({ id: 'a2', chapterId: 'v01c002', title: '将被替换' }),
      ev({ id: 'm1', chapterId: 'v01c002', title: '作者补记', source: 'manual' }),
    ];
    const next = mergeChapterAutoEvents(existing, 'v01c002', [ev({ id: 'n1', chapterId: 'v01c002', title: '新一' })]);
    expect(next.map((e) => e.id).sort()).toEqual(['a1', 'm1', 'n1'].sort());
    expect(next[0].chapterId).toBe('v01c001'); // 章序排列
  });

  it('该章无 auto 旧账时纯追加', () => {
    const next = mergeChapterAutoEvents([ev({ id: 'm1', source: 'manual' })], 'v01c003', [ev({ id: 'n1', chapterId: 'v01c003' })]);
    expect(next.map((e) => e.id)).toEqual(['m1', 'n1']);
  });
});

describe('loadEvents/saveEvents 落盘往返', () => {
  const slug = 'evbook';
  it('写入后可读回；文件被改脏时读取即消毒', () => {
    saveEvents(slug, [ev({ id: 'e1' }), ev({ id: 'e2', chapterId: 'v01c003', title: '另一事' })]);
    expect(fs.existsSync(path.join(tmp, slug, 'events.json'))).toBe(true);
    expect(loadEvents(slug)).toHaveLength(2);
    fs.writeFileSync(path.join(tmp, slug, 'events.json'), '{"not":"array"}', 'utf8');
    expect(loadEvents(slug)).toEqual([]); // 脏文件退化为空表而不是崩
  });
});
