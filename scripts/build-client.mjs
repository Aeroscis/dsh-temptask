/**
 * dsh-temptask — client bundle builder.
 *
 * `tsc -p tsconfig.client.json` 把 `src/client.tsx` 编译成标准 ESM
 * （`build/client/client.js`），但 DSH 浏览器端加载的是 **ModuleLoader 包**：
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 *
 * 本脚本做且只做这一层确定性包装（与 dshmarket 的 normalize-client-banner 同类）：
 *   1. 把源码里的版本占位符 `__DSH_PLUGIN_VERSION__` 换成 package.json 的 version
 *      （客户端半边读不到 package.json，只能在构建期定版；找不到占位符即失败）；
 *   2. 删掉 `import React from "react"`，改为工厂内 `require("react")`（react 是平台
 *      静态 seed 模块，见 dsh-client-modules 的 resolution branch order）；
 *   3. 把 `export default X` 变成 `var __plugin = X`，工厂末尾 `module.exports = __plugin`；
 *   4. 包上 ModuleLoader 头。
 *
 * **`id` 必须等于 package.json 的 `name`**（不是目录名、也不是短名）。宿主
 * `dsh-client-modules` 用加载器条目名（= 包名）当图行 id，`arrive()` 装载完 combo
 * 脚本后按这个 id 查 `factories`；对不上就整批报
 * `bundle … loaded without registering "<pkg>" via __ModuleLoader__.load`
 * （连带同一批的其它插件一起失败）。所以这里从 package.json 现读，绝不写字面量。
 *
 * 任何残留的 `import` / `export` 都会让构建**大声失败**，而不是产出一个加载不起来的包。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const compiledFile = join(root, 'build', 'client', 'client.js');
const outFile = join(root, 'client', 'client.js');

// 注册 id 的唯一真相来源：包名。宿主就是按包名找工厂的（见文件头说明）。
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const PLUGIN_ID = packageJson.name;
if (typeof PLUGIN_ID !== 'string' || PLUGIN_ID.length === 0) {
  throw new Error('build-client: package.json 里没有可用的 name，无法确定 ModuleLoader 注册 id');
}

// 客户端半边的版本同样只有一个真相来源：package.json 的 version。
// 浏览器里读不到 package.json，所以只能在构建期注入——0.4.0 就是手写字面量漂掉的
// （host 报 0.4.0、界面报 0.3.3），这里替换源码里的占位符来根治。
const VERSION_PLACEHOLDER = '__DSH_PLUGIN_VERSION__';
const PLUGIN_VERSION = packageJson.version;
if (typeof PLUGIN_VERSION !== 'string' || PLUGIN_VERSION.length === 0) {
  throw new Error('build-client: package.json 里没有可用的 version，无法给客户端半边定版');
}

/** 把每一行都缩进一层（工厂体内）。 */
function indent(text, pad) {
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? line : pad + line))
    .join('\n');
}

const source = await readFile(compiledFile, 'utf8');

let body = source;

// 1) 版本占位符 → package.json 的 version（客户端半边的定版点）。
if (!body.includes(VERSION_PLACEHOLDER)) {
  throw new Error(
    `build-client: ${compiledFile} 里没有找到 ${VERSION_PLACEHOLDER}（src/client.tsx 的 CLIENT_VERSION），构建契约已变化`,
  );
}
body = body.replaceAll(VERSION_PLACEHOLDER, PLUGIN_VERSION);

// 2) react 由 ModuleLoader 工厂注入，不使用 ESM 导入。
const reactImport = /^\s*import\s+React\s*(?:,\s*\{[^}]*\})?\s*from\s*["']react["'];?\s*$/mu;
if (!reactImport.test(body)) {
  throw new Error(`build-client: ${compiledFile} 中没有找到预期的 \`import React from "react"\`，构建契约已变化`);
}
body = body.replace(reactImport, '');

// 3) 默认导出 → 局部变量。
if (!/^\s*export default\s/mu.test(body)) {
  throw new Error(`build-client: ${compiledFile} 中没有找到 \`export default\`，构建契约已变化`);
}
body = body.replace(/^\s*export default\s/mu, 'var __plugin = ');

// 4) 允许 tsc 生成的空 `export {};` 之类，其余 import/export 一律失败。
body = body.replace(/^\s*export\s*\{\s*\};?\s*$/mu, '');
const leftover = body
  .split('\n')
  .map((line, index) => ({ line: line.trim(), index: index + 1 }))
  .filter(({ line }) => /^import\s|^export\s|^import\(/u.test(line));
if (leftover.length > 0) {
  throw new Error(
    `build-client: 编译产物中仍有未处理的 ESM 语句（ModuleLoader 只接受 CJS 风格工厂）：\n` +
      leftover.map(({ line, index }) => `  ${compiledFile}:${index}: ${line}`).join('\n'),
  );
}

body = body.replace(/\n{3,}/gu, '\n\n').trim();

/** 注册头：单独一段，既写进产物，也被下面的自检按字面量核对。 */
const banner = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(PLUGIN_ID)},
  factory: (require) => {`;

const bundle = `/**
 * dsh-temptask — client half（构建产物，请勿直接编辑）。
 *
 * 源文件：src/client.tsx；构建：pnpm build:client
 * （tsc → build/client/client.js → 本脚本包装成 ModuleLoader 包）。
 *
 * 运行在 DSH Web 页面里，通过 ctx.slots / ctx.locale / ctx.sessions / ctx.layout
 * 与宿主通信，通过 fetch("/dsh-temptask/api/*") 与 host half 通信。
 */
${banner}
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");

${indent(body, '    ')}

    module.exports = __plugin;
    return module.exports;
  },
});
`;

// 自检：产出的包必须真的以包名注册——宿主按包名查工厂，写错了就是整批插件加载失败。
if (!bundle.includes(banner)) {
  throw new Error(
    `build-client: 产出的包没有以 id: ${JSON.stringify(PLUGIN_ID)} 注册（宿主会报 loaded without registering）`,
  );
}

// 自检 2：版本必须真的注入进去了——产物里还留着占位符、或找不到本次版本号，
// 都说明客户端半边没有跟上 package.json（0.4.0 的"两半版本不一致"就是这么来的）。
if (bundle.includes(VERSION_PLACEHOLDER)) {
  throw new Error(`build-client: 产物里仍残留 ${VERSION_PLACEHOLDER}，版本注入没有生效`);
}
if (!bundle.includes(`'${PLUGIN_VERSION}'`) && !bundle.includes(`"${PLUGIN_VERSION}"`)) {
  throw new Error(
    `build-client: 产物里找不到 package.json 的版本 ${PLUGIN_VERSION}，客户端半边会与 host 报的版本对不上`,
  );
}

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, bundle, 'utf8');
console.log(
  `build-client: wrote ${outFile} (${bundle.length} bytes, id=${PLUGIN_ID}, version=${PLUGIN_VERSION})`,
);
