/**
 * dsh-temptask — 「转正」：把一个临时任务变成正式工作区。
 *
 * 为什么不是一个「改路径」的调用：DSH 的工作区记录以 **realpath 字符串相等**为唯一性
 * （`@deepseek-ai/dsh-workspace` 的 `src/paths.ts`），注册表只有
 * `create/get/list/delete/resolveByPath/insertBefore`，实体只有 `setTitle/attachSession/...`
 * ——**没有任何 setPath/move**。所以「移动」只能由我们自己编排成：
 *
 *   1. 校验落点（名字、父目录、不覆盖、不落在任务根目录里）；
 *   2. 中止该任务名下活着的会话当轮（best-effort，免得 agent 继续往搬走的目录里写）；
 *   3. 搬目录（`rename`；跨卷 EXDEV 时退化成「复制 + 删除」）；
 *   4. 在**新路径**建工作区记录（节点标题默认 = 新目录名，这正是「显式 rename」的语义）；
 *   5. 复刻对话（见 seed.ts：用官方 fork 的种子机制在新 cwd 下重建一条会话）；
 *   6. 按策略归档旧会话 → 删旧工作区记录 → 删本插件的任务记录。
 *
 * 两处必须知道的失败语义：
 *   - **第 3 步是唯一的破坏性动作，且它最早**：它失败时什么都没变（连会话都没动过账目）。
 *     Windows 上活着的会话/终端握着 cwd 时 `rename` 会 EBUSY/EPERM，这一条如实翻译成
 *     `DIR_BUSY` + 「先关掉那个任务的会话/终端再试」。
 *   - **第 4 步失败会把目录搬回去**（best-effort 回滚），避免留下「目录走了、节点没了」的半状态。
 *   - 第 5 步是**尽力而为**：带不上历史不影响转正本身，原因随结果返回给 UI 显示。
 */
import { existsSync } from 'node:fs';
import { cp, rename, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isInsideRoot, normalizeRoot, resolveTaskPath } from './paths.js';
import { buildSeed } from './seed.js';
import { attachSessionToWorkspace, cancelSession, createSessionForDir, isSessionLive, messageOf, mintSessionId, observeSessionSnapshot, } from './sessions.js';
import { archiveSessionQuietly, ensureTaskWorkspace, removeTaskWorkspace, sessionAccountOf, } from './workspaces.js';
import { ERROR_CODES, } from './types.js';
/** 内部错误：带机器可读错误码；对外统一转成 ApiError（本模块不抛错出去）。 */
export class PromoteError extends Error {
    code;
    hint;
    constructor(code, message, hint) {
        super(message);
        this.code = code;
        this.hint = hint;
        this.name = 'PromoteError';
    }
}
/* ─────────────────────────── 名字与落点校验 ─────────────────────────── */
/** Windows 上非法的文件名字符（`:` 只在盘符位置合法，作为目录名一律拒绝）。 */
const INVALID_NAME_CHARS = /[<>:"|?*\u0000-\u001f]/u;
/** Windows 保留设备名（大小写无关；带扩展名也算，例如 `con.txt`）。 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu;
/**
 * 校验「新目录名」。名字同时是新节点标题，所以这里的要求就是文件系统的要求：
 * 单段、非空、不含分隔符/穿越、不是 `.`/`..`、Windows 上还要避开非法字符与保留名。
 */
export function validateName(name) {
    const candidate = name.trim();
    if (candidate.length === 0)
        return '目录名不能为空';
    if (basename(candidate) !== candidate)
        return '目录名只能是单段路径，不能含路径分隔符';
    if (candidate === '.' || candidate === '..')
        return '目录名不能是 . 或 ..';
    if (process.platform === 'win32') {
        if (INVALID_NAME_CHARS.test(candidate))
            return '目录名含 Windows 不允许的字符（< > : " | ? *）';
        if (RESERVED_NAMES.test(candidate))
            return `「${candidate}」是 Windows 保留名`;
        if (/[. ]$/u.test(candidate))
            return '目录名不能以空格或点结尾（Windows 会静默去掉它们）';
    }
    return undefined;
}
/**
 * 目标父目录：必须是**已存在的绝对路径目录**。
 *
 * 为什么不像官方「添加工作区」那样顺手补建缺失的父目录：转正是**不可自动撤销**的搬运
 * （完成之后任务记录就没了，再想挪一次得手工收拾），而"少写/多写一层"是最常见的手误
 * ——把 `D:\work\newproj` 当成父目录会得到 `newproj\<新名>\` 这种套娃，而静默补建恰好把这个
 * 错误藏起来。要新位置就先用官方选择器（「浏览…」里带新建文件夹）或文件管理器建好，
 * 一次点击的代价换"绝不猜你指的是哪一层"。
 */
async function resolveParentDir(parentDir) {
    const trimmed = parentDir.trim();
    if (trimmed.length === 0)
        return '';
    const absolute = resolve(trimmed);
    if (!isAbsolute(absolute))
        throw new PromoteError(ERROR_CODES.badRequest, '目标父目录必须是绝对路径');
    try {
        const info = await stat(absolute);
        if (!info.isDirectory()) {
            throw new PromoteError(ERROR_CODES.badRequest, `目标父目录不是一个目录：${absolute}`, '换一个目录，或把这一项清空后重新填写。');
        }
    }
    catch (error) {
        if (error instanceof PromoteError)
            throw error;
        const code = error.code;
        if (code === 'ENOENT') {
            throw new PromoteError(ERROR_CODES.badRequest, `目标父目录不存在：${absolute}`, '本插件不替你造目录：先用「浏览…」在目标位置新建文件夹（或先在文件管理器里建好），再回来转正。');
        }
        throw new PromoteError(ERROR_CODES.fs, `无法访问目标父目录：${absolute}`, messageOf(error));
    }
    return absolute;
}
/** 目标是否被占用（目录或文件都算占用——本插件绝不覆盖任何东西）。 */
function occupied(path) {
    return existsSync(path);
}
/* ─────────────────────────── 搬目录 ─────────────────────────── */
/** Windows 上「目录被占用」的一族 errno：活着的会话/终端握着 cwd，或权限不足。 */
function isBusyError(error) {
    const code = error.code;
    return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY';
}
/**
 * 把目录搬到新位置。
 *
 * `rename` 是首选（原地、原子、瞬时）；跨卷时 Node 会抛 `EXDEV`，
 * 这时退化成「递归复制 + 删除源」，并如实返回 `copy` 让 UI 能解释耗时。
 */
async function moveDirectory(from, to) {
    try {
        await rename(from, to);
        return 'rename';
    }
    catch (error) {
        const code = error.code;
        if (code === 'EXDEV') {
            try {
                // errorOnExist + force:false：目标已经被我们在上面查过不存在，这里再兜一层。
                await cp(from, to, { recursive: true, errorOnExist: true, force: false });
            }
            catch (copyError) {
                throw new PromoteError(ERROR_CODES.fs, `跨卷复制失败：${from} → ${to}`, messageOf(copyError));
            }
            try {
                await rm(from, { recursive: true, force: true });
            }
            catch (removeError) {
                // 新家已经就位，旧目录删不掉只是留个副本——不算失败，但必须说清楚。
                throw new PromoteError(ERROR_CODES.fs, `已复制到 ${to}，但旧目录删不掉：${from}`, `${messageOf(removeError)}\n新旧两份都在磁盘上；确认新家内容无误后手动删除旧目录即可。`);
            }
            return 'copy';
        }
        if (isBusyError(error)) {
            throw new PromoteError(ERROR_CODES.dirBusy, `搬不动这个目录（被占用）：${from}`, 'Windows 上目录会被「正在使用它的进程」锁住：先关掉该任务的会话与终端（或先结束它正在跑的回合），再重试。');
        }
        throw new PromoteError(ERROR_CODES.fs, `搬目录失败：${from} → ${to}`, messageOf(error));
    }
}
/** 第 4/5 步失败时的回滚：把目录搬回去（best-effort，失败只记日志）。 */
async function rollbackMove(from, to) {
    try {
        await rename(to, from);
        return true;
    }
    catch {
        try {
            await cp(to, from, { recursive: true, errorOnExist: true, force: false });
            await rm(to, { recursive: true, force: true });
            return true;
        }
        catch {
            return false;
        }
    }
}
/**
 * 用官方 fork 的种子机制，把**某条有内容的会话**的已完成前缀复刻成新 cwd 下的一条新会话。
 *
 * 装配顺序逐条对齐官方 `ApiSessionAgentController.create()`：
 *   `agentOptions` ← `ctx.agentDefaultModel.currentSelection()`
 *   `setup`/`agentPreset` ← `ctx.agentPresets.resolve(...)` + `mount(...)`
 * 探测不到的服务就少传一项（会话仍建得起来，只是装配得少一点）。
 *
 * 为什么要传**一串候选会话**（而不是一条）：本插件每次 `/temptask open` 都会在同一个任务目录里
 * 新开一条会话，于是**任务记录里的最后一条常常是空会话**（只有 permission/sandbox 几条事件、
 * 没有 `turn/end`）。用户实测 `2026-10-13-22-41-48` 正是如此：最后一条 0KB、真对话在更早那条
 * （146KB）。只认最后一条的结果就是"转正成功、对话没带过去"——所以这里按候选顺序逐条试，
 * 用**第一条能造出种子的**。
 */
async function carryHistory(deps, candidates, targetCwd, targetWorkspaceId, withHistory) {
    const { ctx } = deps;
    const ids = [...new Set(candidates.filter((id) => typeof id === 'string' && id.length > 0))];
    /** 降级：不带历史地在同一目录建一条会话（官方 sessionController 路径）。 */
    const plain = async (reason) => {
        const created = await createSessionForDir(ctx, targetCwd);
        if (created.sessionId === undefined) {
            return {
                carried: false,
                reason: `${reason === undefined ? '' : `${reason}；`}并且新会话也没建成：${created.reason ?? '未知原因'}`,
            };
        }
        const attached = await attachSessionToWorkspace(ctx, targetWorkspaceId, created.sessionId);
        if (!attached.attached) {
            deps.log('warn', `转正：新会话 ${created.sessionId} 未能挂进新工作区（${attached.reason ?? ''}）`);
        }
        return reason === undefined
            ? { sessionId: created.sessionId, carried: false }
            : { sessionId: created.sessionId, carried: false, reason };
    };
    // 「不带历史」不是「不开会话」：新家总要有一条能立刻用的会话，否则节点是空的。
    if (!withHistory)
        return await plain('按你的选择：不继承旧对话');
    if (ids.length === 0)
        return await plain('原任务没有可继承的会话');
    const query = ctx.get('sessionQuery');
    if (query === undefined || typeof query.observeSession !== 'function') {
        return await plain('当前宿主未提供 sessionQuery，读不到旧会话的事件流');
    }
    /* 逐条试：第一条能造出「已完成前缀」的就是来源（空会话自然被跳过）。 */
    let observed;
    let built;
    let sourceSessionId;
    const skipped = [];
    for (const id of ids) {
        try {
            // 不传 projectionMode：默认投影才有 `agentPreset`（官方 fork 也是这么读来源会话的）。
            // 用完立刻归还租约：观察是引用计数的，逐条试候选时不能把前几条钉在内存里。
            const candidate = await observeSessionSnapshot(query, id);
            const seed = buildSeed(candidate.events);
            if (seed === undefined) {
                skipped.push(id);
                continue;
            }
            observed = candidate;
            built = seed;
            sourceSessionId = id;
            break;
        }
        catch (error) {
            skipped.push(`${id}（${messageOf(error)}）`);
        }
    }
    if (observed === undefined || built === undefined || sourceSessionId === undefined) {
        return await plain(`试了 ${ids.length} 条会话都没有「已完成的一轮对话」可继承` +
            (skipped.length > 0 ? `（${skipped.length} 条为空或读不到）` : ''));
    }
    if (skipped.length > 0) {
        deps.log('info', `转正：跳过 ${skipped.length} 条没有完整回合的会话，改用 ${sourceSessionId} 做种子来源`);
    }
    const agents = ctx.get('agents');
    if (agents === undefined || typeof agents.create !== 'function') {
        return await plain('当前宿主未提供 agents 服务，无法用种子重建会话');
    }
    const sessionId = mintSessionId();
    try {
        const presets = ctx.get('agentPresets');
        const requested = observed.projections?.values.agentPreset;
        let agentPreset;
        let setup;
        if (presets !== undefined && typeof presets.resolve === 'function') {
            try {
                const resolved = await presets.resolve(requested);
                agentPreset = resolved.id;
                if (typeof presets.mount === 'function') {
                    const presetId = resolved.id;
                    setup = async (agentCtx) => {
                        await presets.mount(agentCtx, presetId);
                    };
                }
            }
            catch (error) {
                deps.log('warn', `转正：解析 Agent 预设失败，按默认装配建会话（${messageOf(error)}）`);
            }
        }
        const defaultModel = ctx.get('agentDefaultModel');
        let agentOptions;
        if (defaultModel !== undefined && typeof defaultModel.currentSelection === 'function') {
            try {
                const selection = defaultModel.currentSelection();
                agentOptions = { provider: selection.provider, model: selection.model };
            }
            catch {
                /* 拿不到就用宿主默认 */
            }
        }
        await agents.create({
            sessionId,
            seed: built.seed,
            inheritedEventCount: built.inheritedEventCount,
            meta: {
                cwd: targetCwd,
                parentSession: sourceSessionId,
                isSeeded: true,
                ...(agentPreset === undefined ? {} : { agentPreset }),
            },
            ...(agentOptions === undefined ? {} : { agentOptions }),
            ...(setup === undefined ? {} : { setup }),
        });
    }
    catch (error) {
        return await plain(`用种子重建会话失败：${messageOf(error)}`);
    }
    const attached = await attachSessionToWorkspace(ctx, targetWorkspaceId, sessionId);
    if (!attached.attached) {
        deps.log('warn', `转正：复刻的会话 ${sessionId} 未能挂进新工作区（${attached.reason ?? ''}）`);
        return {
            sessionId,
            carried: true,
            reason: `历史已复刻，但会话未能挂进新节点：${attached.reason ?? '未知原因'}`,
        };
    }
    return {
        sessionId,
        carried: true,
        sourceSessionId,
        ...(observed.projections?.values.title === undefined ||
            observed.projections.values.title === null
            ? {}
            : { sourceTitle: observed.projections.values.title }),
    };
}
/**
 * 把某个任务名下**有内容的会话**的历史，复刻进一个**已经存在**的工作区。
 *
 * 用于修复：早期的转正实现只认任务记录里最后一条会话，遇到"最后一条是空会话"的任务时会
 * 转正成功但历史没带过去（用户实测 `dsh-docs-official` 就是这样：最后一条 0KB、真对话在更早
 * 那条 146KB 的会话里）。旧会话日志仍在磁盘上，所以可以事后补一次——候选里没有完整回合的
 * 会被自动跳过。
 */
export async function replayHistoryIntoWorkspace(deps, candidates, targetCwd, targetWorkspaceId) {
    return await carryHistory(deps, candidates, targetCwd, targetWorkspaceId, true);
}
/* ─────────────────────────── 主流程 ─────────────────────────── */
/**
 * 执行转正。**不抛错**：所有失败都收敛成 `ApiError`。
 *
 * @param view 已由调用方解析好的任务（含工作区标题与它名下的会话账目）。
 */
export async function promoteTask(deps, view, request) {
    const task = view;
    const { ctx } = deps;
    const fail = (error) => {
        if (error instanceof PromoteError) {
            const payload = { ok: false, code: error.code, message: error.message };
            if (error.hint !== undefined)
                payload.hint = error.hint;
            return payload;
        }
        return { ok: false, code: ERROR_CODES.fs, message: messageOf(error) };
    };
    try {
        /* 1) 校验源：记录里的路径必须仍然等于「根目录 + 目录名」（与删除任务同一套三重校验）。 */
        const from = sourcePath(task);
        if (!existsSync(from)) {
            return fail(new PromoteError(ERROR_CODES.missingDir, `任务目录不存在：${from}`, '目录已被手动删除；可在清理里移除这条记录。'));
        }
        /* 2) 校验落点。 */
        const nameIssue = validateName(request.name);
        if (nameIssue !== undefined)
            return fail(new PromoteError(ERROR_CODES.badRequest, nameIssue));
        const name = request.name.trim();
        const parentDir = await resolveParentDir(request.parentDir);
        if (parentDir.length === 0) {
            return fail(new PromoteError(ERROR_CODES.badRequest, '请填写目标父目录', `例如 ${join(deps.home?.() ?? homedir(), 'projects')}`));
        }
        const to = resolve(parentDir, name);
        if (normalizeRoot(to) === normalizeRoot(from)) {
            return fail(new PromoteError(ERROR_CODES.badRequest, '新路径和原路径相同，不需要转正'));
        }
        // 落在任务根目录里是禁止的：adoptSession 会把「cwd 在根目录下的会话」自动登记成临时任务，
        // 于是刚转正的正式工作区会在下一轮会话里被重新变回临时任务（自相矛盾）。
        const taskRoot = taskRootOf(task);
        if (isInsideRoot(taskRoot, to)) {
            return fail(new PromoteError(ERROR_CODES.badRequest, `目标会落在任务根目录里：${to}`, `任务根目录（${taskRoot}）下的一切都会被本插件当成临时任务；请换一个目录，或先改「任务根目录」设置。`));
        }
        if (isInsideRoot(from, to)) {
            return fail(new PromoteError(ERROR_CODES.badRequest, '目标不能放在原任务目录内部'));
        }
        if (occupied(to)) {
            return fail(new PromoteError(ERROR_CODES.targetExists, `目标已存在：${to}`, '本插件绝不覆盖已有内容；换个名字或换个父目录。'));
        }
        /* 3) 会话账目（必须在删工作区记录之前读）+ 中止活着的回合。 */
        const account = sessionAccountOf(ctx, task.workspaceId);
        const sessionIds = account.length > 0 ? account : task.sessionId === undefined ? [] : [task.sessionId];
        let sessionsCanceled = 0;
        for (const sessionId of sessionIds) {
            if (!isSessionLive(ctx, sessionId))
                continue;
            if (await cancelSession(ctx, sessionId))
                sessionsCanceled += 1;
        }
        /* 4) 搬目录（唯一的破坏性动作，且最早：失败则什么都没变）。 */
        const moved = await moveDirectory(from, to);
        /* 5) 新家建工作区记录；失败把目录搬回去，不留半状态。 */
        const ensured = await ensureTaskWorkspace(ctx, to);
        if (!ensured.ok) {
            const rolledBack = await rollbackMove(from, to);
            return fail(new PromoteError(ERROR_CODES.noWorkspace, `${ensured.message}${rolledBack ? '（目录已搬回原位）' : ''}`, rolledBack
                ? ensured.hint
                : `目录现在在 ${to}，但没能建出节点；可在侧边栏手动把该目录添加为工作区。${ensured.hint ?? ''}`));
        }
        const workspace = ensured.workspace;
        /* 6) 复刻对话（尽力而为，不影响转正本身）；不带历史时至少开一条空会话。 */
        // 候选按"新→旧"逐条试：任务记录里最后一条常常是空会话（见 carryHistory 的说明）。
        const carry = await carryHistory(deps, sessionIds.length > 0 ? sessionIds : task.sessionId === undefined ? [] : [task.sessionId], workspace.path, workspace.workspaceId, request.carry);
        /* 7) 按策略处理旧会话。 */
        let sessionsArchived = 0;
        if (deps.policy() === 'archive') {
            for (const sessionId of sessionIds) {
                if (await archiveSessionQuietly(ctx, sessionId))
                    sessionsArchived += 1;
            }
        }
        /* 8) 删旧工作区记录（此时它的会话已经转移或归档）。 */
        const removed = await removeTaskWorkspace(ctx, task.workspaceId);
        if (task.workspaceId !== undefined && !removed.removed) {
            deps.log('warn', `转正：旧工作区记录未能删除（${removed.reason ?? '未知原因'}）`);
        }
        /* 9) 删任务记录（此后它不再是临时任务，也不会被自动清理）。 */
        await deps.forget(task.id);
        deps.log('info', `promoted task ${task.id} → ${to} (history: ${String(carry.carried)}, source: ${carry.sourceSessionId ?? '-'}, archived: ${sessionsArchived}, moved: ${moved})`);
        const result = {
            task: { ...view, sessionIds },
            from,
            to: workspace.path,
            workspaceId: workspace.workspaceId,
            historyCarried: carry.carried,
            sessionsArchived,
            sessionsCanceled,
            moved,
        };
        if (carry.sessionId !== undefined)
            result.sessionId = carry.sessionId;
        if (carry.reason !== undefined)
            result.historyReason = carry.reason;
        return { ok: true, ...result };
    }
    catch (error) {
        return fail(error);
    }
}
/** 源目录：记录里的 path 必须与「根目录 + dirName」解析结果一致（防记录被手改）。 */
function sourcePath(task) {
    const root = taskRootOf(task);
    const expected = resolveTaskPath(root, task.dirName);
    if (normalizeRoot(task.path) !== normalizeRoot(expected)) {
        throw new PromoteError(ERROR_CODES.outsideRoot, `拒绝转正：任务路径与目录名不一致（${task.path} ≠ ${expected}）`);
    }
    if (!isInsideRoot(root, expected) || normalizeRoot(expected) === normalizeRoot(root)) {
        throw new PromoteError(ERROR_CODES.outsideRoot, `拒绝转正：${expected} 不在任务根目录内`);
    }
    return expected;
}
/**
 * 任务根目录 = 任务目录的父目录（任务目录永远是根目录的直接子目录，见 paths.ts 的约定）。
 * 这里**不读配置**：转正针对的是「已存在的那条记录」，而记录里的 path 本身就带着它的根——
 * 用户改过「任务根目录」设置之后，旧任务仍应能被正确转正。
 */
function taskRootOf(task) {
    return normalizeRoot(resolve(task.path, '..'));
}
