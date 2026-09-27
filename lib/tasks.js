/**
 * dsh-temptask — 任务管理器（本插件 host 侧的业务核心）。
 *
 * 一个「临时任务」由三件事组成，创建时一次性就位：
 *   1. 目录   `<rootDir>/<YYYY-MM-DD-HH-mm-ss>`  —— 会话的工作目录（互相隔离）
 *   2. 工作区  指向该目录的临时工作区            —— 侧边栏上那个节点
 *   3. 会话    cwd = 该目录、并挂进该工作区      —— 节点下的第一条会话
 *
 * 约定：**公开方法一律返回 ApiResult，不抛错**（内部小工具才抛 TaskError），
 * 这样 routes.ts / commands.ts 都能直接把结果序列化给调用方。
 */
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { isInsideRoot, normalizeRoot, resolveTaskPath, taskDirName, uniqueDirName } from './paths.js';
import { attachSessionToWorkspace, cancelSession, createSessionForDir, isSessionLive, messageOf, } from './sessions.js';
import { archiveSessionQuietly, ensureTaskWorkspace, getTaskWorkspace, removeTaskWorkspace, sessionAccountOf, } from './workspaces.js';
import { ERROR_CODES, } from './types.js';
/** 内部错误：带机器可读错误码。 */
class TaskError extends Error {
    code;
    hint;
    constructor(code, message, hint) {
        super(message);
        this.code = code;
        this.hint = hint;
        this.name = 'TaskError';
    }
}
function failure(code, message, hint) {
    const error = { ok: false, code, message };
    if (hint !== undefined)
        error.hint = hint;
    return error;
}
/** pendingOpen 的有效期：超过就作废（避免重启后突然跳去某个旧会话）。 */
const PENDING_OPEN_TTL_MS = 5 * 60 * 1000;
/** 同一任务 lastOpenedAt 的落盘节流窗口。 */
const TOUCH_PERSIST_INTERVAL_MS = 30 * 1000;
export class TemptaskManager {
    deps;
    warnings = [];
    pendingOpen;
    /** 每个任务最近一次 lastOpenedAt 落盘时间，避免每条会话事件都写盘。 */
    touchedAt = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    /* ─────────────────────────── 启动 ─────────────────────────── */
    /** 启动流程：确保根目录可用 + 载入清单 + 对账磁盘 + 自动清理。幂等，可因配置变更重跑。 */
    async initialize() {
        this.warnings.length = 0;
        await this.ensureRoot();
        const outcome = await this.deps.store.load(this.rootDir());
        for (const warning of outcome.warnings)
            this.recordWarning(warning);
        await this.reconcile();
        await this.runAutoClean();
    }
    /** 由 host.ts 在致命错误（例如根目录完全不可用）时记录告警。 */
    recordWarning(message) {
        if (!this.warnings.includes(message))
            this.warnings.push(message);
    }
    /** 确保任务根目录存在。默认值就在 DSH_HOME 内，因此这里没有「换目录」的回退。 */
    async ensureRoot() {
        const root = this.rootDir();
        try {
            await mkdir(root, { recursive: true });
        }
        catch (error) {
            throw new TaskError(ERROR_CODES.fs, `无法创建任务根目录 ${root}，请检查权限或修改「任务根目录」设置`, messageOf(error));
        }
    }
    /**
     * 与磁盘对账：任务目录是任务的实体，目录没了记录就该消失。
     * （只丢弃记录，不去动工作区节点——那是用户在侧边栏里的东西，DSH 会把它标成 missing。）
     */
    async reconcile() {
        const missing = this.deps.store.list().filter((task) => !existsSync(task.path));
        if (missing.length === 0)
            return;
        const gone = new Set(missing.map((task) => task.id));
        await this.deps.store.mutate((draft) => {
            draft.tasks = draft.tasks.filter((task) => !gone.has(task.id));
        });
        for (const id of gone)
            this.touchedAt.delete(id);
        this.recordWarning(`${missing.length} 个任务记录对应的目录已不存在，已忽略这些记录（工作区节点若有残留可在侧边栏自行删除）`);
    }
    /* ─────────────────────────── 只读视图 ─────────────────────────── */
    /** 生效中的任务根目录。 */
    rootDir() {
        return this.deps.config().rootDir;
    }
    /** 任务清单文件路径（UI/命令展示用）。 */
    get dataFile() {
        return this.deps.store.file;
    }
    /** 当前删除策略（命令文案与 UI 都用它，避免各处自己读配置读岔）。 */
    get deleteSessionPolicy() {
        return this.deps.config().onDeleteSessions;
    }
    /** 插件版本（写进 /state，用来确认"现在跑的是哪一版"）。 */
    get pluginVersion() {
        return this.deps.version;
    }
    /**
     * 主动重读磁盘。命令解析前调用，保证 `/temptask list` 也能看到另一个 profile 的改动。
     * （客户端面板的 /state 会自己 refresh，见 state()。）
     */
    async refresh() {
        await this.deps.store.refresh();
    }
    /**
     * 汇总给 UI 的完整状态。
     * 先重读磁盘：同一个 DSH_HOME 下可能有另一个 profile 在跑，它的改动要能立刻看到。
     */
    async state() {
        await this.deps.store.refresh();
        const config = this.deps.config();
        const pending = this.peekPendingOpen();
        const state = {
            ok: true,
            pluginVersion: this.deps.version,
            rootDir: this.rootDir(),
            dataFile: this.deps.store.file,
            configSource: this.deps.configSource(),
            config: { ...config, rootDir: this.rootDir() },
            tasks: this.listSorted(),
            warnings: [...this.warnings],
            capabilities: this.deps.capabilities(),
            sideSessionDetected: this.deps.sideSessionDetected(),
            now: Date.now(),
        };
        if (pending !== undefined)
            state.pendingOpen = pending;
        return state;
    }
    /** 任务列表：活跃优先，其次按最近使用/创建时间倒序；带上工作区标题（= 侧边栏节点名）。 */
    listSorted() {
        return this.deps.store
            .list()
            .map((task) => this.toView(task))
            .sort((left, right) => {
            if (left.status !== right.status)
                return left.status === 'active' ? -1 : 1;
            const a = left.lastOpenedAt ?? left.createdAt;
            const b = right.lastOpenedAt ?? right.createdAt;
            return b - a;
        });
    }
    toView(task) {
        const workspace = task.workspaceId === undefined ? undefined : getTaskWorkspace(this.deps.ctx, task.workspaceId);
        const view = {
            ...task,
            workspacePresent: workspace !== undefined,
            live: isSessionLive(this.deps.ctx, task.sessionId),
        };
        if (workspace !== undefined)
            view.title = workspace.title;
        return view;
    }
    /* ─────────────────────────── 写操作 ─────────────────────────── */
    /**
     * 新建任务：目录 → 工作区 → 会话 → 挂载 → 记录。
     * 没有命名步骤：节点标题就是**目录名**（DSH 对工作区的默认行为，之后只有显式 rename 才变）；
     * DSH 自动总结的会话标题显示在**会话行**上，本插件不把它写到节点上（见 onSessionTitleChanged）。
     */
    async create() {
        const root = this.rootDir();
        await this.ensureRoot().catch(() => undefined);
        let dirName;
        let dirPath;
        try {
            dirName = uniqueDirName(root, taskDirName());
            dirPath = resolveTaskPath(root, dirName);
        }
        catch (error) {
            return this.toFailure(error);
        }
        // 1) 目录 + 工作区（ensureTaskWorkspace 内部会 mkdir）
        const ensured = await ensureTaskWorkspace(this.deps.ctx, dirPath);
        if (!ensured.ok) {
            await this.rollbackDirectory(dirPath);
            return failure(ERROR_CODES.noWorkspace, ensured.message, ensured.hint);
        }
        const workspace = ensured.workspace;
        // 2) 会话：cwd 用工作区回传的归一化路径（realpath），否则 attach 会因路径不等而失败
        const session = await createSessionForDir(this.deps.ctx, workspace.path);
        const sessionId = session.sessionId;
        if (sessionId === undefined) {
            await this.rollbackDirectory(workspace.path);
            if (workspace.created)
                await removeTaskWorkspace(this.deps.ctx, workspace.workspaceId);
            return failure(ERROR_CODES.noSession, '任务目录已回滚：无法创建会话', session.reason ?? '当前 DSH 未提供可用于创建会话的服务');
        }
        // 3) 挂进工作区 —— 这一步决定它出现在侧边栏哪个节点下
        const attached = await attachSessionToWorkspace(this.deps.ctx, workspace.workspaceId, sessionId);
        if (!attached.attached) {
            this.recordWarning(`会话已创建但未能挂进任务节点（${attached.reason ?? '未知原因'}），它可能出现在「未分组」下`);
        }
        // 4) 记录（按目录去重：另一个进程若刚为同一目录写过记录，复用它）
        const now = Date.now();
        const task = {
            id: mintTaskId(),
            dirName,
            path: workspace.path,
            workspaceId: workspace.workspaceId,
            createdAt: now,
            lastOpenedAt: now,
            sessionId,
            status: 'active',
        };
        const persisted = await this.deps.store.mutate((draft) => {
            draft.rootDir = root;
            const clash = draft.tasks.find((row) => normalizeRoot(row.path) === normalizeRoot(task.path));
            if (clash !== undefined) {
                clash.workspaceId = workspace.workspaceId;
                clash.sessionId = sessionId;
                clash.status = 'active';
                clash.lastOpenedAt = now;
                delete clash.closedAt;
                return { ...clash };
            }
            draft.tasks.push(task);
            return { ...task };
        });
        this.requestOpen(persisted.id, sessionId);
        this.deps.log('info', `created task ${persisted.id} at ${workspace.path} (session ${sessionId})`);
        return {
            ok: true,
            task: this.toView(persisted),
            sessionId,
            workspaceId: workspace.workspaceId,
            workspaceCreated: workspace.created,
        };
    }
    /**
     * 打开任务：目录缺失报 MISSING_DIR；会话还活着就复用，否则在同一目录新建一条会话。
     * 顺带自愈：节点被用户在侧边栏删掉时，重新按路径建回来。
     */
    async open(query) {
        const resolved = this.resolveTask(query);
        if ('ok' in resolved)
            return resolved;
        const task = resolved.task;
        if (!existsSync(task.path)) {
            return failure(ERROR_CODES.missingDir, `任务目录不存在：${task.path}`, '该目录已被手动删除；可在清理里移除这条记录，之后再新建任务。');
        }
        // 节点自愈：工作区记录可能被用户在侧边栏删掉了
        const ensured = await ensureTaskWorkspace(this.deps.ctx, task.path);
        if (!ensured.ok)
            return failure(ERROR_CODES.noWorkspace, ensured.message, ensured.hint);
        const workspace = ensured.workspace;
        if (task.workspaceId !== workspace.workspaceId) {
            await this.deps.store.mutate((draft) => {
                const target = draft.tasks.find((row) => row.id === task.id);
                if (target !== undefined)
                    target.workspaceId = workspace.workspaceId;
            });
        }
        if (isSessionLive(this.deps.ctx, task.sessionId)) {
            const sessionId = task.sessionId;
            await attachSessionToWorkspace(this.deps.ctx, workspace.workspaceId, sessionId);
            const updated = await this.markActive(task.id);
            this.requestOpen(task.id, sessionId);
            return { ok: true, task: updated ?? this.toView(task), sessionId, reused: true };
        }
        const session = await createSessionForDir(this.deps.ctx, workspace.path);
        const sessionId = session.sessionId;
        if (sessionId === undefined) {
            return failure(ERROR_CODES.noSession, '无法为该任务创建会话', session.reason ?? '当前 DSH 未提供可用于创建会话的服务');
        }
        await attachSessionToWorkspace(this.deps.ctx, workspace.workspaceId, sessionId);
        const updated = await this.deps.store.mutate((draft) => {
            const target = draft.tasks.find((row) => row.id === task.id);
            if (target === undefined)
                return undefined;
            target.sessionId = sessionId;
            target.status = 'active';
            target.lastOpenedAt = Date.now();
            delete target.closedAt;
            return { ...target };
        });
        this.requestOpen(task.id, sessionId);
        return {
            ok: true,
            task: updated === undefined ? this.toView(task) : this.toView(updated),
            sessionId,
            reused: false,
        };
    }
    /**
     * 删除任务：**会话 → 目录 → 节点 → 记录**（手动删除与自动清理共用这一条路径）。
     *
     * 顺序与策略（对应「删任务后对话不会消失、而是掉进未分组」那个问题）：
     *   1. 先读会话账目（`workspace.sessionIds` = cwd==该目录的全部会话）——工作区一删就没了；
     *      只记着"最后一条 sessionId"是不够的，一个任务先后可能开过好几条会话；
     *   2. 若其中有会话还活着（运行中），best-effort `sessionController.cancel` 中止它的当轮，
     *      免得 agent 继续往即将消失的目录里写；
     *   3. 删目录；
     *   4. 按 `onDeleteSessions` 策略处理会话：`archive` → 逐条归档（从侧边栏消失）/ `keep` → 不动；
     *   5. 删工作区记录，最后删本插件记录。
     */
    async remove(id) {
        const task = this.deps.store.find(id);
        if (task === undefined)
            return failure(ERROR_CODES.notFound, `任务不存在：${id}`);
        const disposed = await this.disposeTask(task);
        if (disposed instanceof TaskError)
            return this.toFailure(disposed);
        await this.deps.store.mutate((draft) => {
            draft.tasks = draft.tasks.filter((row) => row.id !== id);
        });
        this.touchedAt.delete(id);
        this.deps.log('info', `removed task ${id} (dir: ${String(disposed.dirRemoved)}, archived sessions: ${disposed.sessionsArchived}, policy: ${this.deps.config().onDeleteSessions})`);
        return { ok: true, task: this.toView(task), ...disposed };
    }
    /** 清理任务：每条都走同一条 dispose 路径，所以手动删除/自动清理不会再有行为差。 */
    async clean(options) {
        const all = options.all === true;
        const ids = options.ids ?? [];
        if (!all && ids.length === 0) {
            return failure(ERROR_CODES.badRequest, '没有指定要清理的任务');
        }
        const targets = all
            ? this.deps.store.list()
            : ids
                .map((id) => this.deps.store.find(id))
                .filter((task) => task !== undefined);
        const removed = [];
        const failed = [];
        let sessionsArchived = 0;
        for (const task of targets) {
            const disposed = await this.disposeTask(task);
            if (disposed instanceof TaskError) {
                failed.push({ id: task.id, message: disposed.message });
                continue;
            }
            sessionsArchived += disposed.sessionsArchived;
            removed.push(task.id);
            this.touchedAt.delete(task.id);
        }
        if (removed.length > 0) {
            await this.deps.store.mutate((draft) => {
                draft.tasks = draft.tasks.filter((row) => !removed.includes(row.id));
            });
        }
        this.deps.log('info', `cleaned ${removed.length} task(s), ${failed.length} failed, archived ${sessionsArchived} session(s)`);
        return { ok: true, removed, failed, sessionsArchived };
    }
    /** 单条任务的处置流程；失败返回 TaskError（目录没删掉时记录与节点都不动）。 */
    async disposeTask(task) {
        // 1) 会话账目必须在删工作区之前读
        const account = sessionAccountOf(this.deps.ctx, task.workspaceId);
        const sessionIds = account.length > 0 ? account : task.sessionId === undefined ? [] : [task.sessionId];
        // 2) 活着的会话先中止当轮
        let sessionsCanceled = 0;
        for (const sessionId of sessionIds) {
            if (!isSessionLive(this.deps.ctx, sessionId))
                continue;
            if (await cancelSession(this.deps.ctx, sessionId))
                sessionsCanceled += 1;
        }
        // 3) 删目录（失败则整体中止，不留半清理状态）
        const dirRemoved = await this.removeDirectory(task);
        if (dirRemoved instanceof TaskError)
            return dirRemoved;
        // 4) 按策略处理会话
        let sessionsArchived = 0;
        if (this.deps.config().onDeleteSessions === 'archive') {
            for (const sessionId of sessionIds) {
                if (await archiveSessionQuietly(this.deps.ctx, sessionId))
                    sessionsArchived += 1;
            }
        }
        // 5) 删节点记录
        const workspace = await removeTaskWorkspace(this.deps.ctx, task.workspaceId);
        if (task.workspaceId !== undefined && !workspace.removed) {
            this.recordWarning(`任务目录已删除，但侧边栏节点未能移除${workspace.reason === undefined ? '' : `（${workspace.reason}）`}；可在侧边栏手动删除该节点`);
        }
        return { dirRemoved, workspaceRemoved: workspace.removed, sessionsArchived, sessionsCanceled };
    }
    /**
     * 安全删除任务目录。
     * @returns true 表示目录已删/本就不存在；TaskError 表示拒绝或失败。
     */
    async removeDirectory(task) {
        const root = this.rootDir();
        let target;
        try {
            // 三重校验：记录里的 path 必须在根目录内，且必须与「根目录 + dirName」解析一致。
            const expected = resolveTaskPath(root, task.dirName);
            if (normalizeRoot(task.path) !== normalizeRoot(expected)) {
                throw new TaskError(ERROR_CODES.outsideRoot, `拒绝删除：任务路径与目录名不一致（${task.path} ≠ ${expected}）`);
            }
            if (!isInsideRoot(root, expected) || normalizeRoot(expected) === normalizeRoot(root)) {
                throw new TaskError(ERROR_CODES.outsideRoot, `拒绝删除：${expected} 不在任务根目录内`);
            }
            target = expected;
        }
        catch (error) {
            return error instanceof TaskError
                ? error
                : new TaskError(ERROR_CODES.outsideRoot, `拒绝删除：${messageOf(error)}`);
        }
        if (!existsSync(target))
            return true;
        try {
            await rm(target, { recursive: true, force: true });
            return true;
        }
        catch (error) {
            return new TaskError(ERROR_CODES.fs, `删除任务目录失败：${target}`, messageOf(error));
        }
    }
    /** 会话创建失败后的回滚：只用 rm 删掉刚刚创建的目录。 */
    async rollbackDirectory(path) {
        try {
            if (existsSync(path))
                await rm(path, { recursive: true, force: true });
            this.deps.log('warn', `rolled back task directory ${path}`);
        }
        catch (error) {
            this.deps.log('error', `回滚目录失败 ${path}: ${messageOf(error)}`);
        }
    }
    /* ─────────────────────── 钩子回调 ─────────────────────── */
    /**
     * `session/created`：cwd 落在任务根目录下且未登记 → 自动登记成任务并挂到它的节点上。
     * 这覆盖了「用户直接在这个目录里开了个会话」和「本插件重启后收养旧会话」两种情况。
     */
    async adoptSession(session) {
        const sessionId = typeof session.id === 'string' ? session.id : undefined;
        const cwd = session.header?.cwd;
        if (sessionId === undefined || typeof cwd !== 'string' || cwd.length === 0)
            return;
        if (!isInsideRoot(this.rootDir(), cwd))
            return;
        const target = normalizeRoot(cwd);
        // 工作区先行：没有节点就没有「任务」这件事
        const ensured = await ensureTaskWorkspace(this.deps.ctx, target);
        const workspaceId = ensured.ok ? ensured.workspace.workspaceId : undefined;
        if (ensured.ok) {
            await attachSessionToWorkspace(this.deps.ctx, workspaceId, sessionId);
        }
        else {
            this.recordWarning(`自动登记会话 ${sessionId} 失败：${ensured.message}`);
        }
        const outcome = await this.deps.store.mutate((draft) => {
            const existing = draft.tasks.find((row) => row.sessionId === sessionId) ??
                draft.tasks.find((row) => normalizeRoot(row.path) === target);
            if (existing !== undefined) {
                existing.sessionId = sessionId;
                if (workspaceId !== undefined)
                    existing.workspaceId = workspaceId;
                existing.status = 'active';
                existing.lastOpenedAt = Date.now();
                delete existing.closedAt;
                return { kind: 'adopted', id: existing.id };
            }
            const task = {
                id: mintTaskId(),
                dirName: basename(target),
                path: target,
                ...(workspaceId === undefined ? {} : { workspaceId }),
                createdAt: Date.now(),
                lastOpenedAt: Date.now(),
                sessionId,
                status: 'active',
            };
            draft.tasks.push(task);
            return { kind: 'registered', id: task.id };
        });
        this.deps.log('info', outcome.kind === 'adopted'
            ? `adopted session ${sessionId} into task ${outcome.id}`
            : `auto-registered task ${outcome.id} for session ${sessionId} (cwd ${target})`);
    }
    /** `session/disposed`：任务标记 closed（在锁内查找，兼容另一个进程登记的记录）。 */
    async markSessionClosed(sessionId) {
        const closedId = await this.deps.store.mutate((draft) => {
            const target = draft.tasks.find((row) => row.sessionId === sessionId);
            if (target === undefined || target.status === 'closed')
                return undefined;
            target.status = 'closed';
            target.closedAt = Date.now();
            return target.id;
        });
        if (closedId === undefined)
            return;
        this.deps.log('info', `session ${sessionId} disposed → task ${closedId} closed`);
    }
    /**
     * 会话活动 → 刷新 lastOpenedAt。
     * 说明：当前 DSH 没有 `session/focused` 事件（事件目录里只有 created/disposed/event/flush 等），
     * 因此「最后打开时间」由三处共同维护：本插件的打开动作、`session/created`、以及用户消息
     * （`session/event` 的 `user/message`）——后者等价于「用户正在使用这个任务」。
     */
    async touchSession(sessionId) {
        const cached = this.deps.store.findBySession(sessionId);
        if (cached === undefined)
            return;
        const now = Date.now();
        const last = this.touchedAt.get(cached.id) ?? 0;
        if (now - last < TOUCH_PERSIST_INTERVAL_MS)
            return;
        this.touchedAt.set(cached.id, now);
        await this.deps.store.mutate((draft) => {
            const target = draft.tasks.find((row) => row.sessionId === sessionId);
            if (target === undefined)
                return;
            target.lastOpenedAt = now;
            if (target.status === 'closed') {
                target.status = 'active';
                delete target.closedAt;
            }
        });
    }
    /**
     * 会话标题变化（`session/title`）——**本插件什么都不做**。
     *
     * 曾经这里会把 DSH 自动总结的会话标题 `setTitle` 写回工作区，结果是：
     * 每次标题刷新（每轮对话都可能发生）都把侧边栏节点改名一次，还会覆盖用户手动改的名字。
     * 而 DSH 的语义是「工作区标题默认取文件夹 basename，之后只有显式 rename 才变」——
     * 会话标题属于**会话行**，节点名属于目录。所以这里现在是一个显式的空实现：
     * 保留方法是为了让 hooks.ts 的调用点自解释，也方便日后要加"可选镜像"时有落点。
     */
    async onSessionTitleChanged(_session) {
        /* 有意留空：不碰工作区标题。 */
    }
    /** lastOpenedAt + status=active（打开动作调用，节流不适用）。 */
    async markActive(id) {
        const now = Date.now();
        this.touchedAt.set(id, now);
        const updated = await this.deps.store.mutate((draft) => {
            const target = draft.tasks.find((row) => row.id === id);
            if (target === undefined)
                return undefined;
            target.lastOpenedAt = now;
            target.status = 'active';
            delete target.closedAt;
            return { ...target };
        });
        return updated === undefined ? undefined : this.toView(updated);
    }
    /* ─────────────────────────── 待打开请求 ─────────────────────────── */
    /** 请求前端把某个会话切到前台（/temptask new、/temptask open 与 UI 新建都走这里）。 */
    requestOpen(taskId, sessionId) {
        if (sessionId.length === 0)
            return;
        this.pendingOpen = { taskId, sessionId, at: Date.now() };
    }
    /** 查看待打开请求（**不消费**：客户端可能轮询多次，只有明确 ack 之后才清空）。 */
    peekPendingOpen() {
        const pending = this.pendingOpen;
        if (pending === undefined)
            return undefined;
        if (Date.now() - pending.at > PENDING_OPEN_TTL_MS) {
            this.pendingOpen = undefined;
            return undefined;
        }
        return pending;
    }
    /** 客户端消费完毕（或放弃）后调用。 */
    ackPendingOpen() {
        this.pendingOpen = undefined;
    }
    /* ─────────────────────────── 自动清理 ─────────────────────────── */
    /** 启动时的自动清理：仅处理「已关闭且最后使用超过 N 天」的任务（走与手动删除同一条 dispose 路径）。 */
    async runAutoClean() {
        const days = this.deps.config().autoCleanDays;
        if (!Number.isFinite(days) || days <= 0)
            return;
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        const stale = this.deps.store
            .list()
            .filter((task) => task.status === 'closed' && (task.lastOpenedAt ?? task.createdAt) < cutoff);
        if (stale.length === 0)
            return;
        const result = await this.clean({ ids: stale.map((task) => task.id) });
        if (result.ok && result.removed.length > 0) {
            this.recordWarning(`自动清理：已删除 ${result.removed.length} 个超过 ${days} 天未使用的已关闭任务` +
                `（归档了 ${result.sessionsArchived} 条会话）`);
        }
    }
    /* ─────────────────────────── 内部工具 ─────────────────────────── */
    /**
     * 支持 ID / 目录名 / 节点标题的匹配：
     * ID 与目录名精确优先，其次标题/目录名/ID 片段；多个匹配时要求调用方消歧。
     */
    resolveTask(query) {
        const needle = query.trim();
        if (needle.length === 0)
            return failure(ERROR_CODES.badRequest, '请提供任务 ID、目录名或标题片段');
        const byId = this.deps.store.find(needle);
        if (byId !== undefined)
            return { task: byId };
        const lower = needle.toLowerCase();
        const exact = this.deps.store
            .list()
            .filter((task) => task.dirName.toLowerCase() === lower ||
            (this.toView(task).title ?? '').toLowerCase() === lower);
        if (exact.length === 1)
            return { task: exact[0] };
        if (exact.length > 1) {
            return failure(ERROR_CODES.ambiguous, `有 ${exact.length} 个任务同名：${exact.map((task) => task.id).join(', ')}`, '请改用任务 ID 精确指定');
        }
        const partial = this.deps.store.list().filter((task) => {
            const title = (this.toView(task).title ?? '').toLowerCase();
            return (task.id.toLowerCase().includes(lower) ||
                task.dirName.toLowerCase().includes(lower) ||
                title.includes(lower));
        });
        if (partial.length === 1)
            return { task: partial[0] };
        if (partial.length > 1) {
            return failure(ERROR_CODES.ambiguous, `匹配到 ${partial.length} 个任务，请指定更精确的名称或 ID：\n` +
                partial
                    .map((task) => `  • ${this.toView(task).title ?? task.dirName}（${task.id}）`)
                    .join('\n'));
        }
        return failure(ERROR_CODES.notFound, `任务不存在：${needle}`);
    }
    /** 供命令层展示用：解析任务，供 /temptask open、/temptask clean 复用。 */
    resolve(query) {
        return this.resolveTask(query);
    }
    toFailure(error) {
        if (error instanceof TaskError)
            return failure(error.code, error.message, error.hint);
        return failure(ERROR_CODES.fs, messageOf(error));
    }
    /** 当前告警快照。 */
    getWarnings() {
        return [...this.warnings];
    }
}
/** 任务 ID：可读、单调、无碰撞风险。 */
function mintTaskId() {
    return `task-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
}
