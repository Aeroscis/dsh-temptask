/**
 * dsh-temptask — 发布形态自检（`npm run check:pack`，也挂在 `prepack` 上）。
 *
 * 为什么需要它：`npm pack` 只按 package.json 的 `files` 白名单取文件——
 * 少写一条，装到你插件的人就会遇到"包能装上但运行时报模块找不到"，
 * 而这类错误在源码目录里跑 `npm run check` 是**发现不了**的（源码目录里什么都在）。
 *
 * 所以这里做两件事，都不依赖网络、也不启动子进程（沙箱里管道 stdio 会失败）：
 *   1. 运行时入口与 `files` 覆盖：入口文件存在、且被 `files` 覆盖；
 *   2. 你要发布出去的东西必须真的在清单里（含 `src/` 与 `scripts/`，否则别人无法复核/重建）。
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

/** 某个相对路径是否被 `files` 里的某一条覆盖（条目是文件/目录名，也可以是 glob 的裸目录）。 */
function covered(relPath) {
  const entries = Array.isArray(pkg.files) ? pkg.files : [];
  return entries.some((entry) => {
    const clean = String(entry).replace(/^\.\//u, '').replace(/\/+$/u, '');
    return relPath === clean || relPath.startsWith(`${clean}/`);
  });
}

check('package.json 声明了 files 白名单', () => {
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'files 必须存在且非空');
});

check('运行时入口存在，且都被 files 覆盖', () => {
  const entries = [
    pkg.main, // lib/index.js
    pkg.exports?.['./client'], // client/client.js
    pkg.dsh?.bundle?.patch, // cordis.patch.yml
    pkg.exports?.['./cordis.patch.yml'],
  ].filter((value) => typeof value === 'string');

  assert.ok(entries.length >= 3, `入口声明不完整：${JSON.stringify(pkg.exports)}`);
  for (const entry of entries) {
    const rel = entry.replace(/^\.\//u, '');
    assert.ok(existsSync(join(root, rel)), `入口文件不存在：${rel}`);
    assert.ok(covered(rel), `入口未被 files 覆盖，装包后会缺失：${rel}`);
  }
});

check('lib/ 下每个编译产物都在 files 覆盖范围内', () => {
  const dir = join(root, 'lib');
  assert.ok(existsSync(dir), 'lib/ 不存在，请先 npm run build');
  const files = readdirSync(dir).filter((name) => name.endsWith('.js'));
  assert.ok(files.length > 0, 'lib/ 里没有编译产物');
  for (const name of files) {
    assert.ok(covered(`lib/${name}`), `lib/${name} 未被 files 覆盖`);
  }
});

check('发布物包含源码与构建脚本（别人要能复核、能重建）', () => {
  for (const required of ['src', 'scripts', 'tsconfig.json', 'tsconfig.client.json']) {
    assert.ok(
      (Array.isArray(pkg.files) ? pkg.files : []).includes(required),
      `files 缺少 ${required}：装包者将看不到${required === 'src' ? '源码' : '构建脚本'}，也无法复核`,
    );
    assert.ok(existsSync(join(root, required)), `${required} 在磁盘上不存在`);
  }
});

check('插件清单（dsh 字段）完整：bundle patch + client platform', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh?.client?.platform, 'web');
  assert.deepEqual(pkg.dsh?.client?.inject, ['@deepseek-ai/dsh-client-ui-primitives']);
});

check('cordis.patch.yml 真的插入本插件行', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.includes('insert:'), 'patch 里没有 insert 段');
  assert.ok(patch.includes(`name: '${pkg.name}'`) || patch.includes(`name: "${pkg.name}"`), patch);
});

console.log(`\n✅ 发布形态自检 ${passed} 项通过`);
