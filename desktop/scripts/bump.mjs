/**
 * 发版版本号同步器：node desktop/scripts/bump.mjs 0.2.0
 * 一处敲版本，写齐四个真相源（Cargo.lock 由 cargo build 自行更新，不手改）：
 *   根 package.json / desktop/package.json / tauri.conf.json / Cargo.toml
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..');
const ROOT = path.join(DESKTOP, '..');

const v = process.argv[2] ?? '';
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v)) {
  console.error('用法：node desktop/scripts/bump.mjs <x.y.z>   例：bump.mjs 0.2.0');
  process.exit(1);
}

const writeJson = (file, mutate) => {
  const o = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(o);
  fs.writeFileSync(file, JSON.stringify(o, null, 2) + '\n', 'utf8');
  console.log('✓', path.relative(ROOT, file));
};

writeJson(path.join(ROOT, 'package.json'), (o) => { o.version = v; });
writeJson(path.join(DESKTOP, 'package.json'), (o) => { o.version = v; });
writeJson(path.join(DESKTOP, 'src-tauri', 'tauri.conf.json'), (o) => { o.version = v; });

const cargoFile = path.join(DESKTOP, 'src-tauri', 'Cargo.toml');
const cargo = fs.readFileSync(cargoFile, 'utf8').replace(/^version = ".*"$/m, `version = "${v}"`);
if (!cargo.includes(`version = "${v}"`)) { console.error('Cargo.toml 版本行未匹配，检查格式'); process.exit(1); }
fs.writeFileSync(cargoFile, cargo, 'utf8');
console.log('✓ desktop/src-tauri/Cargo.toml');

console.log(`\nv${v} 已写齐。后续：\n  npm run desktop:build   # Cargo.lock 随构建自动更新\n  git add -A && git commit -m "chore(release): v${v}" && git tag v${v}\n  git push && git push origin v${v}   # 推送需作者口令\n  gh release create v${v} desktop/src-tauri/target/release/bundle/nsis/墨阁_${v}_x64-setup.exe -n "墨阁 v${v}"`);
