/**
 * 桌面打包资源组装：
 *  1) esbuild 把服务端（TS，含 shared 工作区）bundle 成单文件 resources/server.mjs（ESM）
 *  2) 复制构建机 node.exe → resources/node.exe（运行时随行，用户机器零依赖）
 *  3) 复制前端产物 web/dist → resources/web-dist（由 server.mjs 统一托管，窗口打开即同源）
 * 重复执行覆盖旧产物；产物目录全部进 .gitignore（一切皆可从源码重建）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));           // desktop/scripts
const DESKTOP = path.join(HERE, '..');                               // desktop
const ROOT = path.join(DESKTOP, '..');                               // 仓库根
const RES = path.join(DESKTOP, 'src-tauri', 'resources');

fs.rmSync(RES, { recursive: true, force: true });
fs.mkdirSync(RES, { recursive: true });

// 1) 服务端单文件 bundle
const r = await build({
  entryPoints: [path.join(ROOT, 'server', 'src', 'index.ts')],
  outfile: path.join(RES, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  logLevel: 'warning',
  // express 全家是 CJS，内部动态 require('path') 等打进 ESM 后会撞
  // "Dynamic require is not supported"——标准解法：banner 注入 createRequire
  banner: { js: "import{createRequire as __mogeCR}from'node:module';const require=__mogeCR(import.meta.url);" },
});
if (r.errors.length) process.exit(1);
console.log('server.mjs ✓', (fs.statSync(path.join(RES, 'server.mjs')).size / 1024).toFixed(0), 'KB');

// 2) node.exe 随行（用当前跑脚本的 node；版本记录进 version.txt 便于排障）
fs.copyFileSync(process.execPath, path.join(RES, 'node.exe'));
fs.writeFileSync(path.join(RES, 'node-version.txt'), process.version);
console.log('node.exe ✓', process.version, (fs.statSync(path.join(RES, 'node.exe')).size / 1024 / 1024).toFixed(0), 'MB');

// 3) 前端产物
const WEB_DIST = path.join(ROOT, 'web', 'dist');
if (!fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
  console.error('缺少 web/dist —— 先执行 npm run build（web）');
  process.exit(1);
}
fs.cpSync(WEB_DIST, path.join(RES, 'web-dist'), { recursive: true });
console.log('web-dist ✓');
