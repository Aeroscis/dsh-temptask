/**
 * dsh-temptask — 用**宿主真实的** dsh-client-modules 验证注册契约。
 *
 * 为什么需要它：`smoke-client.mjs` 里的 `__ModuleLoader__` 只是记下 registration 的桩，
 * 而真正挑剔的判据在宿主里（`ClientModuleSystem.arrive()`）：
 *
 *   const id = stripClientSuffix(row.id);     // row.id 是加载器条目名，也就是包名
 *   await loadBundle(row.initialUrl);
 *   if (!this.factories.has(id)) throw new Error(`bundle ${url} loaded without registering "${id}" …`);
 *
 * 也就是说「注册 id 必须等于包名」这条契约，只有拿宿主的代码真跑一遍才算验过：
 * 0.3.1 的产物（注册 id = 短名 dsh-temptask）会在这里**原样复现**界面上那条报错。
 *
 * 本脚本做三件事：
 *   1. 用假 boot 图（只含本插件一行）做一次真的 `arrive()`；
 *   2. 断言短名查不到工厂（0.3.1 的失败态），包名查得到（修复后的状态）；
 *   3. 用宿主的 require 解析 `<包名>`，断言拿到 `{ inject, apply }`。
 *
 * 运行：npm run check:registration。
 *   - 找不到宿主包时打印原因并以 0 退出（没有 DSH 的机器上 `npm run check` 不该因此失败）；
 *   - `DSH_TEMPTASK_PACKAGE=<路径>` 可以改成校验**另一份已安装副本**（例如 profile 里的那份），
 *     装完插件后验一下"装进去的到底是哪一版"很有用。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = process.env.DSH_TEMPTASK_PACKAGE ?? repoRoot;
const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const PACKAGE_NAME = packageJson.name;
const BOOTSTRAP_ID = '@deepseek-ai/dsh-client-modules';
const bundleUrl = `/plugins/?v=1,${PACKAGE_NAME}/client.js&rev=check-registration`;
const bundleSource = await readFile(join(packageRoot, 'client', 'client.js'), 'utf8');

if (packageRoot !== repoRoot) {
  console.log(`校验对象：${packageRoot}\n  ${PACKAGE_NAME}@${packageJson.version}\n`);
}

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

/** 宿主 dsh-client-modules 的位置（按宿主版本换过地方）。 */
const CANDIDATES = [
  // 显式指定：可以是 <安装了 @deepseek-ai/* 的根>，也可以是桌面应用解包出来的 dsh 运行时目录。
  process.env.DSH_APP_ROOT === undefined
    ? undefined
    : join(process.env.DSH_APP_ROOT, 'node_modules', '@deepseek-ai', 'dsh-client-modules'),
  // 0.1.x 的三方桌面版：app 目录直接摊在 resources\app 下。
  'C:\\Program Files\\DSH Desktop\\resources\\app\\node_modules\\@deepseek-ai\\dsh-client-modules',
  // 本包自己的依赖（把 @deepseek-ai/dsh-client-modules 装成 devDependency 时命中）。
  '@deepseek-ai/dsh-client-modules',
];
/**
 * 注意：官方 DeepSeek Harness 桌面版 0.2.x 起把 dsh 运行时**打包进了 app.asar**，
 * 普通 Node 读不到 asar 里的文件，因此这台机器上要用
 * `DSH_APP_ROOT=<解包出来的 dsh 目录>` 才能校验新宿主的实现；
 * 没给就自动跳过（打印原因并以 0 退出），不会让 `npm run check` 失败。
 */
const require = createRequire(import.meta.url);

let hostUrl;
for (const candidate of CANDIDATES) {
  if (candidate === undefined) continue;
  try {
    const manifestPath = candidate.startsWith('@')
      ? require.resolve(`${candidate}/package.json`)
      : join(candidate, 'package.json');
    const pkg = JSON.parse(await readFile(manifestPath, 'utf8'));
    hostUrl = pathToFileURL(join(dirname(manifestPath), pkg.exports['./client'].default)).href;
    console.log(`宿主 dsh-client-modules@${pkg.version}\n  ${manifestPath}\n`);
    break;
  } catch {
    /* 换下一个候选 */
  }
}

if (hostUrl === undefined) {
  console.log('跳过：本机找不到 @deepseek-ai/dsh-client-modules（这条契约校验需要 DSH 桌面应用）。');
  process.exit(0);
}

/*
 * HTML 先内联装好这个 queue 门面（`bootInjections` 的 `create()`），再由宿主脚本注册自己。
 * 这里逐字复刻它的契约，好让后面的加载路径与浏览器完全一致。
 */
const pendingQueue = [];
globalThis.window = {
  __ModuleLoader__: {
    mode: 'queue',
    pendingQueue,
    load(registration) {
      pendingQueue.push(registration);
    },
    create(bootstrapModule, options) {
      if (this.mode !== 'queue') throw new Error('client-modules: create called after module-system boot');
      const index = pendingQueue.findIndex((entry) => entry.id === BOOTSTRAP_ID);
      const registration = pendingQueue[index];
      if (registration === undefined) throw new Error(`HTML did not preload ${BOOTSTRAP_ID}/client.js`);
      pendingQueue.splice(index, 1);
      const exports = registration.factory((spec) => {
        throw new Error(`${BOOTSTRAP_ID}/client.js requested external "${spec}" before the module system existed`);
      });
      // 注意：mode 仍留在 "queue"，由 createClientModuleSystem 自己把它切成 live
      // （就是宿主 queue 脚本的顺序，先切会撞 "called after module-system boot"）。
      const created = exports.createClientModuleSystem(this, bootstrapModule, options);
      this.load = (entry) => created.register(entry);
      return created;
    },
  },
};

/* 宿主自己的 client.js 也是一段 ModuleLoader 脚本（第一行就碰 window.__ModuleLoader__），按同样方式执行。 */
const hostSource = await readFile(fileURLToPath(hostUrl), 'utf8');
vm.runInThisContext(hostSource, { filename: 'dsh-client-modules/client.js' });

const loader = globalThis.window.__ModuleLoader__;
assert.ok(typeof loader?.load === 'function' && Array.isArray(loader.pendingQueue), '宿主脚本没有装好 __ModuleLoader__ 门面');

/** combo 脚本在浏览器里就是「一段会执行 window.__ModuleLoader__.load(...) 的脚本」，这里用 vm 等价执行。 */
let bundlesLoaded = 0;
let moduleSystem;
const options = {
  boot: {
    rev: 'check-registration',
    entries: [
      {
        id: PACKAGE_NAME,
        url: bundleUrl,
        rev: 'check-registration',
        external: [],
        inject: [...(packageJson.dsh.client.inject ?? [])],
      },
    ],
    batches: [{ phase: 'application', url: bundleUrl, rev: 'check-registration', entries: [PACKAGE_NAME] }],
  },
  staticModules: {
    react: { createElement: () => ({}) },
    ...Object.fromEntries((packageJson.dsh.client.inject ?? []).map((name) => [name, {}])),
  },
  loadBundle: async (url) => {
    assert.equal(url, bundleUrl, '宿主应当只请求图里那一行');
    bundlesLoaded += 1;
    vm.runInThisContext(bundleSource, { filename: 'client/client.js' });
  },
};

const bootstrapRegistration = pendingQueue.find((entry) => entry.id === BOOTSTRAP_ID);
assert.ok(bootstrapRegistration !== undefined, `${BOOTSTRAP_ID}/client.js 没有注册工厂`);
moduleSystem = loader.create(
  { id: BOOTSTRAP_ID, exports: bootstrapRegistration.factory(() => {}) },
  options,
);

const row = { id: PACKAGE_NAME, url: bundleUrl, initialUrl: bundleUrl };

/* ── 1. 真的走一遍宿主那条会把 0.3.1 打回原形的路 ── */
let arriveError;
try {
  await moduleSystem.arrive(row);
} catch (error) {
  arriveError = error;
}

check(`arrive()：装载 combo 脚本后宿主查得到工厂 "${PACKAGE_NAME}"`, () => {
  assert.equal(
    arriveError,
    undefined,
    `宿主报告：${arriveError?.message}\n（这正是 0.3.1 在界面上的报错形态）`,
  );
  assert.equal(bundlesLoaded, 1, '应当真的执行过一次 bundle');
  assert.equal(moduleSystem.factories.has(PACKAGE_NAME), true, 'factories 里应有包名');
});

check('对照：短名查不到工厂（0.3.0 / 0.3.1 的失败态）', () => {
  assert.equal(moduleSystem.factories.has('dsh-temptask'), false, '不该再注册短名');
});

/* ── 2. 宿主 Loader 真正接上插件时走的那一步：require("<包名>") ── */
/**
 * `makeRequire` 的签名在 0.2.0-rc.1 变了：
 *   0.1.x：`makeRequire(edges)`；
 *   0.2.x：`makeRequire(ownerId, edges)`——ownerId 用来给 styles / 归属诊断记账。
 * 按形参个数选，两种宿主都能验（写死一种会在另一个宿主上以
 * 「Cannot read properties of undefined (reading 'add')」的形式假失败）。
 */
const edges = new Set();
let plugin;
let requireError;
try {
  const require =
    moduleSystem.makeRequire.length >= 2
      ? moduleSystem.makeRequire(PACKAGE_NAME, edges)
      : moduleSystem.makeRequire(edges);
  plugin = require(PACKAGE_NAME);
} catch (error) {
  requireError = error;
}

check('宿主 require("<包名>") 拿到插件对象，且 inject/apply 齐全', () => {
  assert.equal(requireError, undefined, `require 失败：${requireError?.message}`);
  assert.equal(typeof plugin?.apply, 'function', '插件对象缺少 apply');
  assert.deepEqual(
    plugin.inject,
    ['slots', 'locale'],
    '插件的 inject 列表变了，宿主不会再等这两个服务',
  );
});

console.log(`\n✅ 注册契约 ${passed} 项通过（宿主真实实现）`);
