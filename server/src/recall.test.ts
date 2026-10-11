import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChapterFile, Outline } from '../../shared/src/types';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moge-recall-'));
process.env.INKSPIRE_DATA_DIR = tmp;
const { splitParagraphs, extractTerms, recallForChapter, recallAvailable } = await import('./ai/recall');
const { saveRecallActivated, loadRecallActivated } = await import('./fs-store');
const { buildChapterContext } = await import('./ai/memory');
const { prosePrompt } = await import('./ai/prompts/prose');

const outline: Outline = {
  premise: '', genre: '武侠', coreConflict: '', endingVision: '', styleGuide: '',
  volumes: [{
    id: 'v01', title: '第一卷', summary: '',
    chapters: [
      { id: 'v01c001', title: '渡夜', beat: '', status: 'revised' },
      { id: 'v01c002', title: '巡船', beat: '', status: 'revised' },
      { id: 'v01c003', title: '江心', beat: '梅靳在江心想起紫竹笛与巡船', status: 'draft' },
      { id: 'v01c004', title: '后章', beat: '', status: 'todo' },
    ],
  }],
};

const ch = (id: string, title: string, content: string): ChapterFile => ({ id, title, status: 'revised', content });
const chapters: ChapterFile[] = [
  ch('v01c001', '渡夜', '渡口泊着一条夜船。\n\n老艄公烟杆一挑：上船。梅靳怀里揣着一支紫竹笛，笛身刻着无名款。'),
  ch('v01c002', '巡船', '铁袖帮的巡船横在江心，灯影如刀。\n\n梅靳按着斗笠没有动。'),
  ch('v01c003', '江心', '本章正文尚未写出。'),
  ch('v01c004', '后章', '紫竹笛再次出现——但它是未来章，不该被召回。'),
];

const run = (terms: string[], over?: Partial<Parameters<typeof recallForChapter>[0]>) =>
  recallForChapter({ slug: '召回测试书', outline, chapterId: 'v01c003', chapters, terms, ...over });

describe('A3 段落窗口与查询词抽取', () => {
  it('splitParagraphs：按行切、短尾并入、超长按句读断', () => {
    const ps = splitParagraphs('这一句足够长不会被并到别处去嗯确实挺长的了。\n短尾。');
    expect(ps).toEqual(['这一句足够长不会被并到别处去嗯确实挺长的了。短尾。']);
    const long = splitParagraphs('句。'.repeat(200));
    expect(long.length).toBeGreaterThan(1);
    expect(long.every((p) => p.length <= 260)).toBe(true);
  });

  it('extractTerms：人名/「」引用/切段/长段 3 字滑窗', () => {
    const ts = extractTerms('梅靳夜探「北楼」，忽然想起师傅说过的那笔旧账纠缠不清难以释怀', ['梅靳', '白鹤川']);
    expect(ts).toContain('梅靳');
    expect(ts).not.toContain('白鹤川');           // beat 没提的名字不抽
    expect(ts).toContain('北楼');                 // 「」引用
    expect(ts).toContain('旧账纠');               // 长段 3 字滑窗产物
  });
});

describe('A3 召回主路径（fts）与降级（scan）', () => {
  it('本运行时 node:sqlite 可用（fts 主路径前提）', () => {
    expect(recallAvailable()).toBe(true);
  });

  it('3 字与 2 字混合词召回；未来章与本章被排除', () => {
    const r = run(['梅靳', '紫竹笛', '巡船']);
    expect(r.via).toBe('fts');
    const ids = r.hits.map((h) => h.chapterId);
    expect(ids).toContain('v01c001');   // 紫竹笛+梅靳 双词高分
    expect(ids).toContain('v01c002');   // 巡船
    expect(ids).not.toContain('v01c003');
    expect(ids).not.toContain('v01c004'); // 后章即使含词也不得出现
    expect(r.text).toContain('《渡夜》');
  });

  it('noIndex 降级：同一查询扫描通道产出等价命中', () => {
    const a = run(['巡船']);
    const b = run(['巡船'], { noIndex: true });
    expect(a.via).toBe('fts'); expect(b.via).toBe('scan');
    expect(b.hits.map((h) => h.chapterId)).toEqual(a.hits.map((h) => h.chapterId));
  });

  it('预算：注入总字数不超 budgetChars 且条数封顶', () => {
    const many: ChapterFile[] = Array.from({ length: 10 }, (_, i) =>
      ch(`v01c${String(i + 1).padStart(3, '0')}`, `章${i + 1}`, '紫竹笛' + '响'.repeat(200)));
    const r = recallForChapter({ slug: '召回预算书', outline, chapterId: 'v99c999', chapters: many, terms: ['紫竹笛'], budgetChars: 500 });
    const total = r.hits.reduce((a, h) => a + h.chars, 0);
    expect(total).toBeLessThanOrEqual(500);
    expect(r.hits.length).toBeLessThanOrEqual(5);
  });

  it('增量对齐：改章后旧词不再召回、新词可召回（删行+重插生效）', () => {
    expect(run(['紫竹笛']).hits.some((h) => h.chapterId === 'v01c001')).toBe(true);
    const changed = chapters.map((c) => (c.id === 'v01c001' ? { ...c, content: '渡口无人，只余橹声。铜佛像在舱底发暗。' } : c));
    const r1 = recallForChapter({ slug: '召回测试书', outline, chapterId: 'v01c003', chapters: changed, terms: ['紫竹笛'] });
    expect(r1.hits.some((h) => h.chapterId === 'v01c001')).toBe(false);
    const r2 = recallForChapter({ slug: '召回测试书', outline, chapterId: 'v01c003', chapters: changed, terms: ['铜佛像'] });
    expect(r2.hits.some((h) => h.chapterId === 'v01c001')).toBe(true);
  });
});

describe('A3 生成链挂接', () => {
  const baseArgs = {
    outline, chapterId: 'v01c003', characters: [], worldview: '',
    summaries: { v01c001: '梅靳渡夜，怀藏紫竹笛。', v01c002: '巡船截江。' },
    foreshadows: [],
  };
  it('不传 recall 参数 = ctx 无召回字段（其余调用方逐字节旧行为）', () => {
    const ctx = buildChapterContext(baseArgs);
    expect(ctx.recall).toBeUndefined();
    expect(ctx.recallTrace).toBeUndefined();
    expect(prosePrompt(ctx).user).not.toContain('前文相关片段');
  });
  it('传 recall 参数且相关 → prompt 注入块出现', () => {
    const ctx = buildChapterContext({ ...baseArgs, recall: { slug: '召回挂接书', chapters } });
    if (!recallAvailable()) return; // 降级环境不强制断言注入
    expect(ctx.recall).toBeTruthy();
    expect(ctx.recallTrace?.hits.length).toBeGreaterThan(0);
    const user = prosePrompt(ctx).user;
    expect(user).toContain('【前文相关片段');
    expect(user).toContain('《渡夜》');
  });
});

describe('召回留痕落盘（.index/recall-activated.json）', () => {
  it('写入→读回；via 白名单、terms/hits 收敛、同章覆盖只留最近', () => {
    fs.mkdirSync(path.join(tmp, '留痕书'), { recursive: true }); // 留痕守卫只写已存在的书
    saveRecallActivated('留痕书', 'v01c003', {
      terms: 250, via: 'weird',
      hits: Array.from({ length: 12 }, (_, i) => ({ chapterId: `v01c0${i + 1}`, title: `章${i}`, chars: 100 + i })),
    });
    saveRecallActivated('留痕书', 'v01c005', { terms: 8, via: 'scan', hits: [{ chapterId: 'v01c002', title: '乙', chars: 50 }] });
    const all = loadRecallActivated('留痕书');
    expect(Object.keys(all).sort()).toEqual(['v01c003', 'v01c005']);
    expect(all.v01c003.terms).toBe(99);            // terms 封顶 99
    expect(all.v01c003.via).toBe('fts');           // 非 scan 一律归 fts
    expect(all.v01c003.hits).toHaveLength(8);      // hits 封顶 8
    expect(all.v01c005.via).toBe('scan');
    saveRecallActivated('留痕书', 'v01c005', { terms: 3, via: 'fts', hits: [] });
    expect(loadRecallActivated('留痕书').v01c005.hits).toHaveLength(0);
    expect(loadRecallActivated('未说明书')).toEqual({});
  });
});
