import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// 在 import fs-store 之前把数据目录指到临时区，测试不碰真实书稿
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moge-tools-'));
process.env.MOGE_DATA_DIR = tmp;

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
});
