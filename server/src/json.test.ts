import { describe, expect, it } from 'vitest';
import { extractJson } from './ai/json';

describe('extractJson', () => {
  it('解析纯 JSON', () => {
    expect(extractJson<{ a: number }>('{"a": 1}')).toEqual({ a: 1 });
  });

  it('剥掉代码围栏', () => {
    const raw = '```json\n{"a": "包含 } 花括号的字符串", "b": [1,2]}\n```';
    expect(extractJson<{ a: string; b: number[] }>(raw).a).toContain('}');
    expect(extractJson<{ b: number[] }>(raw).b).toEqual([1, 2]);
  });

  it('容忍 JSON 前后的解释文字', () => {
    const raw = '好的，以下是结果：\n{"title": "第一章", "beat": "他说：“不。”"}\n希望有帮助';
    expect(extractJson<{ title: string }>(raw).title).toBe('第一章');
  });

  it('截断的 JSON 报错', () => {
    expect(() => extractJson('{"a": 1')).toThrow();
  });

  it('没有 JSON 报错', () => {
    expect(() => extractJson('抱歉，我做不到')).toThrow();
  });
});
