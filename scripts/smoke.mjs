/**
 * dsh-temptask — host 侧端到端冒烟测试（不依赖 DSH 进程）。
 *
 * 用一个「桩 Cordis 上下文」挂载 lib/index.js，然后直接打 HTTP 路由处理器。
 * 桩里的 workspaceRegistry **刻意复刻 DSH 的真实语义**（create 走 realpath、attachSession
 * 硬校验 cwd === workspace.path），这样测试才能抓住「先建目录 → 再建工作区 → 用工作区回传的
 * 归一化路径建会话 → 挂载」这个顺序一旦被写反就会暴露的问题。
 *
 * 覆盖：任务=时间戳目录+临时工作区、无命名步骤、会话标题变化不改动节点名、清理/自动清理、
 * 路径穿越防护、清单损坏、跨进程并发、能力缺失时的回滚与降级。
 *
 * 运行：node scripts/smoke.mjs
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import plugin from '../lib/index.js';

const workspace = join(tmpdir(), `dsh-temptask-smoke-${Date.now()}`);
const rootDir = join(workspace, 'root');
const dataDir = join(workspace, 'data');
const storeFile = join(dataDir, 'tasks.json');

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 每个桩实例一套状态（模拟一个 host 进程）。 */
function newState(overrides = {}) {
  return {
    sessionCalls: [],
    liveSessions: new Set(),
    sessionCwd: new Map(),
    titles: new Map(),
    attached: [],
    created: [],
    archived: [],
    canceled: [],
    opened: [],
    titleCalls: [],
    ...overrides,
  };
}

/** 桩工作区注册表：语义对齐 DSH（realpath 归一化 + attachSession 校验 cwd）。 */
function createWorkspaceRegistry(state) {
  const byId = new Map();
  let seq = 0;

  const entity = (record) => ({
    get id() {
      return record.id;
    },
    get path() {
      return record.path;
    },
    get title() {
      return record.title;
    },
    get sessionIds() {
      return [...record.sessionIds];
    },
    async setTitle(title) {
      record.title = title;
      state.titleCalls.push({ id: record.id, title });
    },
    async attachSession(sessionId) {
      const headerCwd = state.sessionCwd.get(sessionId);
      if (headerCwd === undefined) {
        throw new Error(`cannot attach session '${sessionId}': its stored header carries no cwd`);
      }
      const cwd = await realpath(headerCwd);
      if (cwd !== record.path) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${record.path}': its cwd resolves to '${cwd}'`,
        );
      }
      if (!record.sessionIds.includes(sessionId)) record.sessionIds.unshift(sessionId);
      state.attached.push({ workspaceId: record.id, sessionId });
    },
  });

  return {
    async create(path, title) {
      const canonical = await realpath(path); // 目录不存在 → ENOENT，与 DSH 一致
      const record = {
        id: `ws-${(seq += 1)}`,
        path: canonical,
        title: title ?? basename(canonical),
        sessionIds: [],
      };
      byId.set(record.id, record);
      state.created.push(record);
      return entity(record);
    },
    get(id) {
      const record = byId.get(id);
      return record === undefined ? undefined : entity(record);
    },
    list() {
      return [...byId.values()].map(entity);
    },
    async delete(id) {
      return byId.delete(id);
    },
    async resolveByPath(path) {
      const canonical = await realpath(path);
      const found = [...byId.values()].find((record) => record.path === canonical);
      return found === undefined ? undefined : entity(found);
    },
    async archiveSession(sessionId) {
      state.archived.push(sessionId);
    },
  };
}

/** 桩实例序号：保证不同 peer（模拟不同 host 进程）拿到的 sessionId 不会撞车。 */
let stubSeq = 0;

/** 创建一个桩 ctx，并记录插件注册的监听器、命令与路由。 */
function createStubContext(state) {
  const tag = (stubSeq += 1);
  const listeners = new Map();
  const routes = new Map();
  const commands = new Map();

  const sessionController = {
    async create(request) {
      state.sessionCalls.push(request);
      const sessionId = `session-smoke-${tag}-${state.sessionCalls.length}`;
      state.liveSessions.add(sessionId);
      state.sessionCwd.set(sessionId, request.cwd);
      return { sessionId };
    },
    async cancel(request) {
      state.canceled.push(request.sessionId);
      return { canceled: true };
    },
    canOpenWorkspacePath() {
      return state.noOpenPath !== true;
    },
    async openWorkspacePath(request, signal) {
      if (state.noOpenPath === true) throw new Error('宿主未接管文件管理器');
      // 复刻真实实现：它第一行就是 `signal.throwIfAborted()`。
      // 桩如果不校验这个，就抓不到"忘了传 signal"这类事故（真机实测撞过一次）。
      if (signal === undefined) {
        throw new Error("Cannot read properties of undefined (reading 'throwIfAborted')");
      }
      signal.throwIfAborted();
      state.opened.push(request.path);
      return { opened: true };
    },
  };

  const sessions = {
    get: (id) => (state.liveSessions.has(id) ? { id } : undefined),
    list: () => [...state.liveSessions].map((id) => ({ id })),
  };

  const workspaceRegistry = createWorkspaceRegistry(state);

  const sessionTitle = {
    get: (session) => {
      const title = state.titles.get(session?.id);
      return title === undefined ? undefined : { title };
    },
  };

  const webServer = {
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };

  const commandsService = {
    register(definition) {
      commands.set(definition.name, definition);
      return () => commands.delete(definition.name);
    },
  };

  const stub = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get(name) {
      switch (name) {
        case 'sessionController':
          return sessionController;
        case 'sessions':
          return sessions;
        case 'workspaceRegistry':
          return state.noWorkspaceRegistry === true ? undefined : workspaceRegistry;
        case 'sessionTitle':
          return sessionTitle;
        case 'connection':
        case 'settings':
          return undefined;
        default:
          return undefined;
      }
    },
    inject(names, callback) {
      const map = { commands: commandsService, webServer };
      const child = { get: (name) => map[name], effect: (fn) => fn() };
      if (names.every((name) => map[name] !== undefined)) callback(child);
      return () => {};
    },
    on(event, listener) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    effect(fn) {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
  };

  return { ctx: stub, listeners, routes, commands, workspaceRegistry };
}

/** 造一个够用的 IncomingMessage（异步可迭代 + method/headers）。 */
function makeRequest(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  return {
    method,
    headers: { host: '127.0.0.1:43120' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function makeResponse() {
  const state = { status: 0, body: '' };
  return {
    state,
    setHeader() {},
    writeHead(status) {
      state.status = status;
    },
    end(payload) {
      state.body = typeof payload === 'string' ? payload : '';
    },
  };
}

/** 调一个已注册的路由。 */
async function call(routes, path, method = 'GET', body) {
  const route = routes.get(path);
  assert.ok(route !== undefined, `route ${path} 未注册`);
  const res = makeResponse();
  await route.handler(makeRequest(method, body), res);
  assert.equal(res.state.status, 200, `${path} 期望 200，实际 ${res.state.status}：${res.state.body}`);
  return JSON.parse(res.state.body);
}

const API = '/dsh-temptask/api';

/**
 * 模拟 DSH 的会话销毁：先从 store 里移除（live 集合），再发 `session/disposed`。
 * 真实 DSH 里 disposed 事件正是"会话已离开 store"的公告，顺序反过来会让
 * `open` 的复用/新建分支判断失真。
 */
function disposeSession(stub, state, sessionId) {
  state.liveSessions.delete(sessionId);
  stub.listeners.get('session/disposed')({ id: sessionId });
}

/* ─────────────────────── 测试主体 ─────────────────────── */

console.log(`dsh-temptask smoke @ ${workspace}`);

const state = newState();
const { ctx, listeners, routes, commands, workspaceRegistry } = createStubContext(state);

plugin.apply(ctx, { rootDir, dataDir, autoCleanDays: 0 });

const taskCmd = () => commands.get('temptask');

try {
  /* 1. 空清单与根目录 */
  const initial = await call(routes, `${API}/state`);
  check('GET /state：空清单 + 根目录 + 能力探测（含 workspaceRegistry）', () => {
    assert.equal(initial.ok, true);
    assert.ok(initial.pluginVersion.length > 0, 'state 应带 host 版本，供 UI 显示"跑的是哪一版"');
    assert.equal(initial.capabilities.canOpenPath, true, '宿主能打开文件夹时能力位应为 true');
    assert.equal(initial.tasks.length, 0);
    assert.equal(initial.rootDir, rootDir);
    assert.equal(initial.dataFile, storeFile);
    assert.equal(initial.capabilities.workspaceRegistry, true);
    assert.equal(initial.capabilities.sessionController, true);
    assert.equal(initial.capabilities.settings, false);
  });

  /* 2. 创建：目录（时间戳）+ 工作区 + 会话 + 挂载 */
  const first = await call(routes, `${API}/create`, 'POST', {});
  check('POST /create：目录名=时间戳，目录真实存在于根目录下', () => {
    assert.equal(first.ok, true);
    assert.ok(
      /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}(-\d+)?$/u.test(first.task.dirName),
      `目录名应为时间戳：${first.task.dirName}`,
    );
    assert.ok(existsSync(first.task.path), '任务目录应已创建');
    assert.equal(first.task.path, join(rootDir, first.task.dirName));
    assert.equal(first.task.status, 'active');
  });

  const canonicalFirst = await realpath(first.task.path);
  check('任务目录被做成临时工作区（节点路径 = realpath 归一化后的目录）', () => {
    const created = state.created[0];
    assert.ok(created !== undefined, '应创建工作区');
    assert.equal(created.path, canonicalFirst);
    assert.equal(created.title, basename(canonicalFirst), '占位标题 = 目录 basename（时间戳）');
    assert.equal(first.workspaceId, created.id);
    assert.equal(first.workspaceCreated, true);
  });

  check('会话 cwd = 任务目录，且**只传 cwd**（不传 workspaceId）', () => {
    assert.equal(state.sessionCalls.length, 1);
    assert.deepEqual(Object.keys(state.sessionCalls[0]), ['cwd']);
    assert.equal(state.sessionCalls[0].cwd, first.task.path);
    assert.match(first.sessionId, /^session-smoke-\d+-1$/u);
  });

  check('会话被挂进该工作区（侧边栏才归到这个节点下）', () => {
    assert.equal(state.attached.length, 1);
    assert.equal(state.attached[0].sessionId, first.sessionId);
    assert.equal(state.attached[0].workspaceId, first.workspaceId);
  });

  const afterCreate = await call(routes, `${API}/state`);
  check('GET /state 暴露 pendingOpen（供前端自动切会话）', () => {
    assert.equal(afterCreate.tasks.length, 1);
    assert.equal(afterCreate.pendingOpen.sessionId, first.sessionId);
    assert.equal(afterCreate.pendingOpen.taskId, first.task.id);
    assert.equal(afterCreate.tasks[0].workspacePresent, true);
  });

  /* 3. 第二次创建：目录不冲突，各自有独立工作区 */
  const second = await call(routes, `${API}/create`, 'POST', {});
  check('第二个任务：独立目录 + 独立工作区（隔离）', () => {
    assert.equal(second.ok, true);
    assert.notEqual(second.task.path, first.task.path);
    assert.notEqual(second.workspaceId, first.workspaceId);
    assert.ok(existsSync(first.task.path) && existsSync(second.task.path));
    assert.equal(state.created.length, 2);
  });

  /* 4. 命名相关的东西已经彻底移除 */
  check('已移除命名相关接口：没有 preview / rename 路由', () => {
    assert.equal(routes.has(`${API}/preview`), false);
    assert.equal(routes.has(`${API}/rename`), false);
    assert.equal(routes.has(`${API}/create`), true);
  });

  /* 5. 会话标题变化**不**应改动工作区标题 */
  // 回归用例：曾经插件监听 session/title 并把 DSH 总结的标题写回工作区，
  // 于是每轮对话都可能给侧边栏节点改名，还会覆盖用户手动改的名字。
  state.titles.set(first.sessionId, '修复登录 bug');
  listeners.get('session/event')({ id: first.sessionId }, { type: 'session/title' });
  await sleep(60);
  const titled = await call(routes, `${API}/state`);
  check('会话标题变化不改工作区标题（节点名保持目录名，且不调用 setTitle）', () => {
    const row = titled.tasks.find((task) => task.id === first.task.id);
    assert.equal(row.title, first.task.dirName, '节点标题应仍是目录名');
    assert.deepEqual(state.titleCalls, [], '不应该调用 workspace.setTitle');
  });

  /* 6. 打开：目录缺失 → MISSING_DIR */
  await rm(second.task.path, { recursive: true, force: true });
  const openMissing = await call(routes, `${API}/open`, 'POST', { id: second.task.id });
  check('打开目录已被删除的任务 → MISSING_DIR', () => {
    assert.equal(openMissing.ok, false);
    assert.equal(openMissing.code, 'MISSING_DIR');
  });

  /* 7. 打开：复用活会话 */
  const reopened = await call(routes, `${API}/open`, 'POST', { id: first.task.id });
  check('POST /open 复用仍然活着的会话（reused=true）', () => {
    assert.equal(reopened.ok, true);
    assert.equal(reopened.reused, true);
    assert.equal(reopened.sessionId, first.sessionId);
  });

  /* 8. 删除：confirm 语义 + 目录/节点/记录三样都清 */
  const deleteWithoutConfirm = await call(routes, `${API}/delete`, 'POST', { id: second.task.id });
  check('删除缺 confirm → CONFIRM_REQUIRED', () => {
    assert.equal(deleteWithoutConfirm.ok, false);
    assert.equal(deleteWithoutConfirm.code, 'CONFIRM_REQUIRED');
  });

  const removed = await call(routes, `${API}/delete`, 'POST', { id: second.task.id, confirm: true });
  check('带 confirm 删除 → 目录 + 节点 + 记录都清掉', () => {
    assert.equal(removed.ok, true);
    assert.equal(removed.workspaceRemoved, true);
    assert.equal(workspaceRegistry.get(second.workspaceId), undefined);
    assert.ok(!existsSync(second.task.path));
  });

  /* 9. /temptask 命令 */
  check('/temptask 命令已注册', () => {
    assert.ok(taskCmd() !== undefined, '/temptask 未被注册');
    assert.equal(
      taskCmd().name,
      'temptask',
      '命令名应由包名派生（dsh-temptask → temptask）：官方是 compact/feedback/goal 这种单词，不带连字符',
    );
    assert.equal(
      commands.get('task'),
      undefined,
      '不该占用通用词 /task——DSH 或别的插件将来可能要用，占住它既误导又会打架',
    );
  });

  const listText = await taskCmd().handler({ agent: { id: 'session-x' }, rawInput: 'list' });
  check('/temptask list 输出目录、节点、状态', () => {
    assert.equal(listText.kind, 'success');
    assert.ok(listText.text.includes(first.task.path), listText.text);
    assert.ok(listText.text.includes(first.task.dirName), listText.text);
    assert.equal(
      listText.text.includes('修复登录 bug'),
      false,
      '会话标题不该被写到任务/节点名上',
    );
  });

  const newText = await taskCmd().handler({ agent: { id: 'session-x' }, rawInput: 'new' });
  check('/temptask new 无需命名：建目录+工作区+会话，并说明节点名=目录名', () => {
    assert.equal(newText.kind, 'success');
    assert.ok(newText.text.includes('无需起名'), newText.text);
    assert.ok(newText.text.includes(rootDir), newText.text);
  });

  const cleanPreview = await taskCmd().handler({ agent: { id: 'session-x' }, rawInput: 'clean --all' });
  check('/temptask clean 不带 --yes 只预览', () => {
    assert.equal(cleanPreview.kind, 'success');
    assert.ok(cleanPreview.text.includes('将要删除'), cleanPreview.text);
    assert.ok(existsSync(first.task.path), '预览阶段不得真删');
  });

  /* 10. 会话关闭 → closed */
  check('已注册 session/created / disposed / event 钩子', () => {
    assert.equal(typeof listeners.get('session/created'), 'function');
    assert.equal(typeof listeners.get('session/disposed'), 'function');
    assert.equal(typeof listeners.get('session/event'), 'function');
  });

  disposeSession({ listeners }, state, first.sessionId);
  await sleep(50);
  const closed = await call(routes, `${API}/state`);
  check('session/disposed → 任务状态 closed', () => {
    const row = closed.tasks.find((task) => task.id === first.task.id);
    assert.equal(row.status, 'closed');
    assert.ok(typeof row.closedAt === 'number');
  });

  /* 11. 自动登记（外部会话的 cwd 落在任务根目录下） */
  const adoptedDir = join(rootDir, '2026-01-01-00-00-00');
  await mkdir(adoptedDir, { recursive: true });
  // 桩的 sessionCwd 扮演 DSH 里「会话已持久化的 header」——attachSession 校验的是它，
  // 而不是 sessionController.create 的调用参数（真实 DSH 走 host.readSessionHeader）。
  state.sessionCwd.set('session-adopted', adoptedDir);
  listeners.get('session/created')({ id: 'session-adopted', header: { cwd: adoptedDir } });
  await sleep(60);
  const adoptedState = await call(routes, `${API}/state`);
  check('session/created 自动登记成任务并建出它的节点', () => {
    const row = adoptedState.tasks.find((task) => task.sessionId === 'session-adopted');
    assert.ok(row !== undefined, '外部会话应被自动登记');
    assert.equal(row.path, adoptedDir);
    assert.equal(row.workspacePresent, true);
    assert.ok(
      state.attached.some((entry) => entry.sessionId === 'session-adopted'),
      '自动登记也要挂进工作区',
    );
  });

  /* 12. 片段命中多个任务时要求消歧（节点标题=目录名之后，用时间戳前缀来制造歧义） */
  const manyTasks = (await call(routes, `${API}/state`)).tasks;
  assert.ok(manyTasks.length >= 2, '本用例需要至少两个任务');
  const sharedPrefix = manyTasks[0].dirName.slice(0, 4); // 例如 "2026"
  const ambiguous = await taskCmd().handler({
    agent: { id: 'session-x' },
    rawInput: `open ${sharedPrefix}`,
  });
  check('/temptask open 片段命中多个任务 → 提示消歧而不是猜一个', () => {
    assert.equal(ambiguous.kind, 'error');
    assert.ok(/匹配到|同名/u.test(ambiguous.text), ambiguous.text);
  });

  const exactOpen = await taskCmd().handler({ agent: { id: 'session-x' }, rawInput: `open ${first.task.id}` });
  check('/temptask open <ID> 精确指定可打开', () => {
    assert.equal(exactOpen.kind, 'success');
    assert.ok(exactOpen.text.includes(first.task.path), exactOpen.text);
  });

  /* 13. 清理全部：只删子目录/节点，根目录保留 */
  const cleanAll = await taskCmd().handler({ agent: { id: 'session-x' }, rawInput: 'clean --all --yes' });
  const afterClean = await call(routes, `${API}/state`);
  check('/temptask clean --all --yes：清空任务但保留根目录', () => {
    assert.equal(cleanAll.kind, 'success');
    assert.equal(afterClean.tasks.length, 0);
    assert.ok(existsSync(rootDir), '任务根目录本身绝不能被删除');
    assert.ok(!existsSync(adoptedDir), '任务子目录应被删除');
    assert.equal(workspaceRegistry.list().length, 0, '侧边栏节点也应清理干净');
  });

  /* 14. 路径穿越防护 */
  const victim = join(workspace, 'victim');
  await mkdir(victim, { recursive: true });
  await writeFile(join(victim, 'keep.txt'), 'do not delete', 'utf8');
  await writeFile(
    storeFile,
    JSON.stringify({
      version: 1,
      rootDir,
      tasks: [
        {
          id: 'task-evil',
          dirName: '../victim',
          path: victim,
          createdAt: Date.now(),
          status: 'active',
        },
      ],
    }),
    'utf8',
  );

  const evil = createStubContext(newState());
  plugin.apply(evil.ctx, { rootDir, dataDir, autoCleanDays: 0 });
  const evilDelete = await call(evil.routes, `${API}/delete`, 'POST', { id: 'task-evil', confirm: true });
  check('拒绝删除根目录之外的路径（路径穿越防护）', () => {
    assert.equal(evilDelete.ok, false);
    assert.equal(evilDelete.code, 'OUTSIDE_ROOT');
    assert.ok(existsSync(join(victim, 'keep.txt')), '根目录外的文件必须毫发无损');
  });

  /* 15. 清单损坏 → 备份 + 重建 */
  await writeFile(storeFile, '{ this is not json', 'utf8');
  const corrupt = createStubContext(newState());
  plugin.apply(corrupt.ctx, { rootDir, dataDir, autoCleanDays: 0 });
  const corruptState = await call(corrupt.routes, `${API}/state`);
  check('清单损坏 → 备份 tasks.json.bak 并重建空清单', () => {
    assert.equal(corruptState.tasks.length, 0);
    assert.ok(existsSync(`${storeFile}.bak`), '损坏清单应被备份');
    assert.ok(
      corruptState.warnings.some((line) => line.includes('损坏')),
      `应有损坏告警：${JSON.stringify(corruptState.warnings)}`,
    );
  });

  /* 16. 目录被手工删除 → 启动对账丢弃记录 */
  await rm(rootDir, { recursive: true, force: true });
  await mkdir(rootDir, { recursive: true });
  const ghost = join(rootDir, '2020-01-01-00-00-00');
  await writeFile(
    storeFile,
    JSON.stringify({
      version: 1,
      rootDir,
      tasks: [
        {
          id: 'task-ghost',
          dirName: '2020-01-01-00-00-00',
          path: ghost,
          createdAt: Date.now(),
          status: 'closed',
        },
      ],
    }),
    'utf8',
  );
  const reconcile = createStubContext(newState());
  plugin.apply(reconcile.ctx, { rootDir, dataDir, autoCleanDays: 0 });
  const reconcileState = await call(reconcile.routes, `${API}/state`);
  check('目录已不存在的记录在启动时被丢弃并告警', () => {
    assert.equal(reconcileState.tasks.length, 0);
    assert.ok(
      reconcileState.warnings.some((line) => line.includes('目录已不存在')),
      JSON.stringify(reconcileState.warnings),
    );
  });

  /* 17. autoCleanDays 启动清理（顺带归档会话） */
  const staleDir = join(rootDir, '2019-01-01-00-00-00');
  await mkdir(staleDir, { recursive: true });
  await writeFile(
    storeFile,
    JSON.stringify({
      version: 1,
      rootDir,
      tasks: [
        {
          id: 'task-stale',
          dirName: '2019-01-01-00-00-00',
          path: staleDir,
          sessionId: 'session-stale',
          createdAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
          lastOpenedAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
          status: 'closed',
        },
      ],
    }),
    'utf8',
  );
  const autoState = newState();
  const auto = createStubContext(autoState);
  plugin.apply(auto.ctx, { rootDir, dataDir, autoCleanDays: 30 });
  const afterAuto = await call(auto.routes, `${API}/state`);
  check('autoCleanDays=30 启动清理 40 天前已关闭任务，并归档它的会话', () => {
    assert.equal(afterAuto.tasks.length, 0);
    assert.ok(!existsSync(staleDir));
    assert.deepEqual(autoState.archived, ['session-stale'], '自动清理应归档会话而不是丢进未分组');
  });

  /* 18. 能力缺失：没有 workspaceRegistry 时回滚目录 */
  const noWs = createStubContext(newState({ noWorkspaceRegistry: true }));
  plugin.apply(noWs.ctx, { rootDir, dataDir, autoCleanDays: 0 });
  const before = (await call(noWs.routes, `${API}/state`)).tasks.length;
  const noWsCreate = await call(noWs.routes, `${API}/create`, 'POST', {});
  const noWsState = await call(noWs.routes, `${API}/state`);
  check('宿主缺 workspaceRegistry → 拒绝建任务并回滚目录（不留半成品）', () => {
    assert.equal(noWsCreate.ok, false);
    assert.equal(noWsCreate.code, 'WORKSPACE_UNAVAILABLE');
    assert.equal(noWsState.tasks.length, before);
    assert.equal(noWsState.capabilities.workspaceRegistry, false);
  });

  /* 19. 跨进程并发：同一个 DSH_HOME 下两个 profile（两个 host 进程）同时运行 */
  const sharedData = join(workspace, 'shared-data');
  const peerA = createStubContext(newState());
  const peerB = createStubContext(newState());
  plugin.apply(peerA.ctx, { rootDir, dataDir: sharedData, autoCleanDays: 0 });
  plugin.apply(peerB.ctx, { rootDir, dataDir: sharedData, autoCleanDays: 0 });

  const peerATask = await call(peerA.routes, `${API}/create`, 'POST', {});
  const peerBTask = await call(peerB.routes, `${API}/create`, 'POST', {});
  const sharedStore = JSON.parse(await readFile(join(sharedData, 'tasks.json'), 'utf8'));
  check('两个 host 并发写清单不会互相覆盖（写入前重读磁盘）', () => {
    const paths = sharedStore.tasks.map((row) => row.path);
    assert.ok(paths.includes(peerATask.task.path), 'B 的整份覆盖把 A 刚写的记录抹掉了');
    assert.ok(paths.includes(peerBTask.task.path));
    assert.equal(sharedStore.tasks.length, 2);
  });

  const peerAView = await call(peerA.routes, `${API}/state`);
  check('GET /state 会先重读磁盘，看得到另一个 host 建的任务', () => {
    assert.ok(peerAView.tasks.some((task) => task.id === peerBTask.task.id));
  });

  const beforeDisposed = await readFile(join(sharedData, 'tasks.json'), 'utf8');
  peerB.listeners.get('session/disposed')({ id: 'session-not-a-task-at-all' });
  await sleep(80);
  const afterDisposed = await readFile(join(sharedData, 'tasks.json'), 'utf8');
  check('非任务会话事件不产生清单变更（幂等写会跳过落盘）', () => {
    assert.equal(afterDisposed, beforeDisposed);
  });

  await call(peerA.routes, `${API}/clean`, 'POST', { all: true, confirm: true });

  /* 20. 完全缺少相关服务时的优雅降级 */
  const bareCtx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => undefined,
    inject: () => () => {},
    on: () => () => {},
    effect: (fn) => {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
  };
  check('宿主缺少全部相关服务时 apply 不抛错（优雅降级）', () => {
    assert.doesNotThrow(() => plugin.apply(bareCtx, { rootDir, dataDir }));
  });

  /* 21. 删除策略 archive（默认）：连旧会话一起归档，不再掉进未分组 */
  const polState = newState();
  const pol = createStubContext(polState);
  plugin.apply(pol.ctx, { rootDir, dataDir: join(workspace, 'policy-data'), autoCleanDays: 0, onDeleteSessions: 'archive' });

  const archivedTask = await call(pol.routes, `${API}/create`, 'POST', {});
  disposeSession(pol, polState, archivedTask.sessionId); // 第一条会话结束
  await sleep(40);
  const secondSession = await call(pol.routes, `${API}/open`, 'POST', { id: archivedTask.task.id });
  const archivedDelete = await call(pol.routes, `${API}/delete`, 'POST', {
    id: archivedTask.task.id,
    confirm: true,
  });
  const polView = await call(pol.routes, `${API}/state`);
  check('删除任务（archive 策略）：该任务的全部会话都被归档，目录/节点/记录照清', () => {
    assert.equal(polView.config.onDeleteSessions, 'archive', '策略应出现在 /state 的配置里');
    assert.equal(archivedDelete.ok, true);
    assert.equal(
      archivedDelete.sessionsArchived,
      2,
      '应归档工作区账目里的每一条会话，而不是只归档最后一条',
    );
    assert.deepEqual(
      [...polState.archived].sort(),
      [archivedTask.sessionId, secondSession.sessionId].sort(),
    );
    assert.equal(
      archivedDelete.sessionsCanceled,
      1,
      '第二条会话是 open 新建的、仍然活着，删除前应先中止它的当轮',
    );
    assert.equal(pol.workspaceRegistry.get(archivedTask.workspaceId), undefined);
    assert.equal(existsSync(archivedTask.task.path), false);
    assert.equal(polView.tasks.length, 0);
  });

  /* 22. 运行中的任务：删除前先中止当轮 */
  const canceledBefore = polState.canceled.length;
  const liveTask = await call(pol.routes, `${API}/create`, 'POST', {});
  const liveDelete = await call(pol.routes, `${API}/delete`, 'POST', {
    id: liveTask.task.id,
    confirm: true,
  });
  check('删除仍在运行的任务：先 cancel 当轮再删目录（不让 agent 往已消失的目录写）', () => {
    assert.equal(liveDelete.ok, true);
    assert.equal(liveDelete.sessionsCanceled, 1);
    assert.deepEqual(polState.canceled.slice(canceledBefore), [liveTask.sessionId]);
  });

  /* 23. 删除策略 keep：不归档，会话留在官方的「未分组」 */
  const keepState = newState();
  const keep = createStubContext(keepState);
  plugin.apply(keep.ctx, { rootDir, dataDir: join(workspace, 'keep-data'), autoCleanDays: 0, onDeleteSessions: 'keep' });
  const keepTask = await call(keep.routes, `${API}/create`, 'POST', {});
  const keepDelete = await call(keep.routes, `${API}/delete`, 'POST', {
    id: keepTask.task.id,
    confirm: true,
  });
  check('删除策略 keep：目录/节点/记录照删，但一条会话都不归档', () => {
    assert.equal(keepDelete.ok, true);
    assert.equal(keepDelete.sessionsArchived, 0);
    assert.deepEqual(keepState.archived, []);
  });

  /* 24. 打开任务根目录（官方 openWorkspacePath）+ 宿主不支持时如实降级 */
  const openOk = await call(routes, `${API}/open-root`, 'POST', {});
  check('POST /open-root：用官方 openWorkspacePath 打开任务根目录', () => {
    assert.equal(openOk.ok, true);
    assert.equal(openOk.opened, true);
    assert.equal(openOk.path, rootDir);
    assert.deepEqual(state.opened, [rootDir], '应把任务根目录交给宿主的文件管理器');
  });

  // 桩已把「没传 signal」做成抛错（复刻真实现第一行），所以上一条通过就说明传了；
  // 这里再用一个干净实例复验一次，把这条约束显式写下来。
  const probeState = newState();
  const probe = createStubContext(probeState);
  plugin.apply(probe.ctx, { rootDir, dataDir: join(workspace, 'probe-data'), autoCleanDays: 0 });
  const probeResult = await call(probe.routes, `${API}/open-root`, 'POST', {});
  check('调用 openWorkspacePath 必须带 AbortSignal（真实现会立刻 signal.throwIfAborted）', () => {
    assert.equal(probeResult.opened, true);
    assert.deepEqual(probeState.opened, [rootDir]);
  });

  const noOpenState = newState({ noOpenPath: true });
  const noOpen = createStubContext(noOpenState);
  plugin.apply(noOpen.ctx, { rootDir, dataDir: join(workspace, 'noopen-data'), autoCleanDays: 0 });
  const noOpenView = await call(noOpen.routes, `${API}/state`);
  const noOpenResult = await call(noOpen.routes, `${API}/open-root`, 'POST', {});
  check('宿主不能打开文件夹时：能力位为 false，且接口如实返回原因（客户端退回复制）', () => {
    assert.equal(noOpenView.capabilities.canOpenPath, false);
    assert.equal(noOpenResult.ok, true);
    assert.equal(noOpenResult.opened, false);
    assert.ok(typeof noOpenResult.reason === 'string' && noOpenResult.reason.length > 0, noOpenResult);
  });

  /* 25. 数据安全：任务根目录里的**未登记**内容必须毫发无损 */
  // 这是全插件唯一"一错就丢用户数据"的地方，所以用真文件系统正反两面各验一次：
  //   - clean --all 只删**记录在案**的任务目录；
  //   - autoCleanDays 启动清理同理。
  const safetyData = join(workspace, 'safety-data');
  const safetyState = newState();
  const safety = createStubContext(safetyState);
  plugin.apply(safety.ctx, { rootDir, dataDir: safetyData, autoCleanDays: 0 });

  const bystander = join(rootDir, 'my-important-stuff');
  await mkdir(join(bystander, 'nested'), { recursive: true });
  await writeFile(join(bystander, 'keep.txt'), 'do not touch', 'utf8');
  const bystanderSibling = join(rootDir, 'another-personal-dir');
  await mkdir(bystanderSibling, { recursive: true });
  await writeFile(join(bystanderSibling, 'notes.md'), 'mine', 'utf8');

  const safetyTask = await call(safety.routes, `${API}/create`, 'POST', {});
  const safetyClean = await call(safety.routes, `${API}/clean`, 'POST', { all: true, confirm: true });
  check('clean --all：只删登记在案的任务目录，根目录里的无关目录/文件毫发无损', () => {
    assert.equal(safetyClean.ok, true);
    assert.equal(safetyClean.removed.length, 1);
    assert.equal(existsSync(safetyTask.task.path), false, '任务目录应被删除');
    assert.ok(existsSync(join(bystander, 'keep.txt')), '根目录里未登记的目录不能被碰');
    assert.ok(existsSync(join(bystander, 'nested')), '未登记目录的子目录同样不能被碰');
    assert.ok(existsSync(join(bystanderSibling, 'notes.md')), '另一个无关目录也不能被碰');
    assert.ok(existsSync(rootDir), '任务根目录本身永远不能删');
  });

  // 自动清理走的是同一条 disposeTask，用「已关闭且过期」的记录再验一次
  const staleSafetyTask = await call(safety.routes, `${API}/create`, 'POST', {});
  disposeSession(safety, safetyState, staleSafetyTask.sessionId);
  await sleep(40);
  await writeFile(
    join(safetyData, 'tasks.json'),
    JSON.stringify({
      version: 1,
      rootDir,
      tasks: [
        {
          id: 'task-stale-safety',
          dirName: staleSafetyTask.task.dirName,
          path: staleSafetyTask.task.path,
          workspaceId: staleSafetyTask.workspaceId,
          createdAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
          lastOpenedAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
          status: 'closed',
        },
      ],
    }),
    'utf8',
  );
  const safetyAuto = createStubContext(newState());
  plugin.apply(safetyAuto.ctx, { rootDir, dataDir: safetyData, autoCleanDays: 30 });
  await call(safetyAuto.routes, `${API}/state`);
  check('autoCleanDays 清理：同样不碰根目录里未登记的内容', () => {
    assert.ok(existsSync(join(bystander, 'keep.txt')), '自动清理也不能碰未登记的目录');
    assert.ok(existsSync(join(bystanderSibling, 'notes.md')));
  });

  console.log(`\n✅ 全部 ${passed} 项通过`);
} finally {
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
}
