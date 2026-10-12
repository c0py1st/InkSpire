import { describe, expect, it } from 'vitest';
import { extractCitationCandidates, markCitations, verifyIssueQuotes, verifyQuote } from './quote-verify';

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

describe('extractCitationCandidates（引语 vs 提及）', () => {
  it('提及性短引号词（术语/人名）不提取；句子样或带引导语的引语提取', () => {
    const t = '书中反复出现「照胆」与「铁鹰符」等词。他说道：“客人。去临江城，是投亲，还是寻仇？” 还提到「白鹤」二字。';
    const got = extractCitationCandidates(t);
    expect(got).toContain('客人。去临江城，是投亲，还是寻仇？');
    expect(got).not.toContain('照胆');
    expect(got).not.toContain('铁鹰符');
    expect(got).not.toContain('白鹤');
  });

  it('引号内含句读的长串按句子样提取（无需引导词）；结果去重', () => {
    const t = '“义字值几钱一斤，江湖上没人答得出。” 前文也引过“义字值几钱一斤，江湖上没人答得出。”';
    const got = extractCitationCandidates(t);
    expect(got).toEqual(['义字值几钱一斤，江湖上没人答得出。']);
  });

  it('引号被嵌套/换行破坏时不产出（不误伤），空文本返回空', () => {
    expect(extractCitationCandidates('他说：「这是“嵌套”的怪写法」')).toEqual([]);
    expect(extractCitationCandidates('')).toEqual([]);
    expect(extractCitationCandidates('没有任何引号的一句话')).toEqual([]);
  });
});

describe('markCitations（答案引语全书核验）', () => {
  const book = '　　“客人。”老艄公在船尾开口，烟杆磕了磕船板，“去临江城，是投亲，还是寻仇？”\n　　梅靳答：“寻亲。”';

  it('真引文 ok=true；把被叙述隔开的两段缝成一句 → ok=false（本次活体实锤案例）', () => {
    const answer = '他的原话是：“客人。去临江城，是投亲，还是寻仇？” 梅靳只答了“寻亲。”';
    const marks = markCitations(answer, book);
    const byQuote = new Map(marks.map((m) => [m.quote, m.ok]));
    expect(byQuote.get('客人。去临江城，是投亲，还是寻仇？')).toBe(false); // 缝合假引文
    expect(byQuote.get('寻亲。')).toBeUndefined();                          // 短提及不核验
    expect([...byQuote.values()]).toContain(false);
  });

  it('逐字真引文通过；无引语或无书文返回空', () => {
    expect(markCitations('梅靳只答了“寻亲。”', book)).toEqual([]);           // 寻亲。仅3字提及级，不核验
    expect(markCitations('“去临江城，是投亲，还是寻仇？”是老艄公问的', book)).toEqual([{ quote: '去临江城，是投亲，还是寻仇？', ok: true }]);
    expect(markCitations('', book)).toEqual([]);
    expect(markCitations('“随便一句足够长的话，带逗号的引语”', '')).toEqual([]);
  });
});
