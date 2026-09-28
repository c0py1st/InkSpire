import { describe, expect, it } from 'vitest';
import { CHAT_MAX_MESSAGES, sanitizeChatRecords, sanitizeRecaps } from './fs-store';

describe('sanitizeChatRecords（对话落盘消毒）', () => {
  it('非数组一律空', () => {
    expect(sanitizeChatRecords(undefined)).toEqual([]);
    expect(sanitizeChatRecords('x')).toEqual([]);
    expect(sanitizeChatRecords({})).toEqual([]);
  });

  it('保留合法 user/assistant，丢弃空内容与非法 role', () => {
    const out = sanitizeChatRecords([
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '  ', at: 'x' }, // 空内容丢弃
      { role: 'hacker', content: '注入' },            // 非法 role 丢弃
      null, 42, 'str',
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
    expect(out[0].at).toBeTruthy(); // 缺省补时间戳
  });

  it('steps 白名单：非法条目剔除、长度收敛、done 默认为真', () => {
    const out = sanitizeChatRecords([{
      role: 'assistant', content: 'a',
      steps: [
        { name: 'search_chapters', detail: '搜「铜牌」→ 14 处', done: true },
        { name: '', detail: '无名丢弃' },
        { name: 'x'.repeat(200), detail: 'y'.repeat(500) }, // 超长截断
        'bad',
        { name: 'read_chapter', detail: 'd' },               // done 缺省 → true（恢复不残留"执行中"）
      ],
    }]);
    const steps = out[0].steps!;
    expect(steps).toHaveLength(3);
    expect(steps[2].done).toBe(true);
    expect(steps[1].name.length).toBeLessThanOrEqual(60);
    expect(steps[1].detail.length).toBeLessThanOrEqual(200);
  });

  it('proposals：kind/chapterId/content 三重校验，未决态可恢复', () => {
    const out = sanitizeChatRecords([{
      role: 'assistant', content: 'a',
      proposals: [
        { id: 1, kind: 'chapter', chapterId: 'v01c003', content: '新稿正文', decided: false },
        { id: 2, kind: 'summary', chapterId: 'BAD/../x', content: '非法章id丢弃' },
        { id: 3, kind: 'nope', chapterId: 'v01c001', content: '非法kind丢弃' },
        { id: 4, kind: 'chapter', chapterId: 'v01c002', content: '   ' }, // 空提案丢弃
      ],
    }]);
    const ps = out[0].proposals!;
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ id: 1, kind: 'chapter', chapterId: 'v01c003', decided: false });
  });

  it('超长会话从头截断，保留最近 CHAT_MAX_MESSAGES 条', () => {
    const many = Array.from({ length: CHAT_MAX_MESSAGES + 50 }, (_, i) => ({ role: 'user' as const, content: `第${i}条` }));
    const out = sanitizeChatRecords(many);
    expect(out).toHaveLength(CHAT_MAX_MESSAGES);
    expect(out[0].content).toBe('第50条');   // 旧的丢弃
    expect(out.at(-1)!.content).toBe(`第${CHAT_MAX_MESSAGES + 49}条`); // 新的保留
  });

  it('往返幂等：消毒结果再消毒不变', () => {
    const once = sanitizeChatRecords([{ role: 'user', content: 'hi', steps: [{ name: 'x', detail: 'd', done: true }] }]);
    expect(sanitizeChatRecords(once)).toEqual(once);
  });
});

describe('sanitizeRecaps（卷回本落盘消毒）', () => {
  it('非对象/数组一律空', () => {
    expect(sanitizeRecaps(undefined)).toEqual({});
    expect(sanitizeRecaps([])).toEqual({});
    expect(sanitizeRecaps('x')).toEqual({});
  });

  it('保留合法 volumeId，丢弃非法键与缺字段项', () => {
    const out = sanitizeRecaps({
      v01: { recap: '卷一回本', fingerprint: 'abcd1234', updatedAt: '2026-01-01T00:00:00.000Z' },
      c01: { recap: 'x', fingerprint: 'y' },        // 非法 volumeId
      v02: { recap: '   ', fingerprint: 'z' },       // 空 recap
      v03: { recap: '有文', fingerprint: '' },       // 缺指纹
      v04: '字符串',                                  // 非对象
    });
    expect(Object.keys(out)).toEqual(['v01']);
    expect(out.v01.recap).toBe('卷一回本');
  });

  it('多卷号 v100 等长格式也接受', () => {
    const out = sanitizeRecaps({ v100: { recap: '百', fingerprint: 'f1' } });
    expect(out.v100).toMatchObject({ recap: '百', fingerprint: 'f1' });
    expect(out.v100.updatedAt).toBeTruthy(); // 缺省补时间
  });
});
