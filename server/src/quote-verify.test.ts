import { describe, expect, it } from 'vitest';
import { verifyIssueQuotes, verifyQuote } from './quote-verify';

const content = '　　雪夜。李慎推门而入，右手还缠着白布。\n\n　　“凭据呢？”他问。';

describe('verifyQuote', () => {
  it('逐字命中 → exact', () => {
    expect(verifyQuote('李慎推门而入，右手还缠着白布', content)).toBe('exact');
  });

  it('仅空白/换行差异命中 → loose', () => {
    expect(verifyQuote('李慎推门 而入，右手\n还缠着白布', content)).toBe('loose');
  });

  it('尾部省略号截半句 → 去掉省略号后仍 exact', () => {
    expect(verifyQuote('“凭据呢？”他问……', content)).toBe('exact');
    expect(verifyQuote('凭据呢…', content)).toBe('exact');
  });

  it('正文里根本不存在的引文 → false', () => {
    expect(verifyQuote('李慎当场拔刀斩了县令', content)).toBe(false);
  });

  it('空引文 / 空正文 → false', () => {
    expect(verifyQuote('', content)).toBe(false);
    expect(verifyQuote('李慎', '')).toBe(false);
  });
});

describe('verifyIssueQuotes', () => {
  it('给每条问题标注 verified，返回浅拷贝不改原对象', () => {
    const issues = [
      { severity: 'high', quote: '李慎推门而入', description: 'ok' },
      { severity: 'high', quote: '凭空捏造的句子', description: 'halluc' },
    ];
    const out = verifyIssueQuotes(issues, content);
    expect(out[0].verified).toBe('exact');
    expect(out[1].verified).toBe(false);
    expect((issues[0] as { verified?: unknown }).verified).toBeUndefined(); // 原对象未污染
  });
});
