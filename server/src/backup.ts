import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { DATA_DIR } from './config';

/**
 * 整本备份：把 data/<slug>/ 目录树打包成 tar.gz（纯 Node 实现，零依赖）。
 * 备份含 .backups 历史版本；.config.json 位于 DATA_DIR 根本不在打包范围内，密钥天然不外泄。
 */

const BLOCK = 512;

function octField(n: number, digits: number): string {
  return n.toString(8).padStart(digits - 1, '0') + '\0';
}

function tarHeader(name: string, size: number, mtime: number, dir: boolean): Buffer {
  // 中文书名可能让路径超 100 字节：拆进 USTAR prefix 字段（按 '/' 边界切）
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const parts = name.split('/');
    let rest = parts.pop()!;
    while (parts.length && Buffer.byteLength(`${rest}/${parts[parts.length - 1]}`) <= 99) {
      rest = `${parts.pop()}/${rest}`;
    }
    name = rest;
    prefix = parts.join('/');
  }
  const h = Buffer.alloc(BLOCK, 0); // 头部整体 NUL 填充（GNU tar 的写法）：
  // 字符串字段以 NUL 终止，未使用的 prefix/uname 区保持全 0；
  // 若用空格填充，GNU tar 会把未 NUL 终止的空格区当成路径前缀解出来
  h.write(name, 0, 'utf8');
  h.write(octField(dir ? 0o755 : 0o644, 8), 100, 8);
  h.write(octField(0, 8), 108, 8); // uid
  h.write(octField(0, 8), 116, 8); // gid
  h.write(octField(dir ? 0 : size, 12), 124, 12);
  h.write(octField(Math.floor(mtime / 1000), 12), 136, 12);
  h.write('        ', 148, 8); // checksum 占位（8 空格）
  h.write(dir ? '5' : '0', 156, 1);
  h.write('ustar\0', 257, 6);
  h.write('00', 263, 2);
  if (prefix) h.write(prefix, 345, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

function tarPackDir(root: string, prefix: string, out: Buffer[]): void {
  const entries = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = path.join(root, e.name);
    const rel = `${prefix}/${e.name}`;
    const st = fs.statSync(full);
    if (e.isDirectory()) {
      out.push(tarHeader(rel, 0, st.mtimeMs, true));
      tarPackDir(full, rel, out);
    } else if (e.isFile()) {
      const data = fs.readFileSync(full);
      out.push(tarHeader(rel, data.length, st.mtimeMs, false));
      out.push(data);
      const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
      if (pad) out.push(Buffer.alloc(pad));
    }
  }
}

/** 生成整本备份 tar.gz；目录不存在抛错。dataDir 参数仅为测试注入，缺省用全局 DATA_DIR */
export function buildBookArchive(slug: string, dataDir: string = DATA_DIR): { buffer: Buffer; filename: string } {
  const dir = path.join(dataDir, slug);
  if (!fs.existsSync(dir) || !fs.existsSync(path.join(dir, 'meta.json'))) throw new Error('项目不存在');
  const out: Buffer[] = [];
  out.push(tarHeader(slug, 0, Date.now(), true));
  tarPackDir(dir, slug, out);
  out.push(Buffer.alloc(BLOCK * 2)); // 结束双零块
  const tar = Buffer.concat(out);
  const day = new Date().toISOString().slice(0, 10);
  return { buffer: gzipSync(tar), filename: `${slug}-${day}.tar.gz` };
}
