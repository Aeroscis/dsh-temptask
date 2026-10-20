/**
 * dsh-temptask — 用**宿主真实的** `@deepseek-ai/dsh-session/fork` 验证种子构造。
 *
 * 为什么需要它：`src/seed.ts` 是为了「不为 9 行函数新增一个与宿主同档的重依赖」而**照抄**
 * 官方语义的那一段（官方 `buildForkSeed` + `dsh-api-session-controller` 里那个私有的
 * `latestCompletedPrefixBoundary`）。"照抄"的东西会随宿主版本漂移，靠人眼比对不算验证，
 * 所以这里把官方实现**真的跑起来**，与我们的实现在同一批事件流上逐字节比对 JSON 输出；
 * 边界函数也从宿主包里按源码切出来现场编译执行，一起比对。
 *
 * 本脚本做三件事：
 *   1. 从宿主包里解析出 `@deepseek-ai/dsh-session/fork`（走 package.json 的 exports）；
 *   2. 从 `dsh-api-session-controller` 的产物里**切出** `latestCompletedPrefixBoundary` 源码
 *      （花括号配平，不依赖行号）并编译，比对我们 `completedPrefixBoundary` 的返回值；
 *   3. 在 8 组事件流上比对 `buildSeed()` 与官方 `buildForkSeed()` 的输出（`JSON.stringify` 全等），
 *      并断言 `inheritedEventCount === boundary + 1`。
 *
 * 运行：npm run check:seed-parity
 *   - 找不到宿主包时打印原因并以 0 退出（没有 DSH 的机器上不该因此失败）；
 *   - `DSH_APP_ROOT=<解包出来的 dsh 目录>`（或 `DSH_TEMPTASK_DSH_SESSION=<包目录>`）可显式指定。
 *
 * 注意：DSH 桌面版把运行时打包进 app.asar 时普通 Node 读不到，所以脚本会去几个常见落点找
 * **未打包**的那份；本机（DSH Desktop 0.2.0-rc.2）命中的是
 * `resources/app/node_modules/@deepseek-ai/...`。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import * as ours from '../lib/seed.js';

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

/* ── 1. 找宿主包 ── */

const require = createRequire(import.meta.url);

/** 候选：显式环境变量 → DSH Desktop 的 app 目录 → 本机安装的 dsh（装成依赖时命中）。 */
const appRoots = [
  process.env.DSH_APP_ROOT,
  process.env.DSH_TEMPTASK_DSH_SESSION,
  join(dirname(process.execPath), 'resources', 'app'),
  join(dirname(process.execPath), 'app'),
].filter((value) => typeof value === 'string' && value.length > 0);

const sessionDirs = [];
for (const root of appRoots) {
  // 允许直接给包目录，也允许给 node_modules 的父目录
  sessionDirs.push(root.endsWith('dsh-session') ? root : join(root, 'node_modules', '@deepseek-ai', 'dsh-session'));
  sessionDirs.push(join(root, '@deepseek-ai', 'dsh-session'));
}
try {
  sessionDirs.push(dirname(require.resolve('@deepseek-ai/dsh-session/package.json')));
} catch {
  /* 没装成依赖，继续用上面的落点 */
}

let sessionDir;
for (const candidate of sessionDirs) {
  if (existsSync(join(candidate, 'package.json'))) {
    sessionDir = candidate;
    break;
  }
}

if (sessionDir === undefined) {
  console.log(
    '跳过：本机找不到未打包的 @deepseek-ai/dsh-session（这条一致性校验需要 DSH 桌面应用，\n' +
      '或显式指定 DSH_APP_ROOT=<解包出来的 dsh 目录>）。',
  );
  process.exit(0);
}

const sessionPkg = JSON.parse(await readFile(join(sessionDir, 'package.json'), 'utf8'));
const forkEntry = sessionPkg.exports?.['./fork']?.default ?? './lib/types/fork.js';
const forkUrl = pathToFileURL(join(sessionDir, forkEntry)).href;
const official = await import(forkUrl);
assert.equal(typeof official.buildForkSeed, 'function', `${forkEntry} 没有导出 buildForkSeed`);
console.log(`对比对象：@deepseek-ai/dsh-session@${sessionPkg.version}\n  ${join(sessionDir, forkEntry)}`);
if (sessionDir.includes(`${join('', 'node_modules')}`) && !sessionDir.includes('resources')) {
  console.log('  （这是本仓库 devDependencies 带来的那一份；给 DSH_APP_ROOT 可改成直接对比宿主运行时）');
}
console.log('');

/* ── 2. 从宿主产物里切出私有的 latestCompletedPrefixBoundary ── */

const controllerDir = join(dirname(sessionDir), 'dsh-api-session-controller');
const controllerCandidates = [join(controllerDir, 'lib', 'index.js'), join(controllerDir, 'lib', 'types', 'commands.js')];

/** 花括号配平地切出一个具名函数（不依赖行号，宿主改了行数也不影响）。 */
function sliceFunction(source, name) {
  const head = `function ${name}(`;
  const start = source.indexOf(head);
  if (start < 0) return undefined;
  let index = source.indexOf('{', start);
  if (index < 0) return undefined;
  let depth = 0;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return undefined;
}

let officialBoundary;
for (const file of controllerCandidates) {
  if (!existsSync(file)) continue;
  const source = await readFile(file, 'utf8');
  const sliced = sliceFunction(source, 'latestCompletedPrefixBoundary');
  if (sliced === undefined) continue;
  // 该函数是纯函数（只用 Array.prototype.findLast / slice），可以脱离模块作用域执行。
  officialBoundary = new Function(`${sliced}\nreturn latestCompletedPrefixBoundary;`)();
  break;
}

/* ── 3. 事件流固定装置（seq === 下标，这是会话日志的不变式） ── */

const fixtures = [
  { label: '空日志', events: [] },
  { label: '只有半轮（turn/start）', events: [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 't1' } }] },
  {
    label: '一整轮',
    events: [
      { type: 'turn/start', seq: 0, time: 10, data: { turn: 't1' } },
      {
        type: 'assistant/message',
        seq: 1,
        time: 11,
        // 真实的 assistant/message 一定带 data.message.content —— 官方扫描器会读它，
        // 装置里漏掉就会被官方代码当场抛错（这一条本身也是"扫描真的发生了"的证据）。
        data: { turn: 't1', step: 's1', message: { content: [] } },
      },
      { type: 'turn/end', seq: 2, time: 12, data: { turn: 't1', reason: { kind: 'stop' } } },
    ],
  },
  {
    label: '收尾之后有杂项事件（session/title、tool/result）',
    events: [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 't1' } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 't1' } },
      { type: 'session/title', seq: 2, time: 3, data: { title: 'x' } },
      {
        type: 'tool/result',
        seq: 3,
        time: 4,
        surfaceOp: 'append',
        data: { turn: 't1', step: 's1', message: { source: { callId: 'c1' } } },
      },
    ],
  },
  {
    label: '后面又开了一轮',
    events: [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 't1' } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 't1' } },
      { type: 'turn/start', seq: 2, time: 3, data: { turn: 't2' } },
      { type: 'assistant/message', seq: 3, time: 4, data: { turn: 't2', step: 's1', message: { content: [] } } },
      { type: 'turn/end', seq: 4, time: 5, data: { turn: 't2' } },
      { type: 'session/title', seq: 5, time: 6, data: { title: 'y' } },
    ],
  },
  {
    label: '用户又说话（user/message + surfaceOp=append）',
    events: [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 't1' } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 't1' } },
      { type: 'user/message', seq: 2, time: 3, surfaceOp: 'append' },
    ],
  },
  {
    label: '收件箱被改写（agent/inbox/spliced）',
    events: [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 't1' } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 't1' } },
      { type: 'agent/inbox/spliced', seq: 2, time: 3 },
    ],
  },
  {
    label: '多轮 + 尾巴上挂着一个未收尾的 step（边界之后的事件仍属已完成前缀）',
    events: [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 't1' } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 't1' } },
      { type: 'turn/start', seq: 2, time: 3, data: { turn: 't2' } },
      { type: 'assistant/message', seq: 3, time: 4, data: { turn: 't2', step: 's2', message: { content: [] } } },
      { type: 'turn/end', seq: 4, time: 5, data: { turn: 't2' } },
      { type: 'step/start', seq: 5, time: 6, data: { turn: 't2', step: 's3' } },
      { type: 'tool/call', seq: 6, time: 7, data: { turn: 't2', step: 's3', callId: 'c2' } },
    ],
  },
];

for (const { label, events } of fixtures) {
  check(`种子输出与官方 buildForkSeed 逐字节一致：${label}`, () => {
    const boundary = ours.completedPrefixBoundary(events);
    if (officialBoundary !== undefined) {
      assert.equal(boundary, officialBoundary(events), '边界判定必须与宿主私有实现一致');
    }
    const built = ours.buildSeed(events);
    if (boundary === undefined) {
      assert.equal(built, undefined, '没有已完成前缀时我们拒绝造种子');
      return;
    }
    assert.ok(built !== undefined, '有边界时必须造得出种子');
    const officialSeed = official.buildForkSeed(events, boundary);
    assert.equal(
      JSON.stringify(built.seed),
      JSON.stringify(officialSeed),
      '种子内容必须与官方完全一致（含 session/end-seed 的字段与顺序）',
    );
    assert.equal(built.inheritedEventCount, boundary + 1, 'inheritedEventCount = boundary + 1');
  });
}

check('边界函数的来源：确实从宿主产物里切出来了（否则上面的比对会退化成自证）', () => {
  assert.equal(
    typeof officialBoundary,
    'function',
    '没能从 dsh-api-session-controller 里提取 latestCompletedPrefixBoundary —— ' +
      '宿主的函数被改名/移动了，请人工核对 src/seed.ts 的边界语义',
  );
});

check('我们主动收紧的一条：seq 与下标不一致时拒绝造种子（官方 fork 会先抛错，我们选择降级）', () => {
  const broken = [
    { type: 'turn/start', seq: 5, time: 1 },
    { type: 'turn/end', seq: 6, time: 2 },
  ];
  assert.equal(ours.buildSeed(broken), undefined);
});

console.log(`\n✅ 种子一致性 ${passed} 项通过（宿主真实实现）`);
