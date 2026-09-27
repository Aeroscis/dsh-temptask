/**
 * dsh-temptask — `prepare` 钩子。
 *
 * pnpm 在 `file:` / git 形式的依赖上会跑 prepare；registry tarball 不会。
 * 插件包自带 `lib/` 与 `client/` 构建产物，所以**没有 typescript 的机器上装包也必须成功**：
 * 本脚本在拿不到 tsc 时只提示并已 0 退出，绝不阻断安装。
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function tscBin() {
  try {
    const pkg = require.resolve('typescript/package.json', { paths: [root] });
    return join(dirname(pkg), 'bin', 'tsc');
  } catch {
    return undefined;
  }
}

const bin = tscBin();
if (bin === undefined) {
  console.log('[dsh-temptask] prepare: 未安装 typescript，跳过构建（仓库已自带 lib/ 与 client/，可直接安装运行）。');
  process.exit(0);
}

for (const args of [['-p', 'tsconfig.json'], ['-p', 'tsconfig.client.json']]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const wrap = spawnSync(process.execPath, [join(root, 'scripts', 'build-client.mjs')], { cwd: root, stdio: 'inherit' });
process.exit(wrap.status ?? 1);
