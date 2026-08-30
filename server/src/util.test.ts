import { describe, expect, it } from 'vitest';
import { atParagraphStart, ensureParagraphIndent } from '../../shared/src/util';

describe('ensureParagraphIndent', () => {
  it('给每个非空行补两个全角空格', () => {
    const out = ensureParagraphIndent('第一段。\n\n第二段。');
    expect(out).toBe('\u3000\u3000第一段。\n\n\u3000\u3000第二段。');
  });

  it('已有缩进的不重复添加，行首半角空格被规整', () => {
    const out = ensureParagraphIndent('\u3000\u3000已缩进。\n  半角空格行。\n\tTab行。');
    expect(out).toBe('\u3000\u3000已缩进。\n\u3000\u3000半角空格行。\n\u3000\u3000Tab行。');
  });

  it('空行保持为空', () => {
    expect(ensureParagraphIndent('a\n\n\nb')).toBe('\u3000\u3000a\n\n\n\u3000\u3000b');
    expect(ensureParagraphIndent('a\n   \nb')).toBe('\u3000\u3000a\n\n\u3000\u3000b');
  });

  it('空文本返回空', () => {
    expect(ensureParagraphIndent('')).toBe('');
  });

  it('幂等', () => {
    const once = ensureParagraphIndent('第一段。\n\n第二段。');
    expect(ensureParagraphIndent(once)).toBe(once);
  });
});

describe('atParagraphStart', () => {
  it('正文起始与换行后为段首', () => {
    expect(atParagraphStart('abc', 0)).toBe(true);
    expect(atParagraphStart('a\nbc', 2)).toBe(true);
    expect(atParagraphStart('abc', 1)).toBe(false);
  });
});
