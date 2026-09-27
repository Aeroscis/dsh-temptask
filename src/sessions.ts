/**
 * dsh-temptask — 会话创建（host 侧）。
 *
 * 关键事实（来自当前 DSH 版本的 live Inspect 目录与源码）：
 *   - 没有公开的 `session.create` 服务；真正的入口是 `ctx.sessionController`
 *     （即 `ctx.remote.session` 的 host 实现），其 `create()` 明确接受
 *     「只给 cwd、不给 workspaceId」= 有工作目录但不绑定任何工作空间；
 *   - `ctx.sessionController` 内部走 `ctx.agents.create(...)`，agent 归
 *     sessionController 自己的 fiber 所有——因此**不会**随本插件 reload 而被销毁；
 *   - 降级路径 `ctx.agents.create({ sessionId, meta: { cwd } })` 同样可用
 *     （需要自己生成 sessionId），用于 sessionController 缺失的老宿主。
 */
import { randomUUID } from 'node:crypto';

export type SessionCreationVia = 'sessionController' | 'agents' | 'none';

export interface SessionCreation {
  sessionId?: string;
  via: SessionCreationVia;
  /** `via === 'none'` 时的原因，供 UI/命令提示。 */
  reason?: string;
}

/** 生成符合 DSH 习惯的会话 ID。 */
export function mintSessionId(): string {
  return `session-${randomUUID()}`;
}

/**
 * 在指定工作目录创建（或收养）一个**不绑定工作空间**的会话。
 * @param ctx host Cordis 上下文。
 * @param cwd 任务目录绝对路径。
 */
export async function createSessionForDir(
  ctx: DshContext,
  cwd: string,
): Promise<SessionCreation> {
  const controller = ctx.get<DshSessionControllerService>('sessionController');
  if (controller !== undefined && typeof controller.create === 'function') {
    try {
      const created = await controller.create({ cwd });
      const sessionId =
        created !== null && typeof created === 'object' ? String(created.sessionId ?? '') : '';
      if (sessionId.length > 0) return { sessionId, via: 'sessionController' };
      return { sessionId: undefined, via: 'none', reason: 'sessionController 未返回 sessionId' };
    } catch (error) {
      // 创建失败不直接放弃：退到 agents 工厂再试一次，并把首次失败原因带回。
      const fallback = await createViaAgents(ctx, cwd);
      if (fallback.sessionId !== undefined) return fallback;
      return {
        sessionId: undefined,
        via: 'none',
        reason: `sessionController 创建失败：${messageOf(error)}`,
      };
    }
  }

  const fallback = await createViaAgents(ctx, cwd);
  if (fallback.sessionId !== undefined) return fallback;
  return {
    sessionId: undefined,
    via: 'none',
    reason: fallback.reason ?? '当前 DSH 未提供 sessionController / agents 服务',
  };
}

/** 降级：直接用 agents 工厂建会话（自带 cwd，无工作空间）。 */
async function createViaAgents(ctx: DshContext, cwd: string): Promise<SessionCreation> {
  const agents = ctx.get<DshAgentsService>('agents');
  if (agents === undefined || typeof agents.create !== 'function') {
    return { sessionId: undefined, via: 'none', reason: '当前 DSH 未提供 agents 服务' };
  }
  try {
    const sessionId = mintSessionId();
    await agents.create({ sessionId, meta: { cwd } });
    return { sessionId, via: 'agents' };
  } catch (error) {
    return { sessionId: undefined, via: 'none', reason: `agents 创建会话失败：${messageOf(error)}` };
  }
}

/** 会话是否仍活在 host 内存里（决定「打开任务」是复用还是新建）。 */
export function isSessionLive(ctx: DshContext, sessionId: string | undefined): boolean {
  if (sessionId === undefined || sessionId.length === 0) return false;
  const sessions = ctx.get<DshSessionsService>('sessions');
  if (sessions === undefined || typeof sessions.get !== 'function') return false;
  try {
    return sessions.get(sessionId) !== undefined;
  } catch {
    return false;
  }
}

/**
 * 中止会话正在进行的回合（best-effort）。
 *
 * 用在「删除任务时该会话还活着」的场景：先把当轮停下来，再删目录，
 * 免得 agent 继续往一个即将消失的目录里写东西。
 * 注意本函数**不会**销毁会话——会话的生命周期归创建它的 agent 工厂，插件只能取消当轮。
 */
export async function cancelSession(ctx: DshContext, sessionId: string): Promise<boolean> {
  if (sessionId.length === 0) return false;
  const controller = ctx.get<DshSessionControllerService>('sessionController');
  if (controller === undefined || typeof controller.cancel !== 'function') return false;
  try {
    await controller.cancel({ sessionId });
    return true;
  } catch {
    return false;
  }
}

/**
 * 宿主桌面能不能打开文件夹（无 GUI / 没接管文件管理器的宿主返回 false）。
 * UI 据此决定那一行显示「打开根目录」还是退回「复制根目录」。
 */
export function canOpenPath(ctx: DshContext): boolean {
  const controller = ctx.get<DshSessionControllerService>('sessionController');
  if (controller === undefined || typeof controller.canOpenWorkspacePath !== 'function') return false;
  try {
    return controller.canOpenWorkspacePath() === true;
  } catch {
    return false;
  }
}

/**
 * 在宿主的文件管理器里打开一个目录。
 *
 * 用的是官方 `sessionController.openWorkspacePath`——它接受**任意路径**（不是工作区 ID），
 * 所以能直接打开任务根目录；无 GUI 宿主上会失败，调用方据此提示。
 */
export async function openPathInFileManager(
  ctx: DshContext,
  path: string,
): Promise<{ opened: boolean; reason?: string }> {
  const target = path.trim();
  if (target.length === 0) return { opened: false, reason: '路径为空' };
  const controller = ctx.get<DshSessionControllerService>('sessionController');
  if (controller === undefined || typeof controller.openWorkspacePath !== 'function') {
    return { opened: false, reason: '当前宿主未提供 openWorkspacePath' };
  }
  try {
    // 真实实现会立刻 `signal.throwIfAborted()`——**不传 signal 就是
    // "Cannot read properties of undefined (reading 'throwIfAborted')"**。
    // 所以必须给一个真 signal；本次调用不需要取消能力，用一次性 AbortController 即可。
    const abort = new AbortController();
    const result = await controller.openWorkspacePath({ path: target }, abort.signal);
    return { opened: result?.opened === true };
  } catch (error) {
    return { opened: false, reason: messageOf(error) };
  }
}

/**
 * 把会话挂进任务工作区 —— 这一步决定了侧边栏里它归到哪个节点下。
 *
 * DSH 的硬校验：会话 `header.cwd` 的 realpath 必须等于 `workspace.path`。
 * 因此调用方必须先 `workspaceRegistry.create()/resolveByPath()` 拿到**归一化后的路径**，
 * 再用那个路径去建会话（见 workspaces.ts 的 ensureTaskWorkspace）。
 */
export async function attachSessionToWorkspace(
  ctx: DshContext,
  workspaceId: string | undefined,
  sessionId: string,
): Promise<{ attached: boolean; reason?: string }> {
  if (workspaceId === undefined || workspaceId.length === 0) {
    return { attached: false, reason: '任务没有关联工作区' };
  }
  const registry = ctx.get<DshWorkspaceRegistryService>('workspaceRegistry');
  if (registry === undefined) return { attached: false, reason: '宿主未提供 workspaceRegistry' };
  const workspace = registry.get(workspaceId);
  if (workspace === undefined) return { attached: false, reason: `工作区 ${workspaceId} 不存在` };
  try {
    await workspace.attachSession(sessionId);
    return { attached: true };
  } catch (error) {
    return { attached: false, reason: messageOf(error) };
  }
}

/** 统一的错误信息提取。 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
