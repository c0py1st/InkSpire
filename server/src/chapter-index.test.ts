import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { indexSupported, searchChapters } from './chapter-index';

/** 建一本最小测试书：三章正文 + 大纲；返回 dataDir 与清理函数 */
function fixture(): { root: string; slug: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moge-cidx-'));
  const slug = '索引测试书';
  const ch = path.join(root, slug, 'chapters');
  fs.mkdirSync(ch, { recursive: true });
  const w = (id: string, title: string, body: string) =>
    fs.writeFileSync(path.join(ch, `${id}.md`), `---\ntitle: ${title}\n---\n${body}`);
  w('v01c001', '雪夜来客', '李慎摸到半块铜牌，铜牌刻字模糊。　　雨停了。');
  w('v01c002', '盐车疑云', '车辙深处又见半块铜的印记。LXGW Font 字样浮现。');
  w('v01c003', '停尸房的灯', '灯下验尸。\n\n　　他没有回顾。窗外雨声渐密。');
  fs.writeFileSync(
    path.join(root, slug, 'outline.json'),
    JSON.stringify({
      premise: '', genre: '', coreConflict: '', endingVision: '', styleGuide: '',
      volumes: [{
        id: 'v01', title: '卷一', summary: '',
        chapters: ['v01c001', 'v01c002', 'v01c003'].map((id, i) => ({
          id, title: ['', '雪夜来客', '盐车疑云', '停尸房的灯'][i + 1], beat: '', status: 'todo',
        })),
      }],
    }),
  );
  return { root, slug, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('chapter-index.searchChapters', () => {
  it('与旧全扫语义一致：中文短查询（2字，索引路径外）命中次序与偏移准确', () => {
    const { root, slug, cleanup } = fixture();
    try {
      const hits = searchChapters(slug, '铜牌', 40, root);
      expect(hits.length).toBe(2); // "半块铜牌，铜牌刻字" 两处，均在 v01c001
      expect(hits[0].chapterId).toBe('v01c001');
      // 摘录带命中括号、卷名可定位
      for (const h of hits) {
        expect(h.snippet).toContain('〔铜牌〕');
        expect(h.volumeTitle).toBe('卷一');
        expect(h.chapterTitle).toBeTruthy();
      }
    } finally { cleanup(); }
  });

  it('3 字中文走索引路径：偏移与 indexOf 完全一致（候选集允许假阳性，产出必须精确）', () => {
    const { root, slug, cleanup } = fixture();
    try {
      const hits = searchChapters(slug, '半块铜', 40, root);
      expect(hits.length).toBe(2);
      const c001 = hits.find((h) => h.chapterId === 'v01c001')!;
      const c002 = hits.find((h) => h.chapterId === 'v01c002')!;
      expect(c001.offset).toBe('李慎摸到半块铜牌，铜牌刻字模糊。　　雨停了。'.indexOf('半块铜'));
      expect(c002.offset).toBe('车辙深处又见半块铜的印记。LXGW Font 字样浮现。'.indexOf('半块铜'));
      // 索引已落盘
      if (indexSupported()) expect(fs.existsSync(path.join(root, slug, '.index', 'chapters.db'))).toBe(true);
    } finally { cleanup(); }
  });

  it('英文大小写不敏感（trigram 与降级扫描同口径）', () => {
    const { root, slug, cleanup } = fixture();
    try {
      expect(searchChapters(slug, 'lxgw', 40, root).length).toBe(1);
      expect(searchChapters(slug, 'LxGw', 40, root).length).toBe(1);
    } finally { cleanup(); }
  });

  it('跨段落查询（含换行）命中且偏移正确', () => {
    const { root, slug, cleanup } = fixture();
    try {
      const hits = searchChapters(slug, '。\n\n　　他没有回顾', 40, root);
      expect(hits.length).toBe(1);
      expect(hits[0].chapterId).toBe('v01c003');
      expect(hits[0].offset).toBe('灯下验尸。\n\n　　他没有回顾。窗外雨声渐密。'.indexOf('。\n\n　　他没有回顾'));
    } finally { cleanup(); }
  });

  it('增删改自动同步：改章后新词可搜、删章后旧词清零', () => {
    const { root, slug, cleanup } = fixture();
    try {
      searchChapters(slug, '雨声', 40, root); // 先建索引
      fs.appendFileSync(path.join(root, slug, 'chapters', 'v01c002.md'), '\n新增的孤灯词。');
      expect(searchChapters(slug, '孤灯词', 40, root).length).toBe(1);
      fs.rmSync(path.join(root, slug, 'chapters', 'v01c003.md'));
      expect(searchChapters(slug, '雨声渐密', 40, root).length).toBe(0);
    } finally { cleanup(); }
  });

  it('索引库损坏：自动重建，结果始终正确', () => {
    const { root, slug, cleanup } = fixture();
    try {
      searchChapters(slug, '半块铜', 40, root);
      fs.writeFileSync(path.join(root, slug, '.index', 'chapters.db'), '这不是 sqlite 文件');
      const hits = searchChapters(slug, '半块铜', 40, root);
      expect(hits.length).toBe(2);
    } finally { cleanup(); }
  });

  it('limit 截断生效：命中多于 limit 时按阅读序取前 N', () => {
    const { root, slug, cleanup } = fixture();
    try {
      const capped = searchChapters(slug, '铜牌', 1, root);
      expect(capped.length).toBe(1);
      expect(capped[0].chapterId).toBe('v01c001'); // 阅读序第一处
    } finally { cleanup(); }
  });
});
