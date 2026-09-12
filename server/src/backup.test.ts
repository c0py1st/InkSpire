import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildBookArchive } from './backup';

describe('buildBookArchive', () => {
  it('打包整个书目录（含中文长路径）且内容完整', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moge-backup-'));
    try {
      const slug = '测试书籍-卷一与卷二很长的中文书名';
      const dir = path.join(root, slug);
      fs.mkdirSync(path.join(dir, 'chapters/.backups/v01c001'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'bible'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ slug, title: '测试' }));
      fs.writeFileSync(path.join(dir, 'bible/characters.json'), '[]');
      fs.writeFileSync(path.join(dir, 'chapters/v01c001.md'), '---\ntitle: 一章\n---\n正文一二三');
      fs.writeFileSync(path.join(dir, 'chapters/.backups/v01c001/2026-01-01T00-00-00-000Z.md'), 'old');

      const { buffer, filename } = buildBookArchive(slug, root);
      expect(filename).toBe(`${slug}-${new Date().toISOString().slice(0, 10)}.tar.gz`);

      const tar = gunzipSync(buffer);
      const text = new TextDecoder().decode(tar);
      // 所有文件都在包内（路径含中文且超 100 字节，考验 USTAR prefix 拆分）
      expect(text).toContain(`${slug}/meta.json`);
      expect(text).toContain('characters.json');
      expect(text).toContain('v01c001.md');
      expect(text).toContain('.backups');
      expect(text).toContain('正文一二三');
      // tar 块对齐：512 的整数倍
      expect(tar.length % 512).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('项目不存在时抛错', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moge-backup-'));
    try {
      expect(() => buildBookArchive('nope', root)).toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
