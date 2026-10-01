import { describe, expect, it } from 'vitest';
import { normalizeReaderReview, readerReviewPrompt } from './ai/prompts/reader';

describe('readerReviewPrompt', () => {
  const base = { chapterTitle: '第一章', content: '正文内容', payoffPoint: '验尸翻盘', chapterHook: '尸袋滚出第二具' };

  it('网文模式用网文三 persona，通用模式用通用三 persona', () => {
    const wn = readerReviewPrompt({ ...base, webnovel: true }).user;
    expect(wn).toContain('爽文老饕');
    expect(wn).toContain('追更党');
    expect(wn).toContain('弃文读者');
    const gen = readerReviewPrompt({ ...base, webnovel: false }).user;
    expect(gen).toContain('书评人');
    expect(gen).not.toContain('爽文老饕');
  });

  it('作者标的爽点/钩子作为验收重点注入；不填则不出现', () => {
    const withT = readerReviewPrompt({ ...base, webnovel: true }).user;
    expect(withT).toContain('验尸翻盘');
    expect(withT).toContain('尸袋滚出第二具');
    const without = readerReviewPrompt({ chapterTitle: 't', content: 'c', webnovel: true }).user;
    expect(without).not.toContain('作者标注的本章爽点');
  });

  it('纪律：引证必须原样摘录 + 恰好三条 persona', () => {
    const u = readerReviewPrompt({ ...base, webnovel: false }).user;
    expect(u).toContain('原样摘录');
    expect(u).toContain('不许改写或凭空编造');
    expect(u).toContain('personas 恰好三条');
  });
});

describe('normalizeReaderReview', () => {
  const good = {
    personas: [
      { name: '甲', overall: 8, wouldContinue: true, praise: '好', grievances: [{ quote: 'q1', issue: 'i1' }] },
      { name: '乙', overall: 5, wouldContinue: false, praise: '', grievances: [] },
      { name: '丙', overall: 3, wouldContinue: false, praise: 'x', grievances: [{ quote: 'q3', issue: 'i3' }, { quote: 'x'.repeat(500), issue: 'y' }] },
    ],
    verdict: '总评', topFixes: ['一', '二', '三', '四（第四条应被截）'],
  };

  it('合法结构完整通过，越界值裁剪', () => {
    const r = normalizeReaderReview(good);
    expect(r).not.toBeNull();
    expect(r!.personas).toHaveLength(3);
    expect(r!.personas[2].grievances[1].quote).toHaveLength(200);   // 超长引文被裁到 200
    expect(r!.topFixes).toHaveLength(3);
  });

  it('overall 越界钳到 0~10、非数字归 0', () => {
    const r = normalizeReaderReview({ personas: [
      { name: 'a', overall: 42, wouldContinue: true, praise: '', grievances: [] },
      { name: 'b', overall: 'x', wouldContinue: false, praise: '', grievances: [] },
      { name: 'c', overall: -3, wouldContinue: false, praise: '', grievances: [] },
    ] });
    expect(r!.personas.map((p) => p.overall)).toEqual([10, 0, 0]);
  });

  it('脏条目丢弃；全脏/personas 缺失 → null', () => {
    expect(normalizeReaderReview({ personas: [null, 'x', {}] })).toBeNull();
    expect(normalizeReaderReview({ personas: 'nope' })).toBeNull();
    expect(normalizeReaderReview(null)).toBeNull();
    const mixed = normalizeReaderReview({ personas: [...good.personas, null, 7] });
    expect(mixed!.personas).toHaveLength(3);   // 脏的追加条目被丢
  });

  it('grievance 缺 quote/issue 的丢掉，其余保留', () => {
    const r = normalizeReaderReview({ personas: [
      { name: 'a', overall: 6, wouldContinue: true, praise: '', grievances: [{ quote: 'ok', issue: 'i' }, { quote: 1, issue: 'x' }, { issue: '没引文' }] },
      { name: 'b', overall: 6, wouldContinue: true, praise: '', grievances: [] },
      { name: 'c', overall: 6, wouldContinue: true, praise: '', grievances: [] },
    ] });
    expect(r!.personas[0].grievances).toHaveLength(1);
  });
});
