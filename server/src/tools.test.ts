import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// 在 import fs-store 之前把数据目录指到临时区，测试不碰真实书稿
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moge-tools-'));
process.env.INKSPIRE_DATA_DIR = tmp;

const { executeTool, TOOL_POLICIES, TOOL_SPECS } = await import('./ai/tools');
const { loadForeshadows } = await import('./fs-store');

const SLUG = 'tooltest';
const call = (name: string, args: unknown, id = 'c1') => ({
  id, type: 'function' as const, function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});

beforeAll(() => {
  const dir = path.join(tmp, SLUG);
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ slug: SLUG, title: 'T', logline: '', createdAt: '', updatedAt: '' }));
  fs.writeFileSync(path.join(dir, 'outline.json'), JSON.stringify({
    premise: 'p', genre: 'g', coreConflict: 'c', endingVision: 'e', styleGuide: 's',
    volumes: [{ id: 'v01', title: '卷一', summary: '', chapters: [
      { id: 'v01c001', title: '第一章', beat: 'b1', status: 'draft' },
      { id: 'v01c002', title: '第二章', beat: 'b2', status: 'todo' },
    ] }],
  }));
  fs.writeFileSync(path.join(dir, 'chapters/v01c001.md'), '---\ntitle: 第一章\nstatus: draft\n---\n　　甲刀埋进了雪里，乙线浮出水面。');
  fs.writeFileSync(path.join(dir, 'chapters/v01c002.md'), '---\ntitle: 第二章\nstatus: todo\n---\n');
  fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify([
    { id: 'e1', chapterId: 'v01c001', title: '盐仓失火', actors: ['李慎', '周主簿'], whenInStory: '雪夜', source: 'auto', at: '' },
    { id: 'e2', chapterId: 'v01c002', title: '获得提刑司勘合', actors: ['李慎'], source: 'manual', at: '' },
  ]));
  fs.writeFileSync(path.join(dir, 'lorebook.json'), JSON.stringify([
    { id: 'l1', title: '铃医门规', keys: ['铃医', '铜铃'], content: '佩铜铃者夜行市集可免勘合' },
    { id: 'l2', title: '盐仓案余波', keys: ['盐仓'], content: '盐仓封栈查办', priority: 3 },
    { id: 'l3', title: '勘合制度', keys: ['勘合', '过所'], content: '行走千里皆需勘合', constant: true },
    { id: 'l4', title: '南派背景', keys: ['铃铛'], content: '南派自第二章起浮现', scope: { chapterFrom: 'v01c002' } },
    { id: 'l5', title: '停尸房规矩', keys: ['停尸房'], content: '夜入停尸房须二人同值', enabled: false },
  ]));
});

describe('工具注册表', () => {
  it('每个 schema 工具都有策略，且只有 execute/propose 两级', () => {
    for (const spec of TOOL_SPECS) {
      const p = TOOL_POLICIES[spec.function.name];
      expect(p === 'execute' || p === 'propose').toBe(true);
    }
  });

  it('正文与摘要写操作必须是 propose（不可直接落盘）', () => {
    expect(TOOL_POLICIES.propose_chapter_content).toBe('propose');
    expect(TOOL_POLICIES.propose_summary).toBe('propose');
  });
});

describe('executeTool 校验与行为', () => {
  it('坏 JSON 参数 → 拒绝', () => {
    const r = executeTool(SLUG, call('search_chapters', '{坏'));
    expect(r.ok).toBe(false);
    expect(r.content).toContain('error');
  });

  it('未知工具 → 拒绝', () => {
    expect(executeTool(SLUG, call('drop_table', {})).ok).toBe(false);
  });

  it('search 空查询 → 拒绝；正常查询命中带上下文', () => {
    expect(executeTool(SLUG, call('search_chapters', { query: '  ' })).ok).toBe(false);
    const r = executeTool(SLUG, call('search_chapters', { query: '甲刀' }));
    expect(r.ok).toBe(true);
    expect(r.content).toContain('第一章');
    expect(r.detail).toContain('1 处');
  });

  it('非法/未知 chapterId → 拒绝', () => {
    expect(executeTool(SLUG, call('read_chapter', { chapterId: 'v99c999' })).ok).toBe(false);
    expect(executeTool(SLUG, call('read_chapter', { chapterId: 'not-id' })).ok).toBe(false);
  });

  it('register_foreshadow 真实落盘且去重', () => {
    const r = executeTool(SLUG, call('register_foreshadow', { setupChapterId: 'v01c001', content: '甲刀来历', payoffChapterId: 'v01c002' }));
    expect(r.ok).toBe(true);
    expect(loadForeshadows(SLUG)).toHaveLength(1);
    const again = executeTool(SLUG, call('register_foreshadow', { setupChapterId: 'v01c001', content: '甲刀来历' }));
    expect(again.detail).toContain('跳过');
    expect(loadForeshadows(SLUG)).toHaveLength(1);
  });

  it('propose_chapter_content 返回提案且绝不改章节文件', () => {
    const before = fs.readFileSync(path.join(tmp, SLUG, 'chapters/v01c001.md'), 'utf8');
    const r = executeTool(SLUG, call('propose_chapter_content', { chapterId: 'v01c001', content: '全新正文' }));
    expect(r.proposal).toEqual({ kind: 'chapter', chapterId: 'v01c001', content: '全新正文' });
    expect(fs.readFileSync(path.join(tmp, SLUG, 'chapters/v01c001.md'), 'utf8')).toBe(before);
  });

  it('工具结果超长统一截断', () => {
    const r = executeTool(SLUG, call('read_chapter', { chapterId: 'v01c001' }));
    expect(r.content.length).toBeLessThanOrEqual(4100);
  });

  it('read_character_card 输出含状态时间线（按章排序），供"第X章时什么状态"作答', () => {
    fs.mkdirSync(path.join(tmp, SLUG, 'bible'), { recursive: true });
    fs.writeFileSync(path.join(tmp, SLUG, 'bible', 'characters.json'), JSON.stringify([
      { id: 'x', name: '李慎', role: '主角', personality: 'p', background: 'b', relations: 'r', state: '现值：断臂',
        stateHistory: [
          { chapterId: 'v01c002', chapterTitle: '第二章', state: '右手划伤', reason: '验尸留下新伤', at: '' },
          { chapterId: 'v01c001', chapterTitle: '第一章', state: '健康', at: '' },
        ] },
    ]));
    const r = executeTool(SLUG, call('read_character_card', { name: '李慎' }));
    expect(r.ok).toBe(true);
    expect(r.content).toContain('状态时间线');
    expect(r.content).toContain('右手划伤');
    expect(r.content).toContain('验尸留下新伤');
    // 时间线按章排序：第一章应排在第二章前
    expect(r.content.indexOf('第一章')).toBeLessThan(r.content.indexOf('第二章'));
    expect(r.detail).toContain('2 节点');
  });

  it('read_timeline：全账/actor 过滤/uptoChapter 截断/非法章号拒绝', () => {
    const all = executeTool(SLUG, call('read_timeline', {}));
    expect(all.ok).toBe(true);
    expect(all.content).toContain('盐仓失火');
    expect(all.content).toContain('获得提刑司勘合');
    expect(all.detail).toContain('2/2');

    const byActor = executeTool(SLUG, call('read_timeline', { actor: '周主簿' }));
    expect(byActor.content).toContain('盐仓失火');
    expect(byActor.content).not.toContain('获得提刑司勘合');
    expect(byActor.content).toContain('雪夜'); // 时刻提示带出
    expect(byActor.detail).toContain('1/2');

    const upto = executeTool(SLUG, call('read_timeline', { uptoChapter: 'v01c001' }));
    expect(upto.content).toContain('盐仓失火');
    expect(upto.content).not.toContain('获得提刑司勘合');

    expect(executeTool(SLUG, call('read_timeline', { uptoChapter: '乱码' })).ok).toBe(false);
  });
});

describe('read_lorebook', () => {
  it('keyword 过滤（命中条名/触发词/正文）；detail 计数', () => {
    const r = executeTool(SLUG, call('read_lorebook', { keyword: '铜铃' }));
    expect(r.ok).toBe(true);
    expect(r.content).toContain('铃医门规');
    expect(r.content).not.toContain('勘合制度');
    expect(r.detail).toContain('1/5');
  });

  it('constant 条即使无 keyword 也列出，标注常驻', () => {
    const r = executeTool(SLUG, call('read_lorebook', {}));
    expect(r.content).toContain('勘合制度');
    expect(r.content).toContain('常驻');
  });

  it('停用条保留但标注「已停用」', () => {
    const r = executeTool(SLUG, call('read_lorebook', { keyword: '停尸房' }));
    expect(r.content).toContain('已停用');
  });

  it('chapterId 按 scope 过滤：c001 看不到 v01c002 起的条', () => {
    const c1 = executeTool(SLUG, call('read_lorebook', { chapterId: 'v01c001' }));
    expect(c1.content).not.toContain('南派背景');
    const c2 = executeTool(SLUG, call('read_lorebook', { chapterId: 'v01c002' }));
    expect(c2.content).toContain('南派背景');
  });

  it('非法 chapterId 拒绝', () => {
    expect(executeTool(SLUG, call('read_lorebook', { chapterId: '乱码章' })).ok).toBe(false);
  });
});
