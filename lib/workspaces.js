/**
 * dsh-temptask — 临时工作区（= 侧边栏上的任务节点）。
 *
 * 为什么任务要做成工作区：DSH 的会话只能归到「路径与它的 cwd **完全相等**」的工作区下
 * （`WorkspaceEntity.attachSession` 会对 cwd 做 realpath 并硬校验相等），
 * 所以「任务节点 → 它的会话」这棵树唯一可行的实现方式就是：**任务目录本身就是工作区**。
 *
 * 本模块只负责工作区一侧：建/查/改名/删 + 归档会话。
 * 目录与会话的编排在 tasks.ts。
 */
import { mkdir } from 'node:fs/promises';
import { messageOf } from './sessions.js';
function registryOf(ctx) {
    return ctx.get('workspaceRegistry');
}
/**
 * 确保某个目录对应一个任务工作区（幂等）。
 *
 * 顺序很重要：**先建目录 → 再建工作区 → 用工作区回传的归一化路径去建会话**。
 * 反过来做（拿自己拼的路径去建会话）会在路径含符号链接/Junction 时因 realpath 不等而挂载失败。
 */
export async function ensureTaskWorkspace(ctx, path) {
    const registry = registryOf(ctx);
    if (registry === undefined) {
        return {
            ok: false,
            message: '当前宿主未提供 workspaceRegistry，无法把任务做成侧边栏节点',
            hint: '任务目录仍会创建，但不会出现在侧边栏；请升级 DSH 或改用 /temptask list 查看。',
        };
    }
    // create() 要求目标目录已经存在（内部 realpath 会对不存在的路径 ENOENT）。
    try {
        await mkdir(path, { recursive: true });
    }
    catch (error) {
        return { ok: false, message: `无法创建任务目录：${path}`, hint: messageOf(error) };
    }
    try {
        const existing = await registry.resolveByPath(path);
        if (existing !== undefined) {
            return {
                ok: true,
                workspace: {
                    workspaceId: existing.id,
                    path: existing.path,
                    title: existing.title,
                    created: false,
                },
            };
        }
    }
    catch (error) {
        return { ok: false, message: `查找已有工作区失败：${path}`, hint: messageOf(error) };
    }
    try {
        // 不传 title：注册表会用目录 basename（也就是时间戳）当默认标题，
        // 之后只有用户显式 rename 才会变——本插件不会去改写它。
        const created = await registry.create(path);
        return {
            ok: true,
            workspace: {
                workspaceId: created.id,
                path: created.path,
                title: created.title,
                created: true,
            },
        };
    }
    catch (error) {
        return { ok: false, message: `无法为任务创建临时工作区：${path}`, hint: messageOf(error) };
    }
}
/** 读取工作区（用于列表展示与自愈检查）。 */
export function getTaskWorkspace(ctx, workspaceId) {
    return registryOf(ctx)?.get(workspaceId);
}
/** 读取工作区标题（列表展示用；工作区已不存在时返回 undefined）。 */
export function workspaceTitle(ctx, workspaceId) {
    if (workspaceId === undefined || workspaceId.length === 0)
        return undefined;
    try {
        return getTaskWorkspace(ctx, workspaceId)?.title;
    }
    catch {
        return undefined;
    }
}
/**
 * 本模块**刻意不提供**「改节点标题」的能力。
 *
 * 曾经这里有个 `mirrorTitle()`，把 DSH 自动总结的会话标题写回工作区标题。结果是：
 * 每次会话标题刷新（每轮对话都可能发生）都会给侧边栏节点改名一次，还会覆盖用户手动改的名字。
 * DSH 的语义是「工作区标题默认取文件夹 basename，之后只有显式 rename 才变」——
 * 会话标题属于**会话行**，节点名属于目录。所以这条路径被删掉了，而不是留个开关。
 */
/** 删除工作区记录（不删目录、不删会话日志——与 DSH 自己的删除语义一致）。 */
export async function removeTaskWorkspace(ctx, workspaceId) {
    if (workspaceId === undefined || workspaceId.length === 0)
        return { removed: false };
    const registry = registryOf(ctx);
    if (registry === undefined)
        return { removed: false, reason: '宿主未提供 workspaceRegistry' };
    try {
        const removed = await registry.delete(workspaceId);
        return { removed };
    }
    catch (error) {
        return { removed: false, reason: messageOf(error) };
    }
}
/**
 * 该任务工作区名下的**全部**会话（删除前必须用这个，而不是只记着的最后一条）。
 *
 * 依据：`WorkspaceEntity.sessionIds` 按 `sessionPath(id) === path` 过滤 —— 正好等于
 * 「cwd == 这个任务目录」的会话集合。工作区记录一旦删除，这份账目就没了，
 * 所以要在删工作区**之前**读。
 */
export function sessionAccountOf(ctx, workspaceId) {
    if (workspaceId === undefined || workspaceId.length === 0)
        return [];
    try {
        const workspace = getTaskWorkspace(ctx, workspaceId);
        return workspace === undefined ? [] : [...workspace.sessionIds];
    }
    catch {
        return [];
    }
}
/** 归档会话（清理任务时用，免得它的会话掉进「未分组」）。返回是否成功。 */
export async function archiveSessionQuietly(ctx, sessionId) {
    if (sessionId === undefined || sessionId.length === 0)
        return false;
    const registry = registryOf(ctx);
    if (registry === undefined || typeof registry.archiveSession !== 'function')
        return false;
    try {
        await registry.archiveSession(sessionId);
        return true;
    }
    catch {
        /* 归档失败不影响清理本身 */
        return false;
    }
}
