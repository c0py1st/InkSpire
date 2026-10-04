import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { activateLore, loreBlockText, loreKeyHit } from '../../shared/src/lore';
import type { LoreEntry, Outline } from '../../shared/src/types';
import { buildChapterContext } from './ai/memory';
import { prosePrompt } from './ai/prompts/prose';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moge-lore-'));
process.env.MOGE_DATA_DIR = tmp;
const { sanitizeLoreEntries, sanitizeStyleExemplars, saveLoreActivated, loadLoreActivated } = await import('./fs-store');

const E = (over: Partial<LoreEntry> & { id: string }): LoreEntry => ({
  title: over.title ?? over.id, keys: over.keys ?? [], content: over.content ?? '内容', ...over,
});

describe('世界书触发匹配', () => {
  it('中文子串命中；英文大小写不敏感；空触发词永不命中', () => {
    const hay = '李慎踏雪寻梅，忽然看见一枚 BRASS 纽扣'.toLowerCase();
    expect(loreKeyHit(E({ id: 'a', keys: ['踏雪'] }), hay)).toBe(true);
    expect(loreKeyHit(E({ id: 'b', keys: ['brass', '铜'] }), hay)).toBe(true);
    expect(loreKeyHit(E({ id: 'c', keys: ['  ', '不存在词'] }), hay)).toBe(false);
    expect(loreKeyHit(E({ id: 'd', keys: [] }), hay)).toBe(false);
  });
});

describe('世界书激活', () => {
  const order = ['v01c001', 'v01c002', 'v01c003', 'v02c001', 'v02c002'];
  const base = { order, chapterId: 'v01c002', corpus: '刀法 与 铃铛', budgetChars: 100, entries: [] as LoreEntry[] };

  it('章不在阅读序 → 全空', () => {
    const r = activateLore({ ...base, chapterId: 'v99c999' });
    expect(r).toEqual({ activated: [], dropped: [] });
  });

  it('命中/未命中/停用三路过滤', () => {
    const entries = [
      E({ id: 'k1', keys: ['刀法'], content: 'x'.repeat(10) }),
      E({ id: 'k2', keys: ['不存在'], content: 'y' }),
      E({ id: 'k3', keys: ['铃铛'], content: 'z', enabled: false }),
    ];
    const r = activateLore({ ...base, entries });
    expect(r.activated.map((e) => e.id)).toEqual(['k1']);
  });

  it('constant 豁免触发词但仍吃预算；contract 豁免预算', () => {
    const entries = [
      E({ id: 'c1', constant: true, content: 'a'.repeat(60) }),
      E({ id: 'c2', keys: ['刀法'], content: 'b'.repeat(60) }),
      E({ id: 'c3', keys: ['刀法'], contract: true, content: 'c'.repeat(500) }),
    ];
    const r = activateLore({ ...base, entries, budgetChars: 100 });
    expect(r.activated.map((e) => e.id)).toEqual(['c1', 'c3']); // c1 先占满预算，c2 整条出局，c3 契约豁免
    expect(r.dropped.map((e) => e.id)).toEqual(['c2']);
  });

  it('priority 降序、同值文件序（稳定）', () => {
    const entries = [
      E({ id: 'p0a', keys: ['刀法'], priority: 0 }),
      E({ id: 'hi', keys: ['刀法'], priority: 5 }),
      E({ id: 'p0b', keys: ['铃铛'], priority: 0 }),
    ];
    const r = activateLore({ ...base, entries });
    expect(r.activated.map((e) => e.id)).toEqual(['hi', 'p0a', 'p0b']);
  });

  it('scope 章区间含端点；未知边界视为该侧开放；volumeId 限卷', () => {
    const win = E({ id: 'win', keys: ['刀法'], scope: { chapterFrom: 'v01c002', chapterTo: 'v01c003' } });
    expect(activateLore({ ...base, entries: [win] }).activated).toHaveLength(1);
    expect(activateLore({ ...base, entries: [win], chapterId: 'v01c001' }).activated).toHaveLength(0);
    const onlyFrom = E({ id: 'of', keys: ['刀法'], scope: { chapterFrom: 'v01c002' } });
    expect(activateLore({ ...base, entries: [onlyFrom], chapterId: 'v02c002' }).activated).toHaveLength(1);
    const ghost = E({ id: 'gh', keys: ['刀法'], scope: { chapterFrom: '不存在的章' } });
    expect(activateLore({ ...base, entries: [ghost] }).activated).toHaveLength(1);
    const vol = E({ id: 'vol', keys: ['刀法'], scope: { volumeId: 'v02' } });
    expect(activateLore({ ...base, entries: [vol], volumeId: 'v01' }).activated).toHaveLength(0);
    expect(activateLore({ ...base, entries: [vol], volumeId: 'v02' }).activated).toHaveLength(1);
  });

  it('超预算整条丢弃不截断；注入文本格式', () => {
    const r = activateLore({
      ...base, budgetChars: 20,
      entries: [E({ id: 'big', keys: ['刀法'], content: 'z'.repeat(21) }), E({ id: 'ok', keys: ['铃铛'], content: '铃门规矩三条' })],
    });
    expect(r.activated.map((e) => e.id)).toEqual(['ok']);
    expect(r.dropped.map((e) => e.id)).toEqual(['big']);
    expect(loreBlockText(r.activated)).toBe('- 【ok】铃门规矩三条');
    expect(loreBlockText([])).toBe('');
  });
});

describe('世界书消毒（落盘/前端输入绝不信任）', () => {
  it('脏条目丢弃不丢全档；字段收敛；scope 与布尔白名单', () => {
    const clean = sanitizeLoreEntries([
      { id: ' ok ', title: 'T', keys: ['a', '  ', 1, 'b'], content: ' C ', constant: true, contract: 1, priority: 99.7, enabled: false, junk: 1 },
      { id: '', title: 'T', content: 'x' },                 // 无 id → 丢
      { id: 'b', title: '  ', content: 'x' },                // 空标题 → 丢
      { id: 'c', title: 'T', content: '  ' },                // 空内容 → 丢
      { id: 'd', title: 'T', content: 'x', scope: { chapterFrom: 'v01c001', chapterTo: '坏id', volumeId: 'v1', evil: 'e' } },
      'string', null, [],
    ]);
    expect(clean).toHaveLength(2);
    expect(clean[0]).toEqual({ id: 'ok', title: 'T', keys: ['a', 'b'], content: 'C', constant: true, priority: 100, enabled: false }); // contract:1 非 true 不收；priority 收敛取整
    expect(clean[1].scope).toEqual({ volumeId: 'v1', chapterFrom: 'v01c001' });
    expect(sanitizeLoreEntries({ nope: 1 })).toEqual([]);
    expect(sanitizeLoreEntries(null)).toEqual([]);
  });
});

describe('激活留痕缓存', () => {
  it('按章覆盖写；只留 id/标题/字数', () => {
    saveLoreActivated('测试留痕', 'v01c001', [E({ id: 'a', title: '甲', content: 'xxx' })], []);
    saveLoreActivated('测试留痕', 'v01c001', [E({ id: 'a', title: '甲', content: 'yyy' })], [E({ id: 'b', title: '乙', content: 'zz' })]);
    const all = loadLoreActivated('测试留痕');
    expect(Object.keys(all)).toEqual(['v01c001']);
    expect(all.v01c001.activated).toEqual([{ id: 'a', title: '甲', chars: 3 }]);
    expect(all.v01c001.dropped).toEqual([{ id: 'b', title: '乙', chars: 2 }]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('生成路径挂接（buildChapterContext + prosePrompt）', () => {
  const o: Outline = {
    premise: 'p', genre: 'g', coreConflict: 'c', endingVision: 'e', styleGuide: 's',
    volumes: [{
      id: 'v01', title: '卷一', summary: '弧',
      chapters: [
        { id: 'v01c001', title: '登场', beat: '主角在山门练刀法', status: 'todo' },
        { id: 'v01c002', title: '试炼', beat: '主角下山历练', status: 'todo' },
      ],
    }],
  };
  const common = {
    outline: o, chapterId: 'v01c001', characters: [], worldview: 'w', summaries: {},
  };

  it('命中章 beat 的条目 → 进 ctx.lore 与 prosePrompt 块', () => {
    const ctx = buildChapterContext({ ...common, lorebook: [E({ id: 'k', title: '刀法总纲', keys: ['刀法'], content: '以气驭刀，刀随意动' })] });
    expect(ctx.lore).toContain('刀法总纲');
    expect(ctx.loreTrace?.activated.map((e) => e.id)).toEqual(['k']);
    const prompt = prosePrompt(ctx).user;
    expect(prompt).toContain('【世界书·本章激活】');
    expect(prompt).toContain('以气驭刀，刀随意动');
  });

  it('未命中任何条 → 不出块；lorebook 与不传逐字节一致（老书零影响）', () => {
    const withLore = prosePrompt(buildChapterContext({ ...common, lorebook: [E({ id: 'x', keys: ['绝不可能出现的触发词'], content: 'zzz' })] })).user;
    const bare = prosePrompt(buildChapterContext(common)).user;
    expect(withLore).toBe(bare);
    expect(withLore).not.toContain('【世界书');
  });

  it('constant 常驻条不依赖 beat 也进 prompt', () => {
    const ctx = buildChapterContext({ ...common, chapterId: 'v01c002', lorebook: [E({ id: 'c', title: '世界铁律', keys: [], content: '此界不可有枪械', constant: true })] });
    expect(ctx.lore).toContain('此界不可有枪械');
  });
});

describe('风格范文消毒（A2a）', () => {
  it('白名单收敛：脏条丢弃、非法章 id 只丢字段、布尔与长度全部钳制', () => {
    const clean = sanitizeStyleExemplars([
      { id: ' x ', title: '《第一章》·氛围', content: ' 夜色如浸水的绒布。 ', keys: ['夜色', '', 7, '雨'.repeat(60), 'a', 'b', 'c', 'd', 'e'], sceneTag: '氛围', sourceChapterId: 'v01c001', sourceChapterTitle: '第一章', constant: true, enabled: false, at: '2026-01-01', junk: 1 },
      { id: '', title: 't', content: 'c' },                 // 无 id → 丢
      { id: 'b', title: '  ', content: 'c' },                // 空标题 → 丢
      { id: 'c', title: 't', content: ' ' },                 // 空正文 → 丢
      { id: 'd', title: 't', content: 'c', sourceChapterId: '坏id', constant: 'yes', enabled: 'no' },
      'str', null, [],
    ]);
    expect(clean).toHaveLength(2);
    expect(clean[0]).toEqual({
      id: 'x', title: '《第一章》·氛围', keys: ['夜色', '雨'.repeat(40), 'a', 'b', 'c'], content: '夜色如浸水的绒布。',
      sceneTag: '氛围', sourceChapterId: 'v01c001', sourceChapterTitle: '第一章',
      constant: true, enabled: false, at: '2026-01-01',
    });
    // d：非法章 id / 非 true 布尔 → 字段整体不收，条目本体保留
    expect(clean[1]).toEqual({ id: 'd', title: 't', keys: [], content: 'c', at: clean[1].at });
    expect(sanitizeStyleExemplars({ nope: 1 })).toEqual([]);
    expect(sanitizeStyleExemplars(null)).toEqual([]);
  });
});
