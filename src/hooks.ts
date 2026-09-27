/**
 * dsh-temptask — DSH 事件钩子（host 侧）。
 *
 * 对应需求「钩子与自动登记」。这里刻意只映射到**真实存在**的事件：
 *
 *   | 需求里的事件        | 本插件使用的真实事件        | 说明 | *   |---------------------|-----------------------------|------|
 *   | `session.created`   | `session/created`           | 载荷是 live Session（取 `id` 与 `header.cwd` 两个叶子字段） |
 *   | `session.closed`    | `session/disposed`          | 会话离开 store 时触发（含发布回滚），据此把任务置为 closed |
 *   | `session.focused`   | `session/event` 的 `user/message` | DSH 事件目录里没有 focused 事件；用户发消息等价于「正在用这个任务」 |
 *   | （无对应需求）      | `session/event` 的 `session/title` | 会话标题由 DSH 自己渲染在**会话行**上；本插件**不**把它写回工作区标题（否则每轮都可能给节点改名，还会覆盖手动改名） |
 *
 * 另外，本插件自己的「打开任务」动作也会刷新 lastOpenedAt（见 tasks.ts）。
 */
import { messageOf } from './sessions.js';
import type { TemptaskManager } from './tasks.js';

export interface HookHandlers {
  onCreate(session: DshSessionLike): void;
  onDisposed(session: DshSessionLike): void;
  onEvent(session: DshSessionLike, event: DshSessionEventLike): void;
}

/** 从任意 live 载荷里安全取出会话 ID（只读叶子字段，不做序列化）。 */
function sessionIdOf(session: DshSessionLike | undefined): string | undefined {
  const id = session?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * 构造三个事件处理器。
 * @param ready 插件启动流程的 promise：清单载入完成前不处理事件，避免与 initialize 的载入互相覆盖。
 */
export function createHookHandlers(
  manager: TemptaskManager,
  ready: Promise<void>,
  log: (level: 'info' | 'warn' | 'error', message: string) => void,
): HookHandlers {
  /** 统一吞掉钩子异常：事件监听器抛错会污染 DSH 自身的发布流程。 */
  const run = (label: string, work: () => Promise<void>): void => {
    void ready
      .then(work)
      .catch((error: unknown) => log('warn', `${label} 处理失败：${messageOf(error)}`));
  };

  return {
    onCreate(session) {
      run('session/created', () => manager.adoptSession(session));
    },
    onDisposed(session) {
      const sessionId = sessionIdOf(session);
      if (sessionId === undefined) return;
      run('session/disposed', () => manager.markSessionClosed(sessionId));
    },
    onEvent(session, event) {
      const type = event?.type;
      // 用户消息：当前 DSH 上最接近 session/focused 的信号 → 刷新 lastOpenedAt
      if (type === 'user/message') {
        const sessionId = sessionIdOf(session);
        if (sessionId !== undefined) {
          run('session/event(user/message)', () => manager.touchSession(sessionId));
        }
        return;
      }
      // 会话标题变化：**本插件不做任何事**。
      // 曾经这里把 DSH 总结的标题写回工作区标题，导致每轮对话都可能给节点改名、
      // 还会覆盖用户手动改的名字——工作区标题应当保持"文件夹名"这一身份。
      // 会话标题照旧由 DSH 渲染在**会话行**上，任务因此仍不需要起名。
      if (type === 'session/title') {
        run('session/event(session/title)', () => manager.onSessionTitleChanged(session));
      }
    },
  };
}

/** 把处理器挂到 ctx 上（返回 disposer 由调用方的 effect 统一回收）。 */
export function registerHooks(ctx: DshContext, handlers: HookHandlers): Array<() => void> {
  return [
    ctx.on('session/created', handlers.onCreate),
    ctx.on('session/disposed', handlers.onDisposed),
    ctx.on('session/event', handlers.onEvent),
  ];
}
