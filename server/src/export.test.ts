import { describe, expect, it } from 'vitest';
import type { ChapterFile, Outline, ProjectMeta } from '../../shared/src/types';
import { buildExportText } from './export';

const meta = { slug: 's', title: '测试书', logline: '一句话简介', createdAt: '', updatedAt: '' } as ProjectMeta;
const outline = {
  premise: '', genre: '', coreConflict: '', endingVision: '', styleGuide: '',
  volumes: [
    { id: 'v01', title: '卷一·起', summary: '', chapters: [
      { id: 'v01c001', title: '第一章', beat: '', status: 'draft' as const },
      { id: 'v01c002', title: '第二章', beat: '', status: 'todo' as const },
    ] },
    { id: 'v02', title: '卷二·承', summary: '', chapters: [
      { id: 'v02c001', title: '第三章', beat: '', status: 'draft' as const },
    ] },
  ],
} as Outline;
const chapters = [
  { id: 'v01c001', title: '第一章', status: 'draft', content: '　　**甲**正文段。\n\n　　第二段。' },
  { id: 'v02c001', title: '第三章', status: 'draft', content: '　　丙正文。' },
] as ChapterFile[];

describe('整本导出（buildExportText）', () => {
  it('md：完整层级 + 书名/引/卷/章 + 未完成占位', () => {
    const t = buildExportText(meta, outline, chapters, 'md');
    expect(t).toContain('# 测试书');
    expect(t).toContain('> 一句话简介');
    expect(t).toContain('## 卷一·起');
    expect(t).toContain('### 第二章');
    expect(t).toContain('（未完成）');   // v01c002 无正文
    expect(t).toContain('　　**甲**正文段。'); // 正文原样
  });

  it('txt：零 markdown 残留（粘贴平台友好），卷/章各占一行裸标题', () => {
    const t = buildExportText(meta, outline, chapters, 'txt');
    expect(t).not.toMatch(/[#>*`]/);            // 一个标记符都不许剩
    expect(t).toContain('测试书');
    expect(t).toContain('卷二·承');
    expect(t).toContain('第三章');
    expect(t).toContain('甲正文段');             // ** 已剥
    expect(t).toContain('　　');                 // 正文缩进保留
  });

  it('章顺序按大纲走，不是文件名字典序（跨卷移动过也不乱）', () => {
    const t = buildExportText(meta, outline, chapters, 'md');
    expect(t.indexOf('第一章')).toBeLessThan(t.indexOf('第二章'));
    expect(t.indexOf('第二章')).toBeLessThan(t.indexOf('第三章'));
  });
});
