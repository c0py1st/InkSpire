import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findIndentIssues, findLengthSkew, findModernWords, findRepeatedBlocks,
  findTitleLeak, l0Check, looksAncientSetting,
} from '../../shared/src/l0';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moge-l0-'));
process.env.INKSPIRE_DATA_DIR = tmp;
const { sanitizeL0Report, saveChapterL0, loadL0Report } = await import('./l0-report');

describe('L0 纯检查器', () => {
  it('标题泄漏：markdown 行/章题行/作者话命中，正文不误报', () => {
    expect(findTitleLeak('# 随便写的标题\n　　正常正文。')).toHaveLength(1);
    expect(findTitleLeak('　　正文一。\n\n第三章 血夜\n\n　　正文二。')[0]?.message).toContain('章标题');
    expect(findTitleLeak('　　正文。\n本章字数：3000').length).toBe(1);
    expect(findTitleLeak('　　他在雪里站了三章那么久。')).toHaveLength(0); // "三章"在叙述中不误报（需整行匹配）
  });

  it('重复块：≥15 字复现命中；短复现与不重复不报', () => {
    const dup = '风从窗缝里钻进来，烛火矮了一寸，更声不紧不慢。';
    expect(findRepeatedBlocks(`　　${dup}\n\n　　中段的不同文字内容内容内容内容。\n\n　　${dup}`)[0]?.code).toBe('repeated-block');
    expect(findRepeatedBlocks('　　他走了。他走了。')).toHaveLength(0); // <15 字不报
    expect(findRepeatedBlocks('　　完全没有重复的一段正常叙述文字内容测试。')).toHaveLength(0);
  });

  it('现代词：默认表受 ancientSetting 门控；自定义禁词无条件', () => {
    expect(findModernWords('　　他掏出手机看了一眼。', { useDefaults: false, bannedWords: [] })).toHaveLength(0);
    expect(findModernWords('　　他掏出手机看了一眼。', { useDefaults: true, bannedWords: [] })).toHaveLength(1);
    const r = findModernWords('　　玄甲车的车轱辘坏了。', { useDefaults: false, bannedWords: ['车轱辘'] });
    expect(r[0]?.message).toContain('车轱辘');
    expect(findModernWords('　　电话电话。', { useDefaults: true, bannedWords: ['电话'] })).toHaveLength(1); // 去重
  });

  it('缩进：过半失约才报', () => {
    expect(findIndentIssues('\u3000\u3000甲。\n\n\u3000\u3000乙。\n\n\u3000\u3000丙。')).toHaveLength(0);
    expect(findIndentIssues('\u3000\u3000甲。\n\n乙。\n\n丙。')[0]?.code).toBe('indent-style');
  });

  it('字数：偏离比例分级正确，无目标不检查', () => {
    expect(findLengthSkew('短', 1000)[0]?.severity).toBe('medium');
    expect(findLengthSkew('字'.repeat(3100), 1000)[0]?.severity).toBe('low');
    expect(findLengthSkew('字'.repeat(800), 1000)).toHaveLength(0);
    expect(findLengthSkew('短', undefined)).toHaveLength(0);
  });

  it('题材门控判定与整体组合、空文短路', () => {
    expect(looksAncientSetting('古风悬疑')).toBe(true);
    expect(looksAncientSetting('都市言情')).toBe(false);
    expect(l0Check('')).toHaveLength(0);
    const r = l0Check('# 标题混入\n正文', { ancientSetting: true, targetWords: 500 });
    expect(r.some((f) => f.code === 'title-leak')).toBe(true);
    expect(r.some((f) => f.code === 'length-skew')).toBe(true);
  });
});

describe('L0 报告缓存（.index 可重建层）', () => {
  const slug = 'l0book';

  it('消毒：非法条目丢弃、合法保留', () => {
    const s = sanitizeL0Report({
      v01c001: { at: 't', findings: [{ code: 'title-leak', severity: 'high', message: 'x', quote: 'q', at: 3 }, { code: 'hack', severity: '?', message: 1 }, null] },
      junk: 'no',
      v01c002: { at: 5, findings: [] },
    });
    expect(Object.keys(s)).toEqual(['v01c001', 'v01c002']);
    expect(s.v01c001.findings).toHaveLength(1);
    expect(s.v01c002.at).toBe(''); // 非字符串 at 退化为空
  });

  it('saveChapterL0 落 .index、往返一致', () => {
    saveChapterL0(slug, 'v01c001', [{ code: 'modern-word', severity: 'medium', message: '出现现代词「电话」', quote: '一个电话', at: 2 }]);
    expect(fs.existsSync(path.join(tmp, slug, '.index', 'l0-report.json'))).toBe(true);
    const rep = loadL0Report(slug);
    expect(rep.v01c001.findings[0].code).toBe('modern-word');
    saveChapterL0(slug, 'v01c001', []); // 复检通过覆盖旧结果
    expect(loadL0Report(slug).v01c001.findings).toHaveLength(0);
  });
});
