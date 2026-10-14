/**
 * HTTP 路由级回归测试：起真实 app 树（createApp）于随机端口，用 fetch 打全链路。
 * 价值：函数层单测覆盖不到的 express 形状——host-guard、路由挂载、404 兜底、
 * 中文 slug 编码往返、跨路由数据一致性，测的就是桌面/生产跑的同一棵树。
 * 模型类路由（SSE 生成/chat）不在本文件覆盖（花钱且异步，由活体测试负责）。
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moge-http-'));
process.env.INKSPIRE_DATA_DIR = tmp;

// 抢一个空闲端口再发布：host-guard 的 Host 校验与 listen 端口必须一致
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

const PORT = await freePort();
process.env.INKSPIRE_PORT = String(PORT);
// config/app 在设好 env 之后动态加载（DATA_DIR/PORT 在 import 时捕获）
const { createApp } = await import('./app');
const base = `http://127.0.0.1:${PORT}`;
const api = (p: string) => `${base}/api${p}`;

let server: http.Server;
let raw: typeof http.request;

/** 发一条原始 Host 头的请求（fetch 不允许伪造 Host，host-guard 用例必须走 http.request） */
function rawGet(urlPath: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = raw(
      { host: '127.0.0.1', port: PORT, path: urlPath, method: 'GET', headers: { Host: host } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  server = createApp().listen(PORT, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  raw = http.request;
});

afterAll(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const J = (o: unknown) => JSON.stringify(o);

describe('host-guard（DNS rebinding 防线）', () => {
  it('本机 Host 放行，伪造外部 Host 一律 403', async () => {
    const okRes = await fetch(api('/projects'));
    expect(okRes.status).toBe(200);
    const evil = await rawGet('/api/projects', 'evil.example.com');
    expect(evil.status).toBe(403);
    expect(JSON.parse(evil.body).error).toContain('Host');
    const wrongPort = await rawGet('/api/projects', `127.0.0.1:${PORT + 1}`);
    expect(wrongPort.status).toBe(403);
  });
});

describe('书全生命周期（建→写→读→查→删）', () => {
  const slug = 'HTTP测试本甲';

  it('complete 建书', async () => {
    const res = await fetch(api('/projects/complete'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: J({
        meta: { title: slug, logline: '路由级回归用书' },
        outline: { volumes: [{ id: 'v01', title: '卷一', summary: 's', chapters: [
          { id: 'v01c001', title: '第一章', beat: 'b', status: 'draft' },
          { id: 'v01c002', title: '第二章', beat: 'b2', status: 'draft' },
        ] }] },
        characters: [{ id: 'ch1', name: '沈砚之', role: '捕快', desc: '', appearance: '', personality: '', secrets: '' }],
        worldview: '江湖',
      }),
    });
    expect(res.status).toBe(200);
    // 中文 slug 编码往返：列表里必须原样回来
    const list = await (await fetch(api('/projects'))).json();
    expect(list.map((p: { slug: string }) => p.slug)).toContain(slug);
  });

  it('bundle 装配 + 章读写往返', async () => {
    const bundle = await (await fetch(api(`/projects/${encodeURIComponent(slug)}/bundle`))).json();
    expect(bundle.outline.volumes[0].chapters).toHaveLength(2);
    const put = await fetch(api(`/projects/${encodeURIComponent(slug)}/chapter/v01c001`), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: J({ content: '# 第一章\n\n沈砚之到了临江城。临江城西门有衙役。' }),
    });
    expect(put.status).toBe(200);
    const ch = await (await fetch(api(`/projects/${encodeURIComponent(slug)}/chapter/v01c001`))).json();
    expect(ch.content).toContain('临江城西门');
  });

  it('search 命中且 404 兜底形状正确', async () => {
    const hits = await (await fetch(api(`/projects/${encodeURIComponent(slug)}/search?q=${encodeURIComponent('衙役')}`))).json();
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const nf = await fetch(api('/api-does-not-exist'));
    expect(nf.status).toBe(404);
    expect((await nf.json()).error).toContain('未知接口');
  });

  it('events 双轨账本：补记→列表可见', async () => {
    const add = await fetch(api(`/projects/${encodeURIComponent(slug)}/events`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: J({ chapterId: 'v01c001', title: '入城', detail: '沈砚之入临江城' }),
    });
    expect(add.status).toBe(200);
    const evs = await (await fetch(api(`/projects/${encodeURIComponent(slug)}/events`))).json();
    expect(evs.some((e: { title: string }) => e.title === '入城')).toBe(true);
  });

  it('name-audit 扫描路由：串改植入即检出', async () => {
    await fetch(api(`/projects/${encodeURIComponent(slug)}/chapter/v01c002`), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: J({ content: '# 第二章\n\n听说临沂城闹匪。临江城临江。临江城。' }),
    });
    const rep = await (await fetch(api(`/projects/${encodeURIComponent(slug)}/name-audit`))).json();
    expect(rep.scanned.chapters).toBe(2);
    const p = rep.pairs.find((x: { a: string; b: string }) => x.a === '临江城' && x.b === '临沂城');
    expect(p).toBeTruthy();
    expect(p.hits.length).toBeGreaterThanOrEqual(1);
  });

  it('settings 形状：providers/mockMode 在线', async () => {
    const cfg = await (await fetch(api('/settings'))).json();
    expect(Array.isArray(cfg.providers)).toBe(true);
    expect(typeof cfg.mockMode).toBe('boolean');
  });

  it('删书后全路由 404 一致，附属写不复活幽灵目录', async () => {
    const del = await fetch(api(`/projects/${encodeURIComponent(slug)}`), { method: 'DELETE' });
    expect(del.status).toBe(200);
    const g = await fetch(api(`/projects/${encodeURIComponent(slug)}/bundle`));
    expect(g.status).toBe(404);
    // 幽灵守卫：对不存在书的迟到附属写不得把目录带回来
    const lateWrite = await fetch(api(`/projects/${encodeURIComponent(slug)}/chapter/v01c001`), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: J({ content: 'x' }),
    });
    expect(lateWrite.status).toBeGreaterThanOrEqual(400);
    expect(lateWrite.status).toBeLessThan(500);
    expect(fs.existsSync(path.join(tmp, slug))).toBe(false);
    const list = await (await fetch(api('/projects'))).json();
    expect(list.some((p: { slug: string }) => p.slug === slug)).toBe(false);
  });
});

describe('静态与错误面', () => {
  it('非法 JSON body → 统一 4xx 且服务存活', async () => {
    const bad = await fetch(api('/projects/complete'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops',
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
    const alive = await fetch(api('/projects'));
    expect(alive.status).toBe(200);
  });
});
