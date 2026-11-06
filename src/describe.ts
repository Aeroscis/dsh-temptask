/**
 * dsh-temptask — 从会话里摘出「认得出来」的信息（转正候选列表用）。**只读**。
 *
 * 为什么需要它：临时任务的目录名是时间戳，节点名也是时间戳（本插件刻意不改写工作区标题，
 * 见 workspaces.ts 里那段说明），于是在转正列表里光看时间戳根本认不出"这是哪个对话"。
 *
 * 两个来源，都在一次 `sessionQuery.observeSession()` 里拿到：
 *   1. **标题**走官方投影 —— DSH 自己会把每条会话总结成一个标题，写进 `session/title` 事件，
 *      由 `dsh-session-title` 的 `titleProjectionDefinition`（key 就是 `"title"`）折叠成视图，
 *      所以读 `projections.values.title` 即可。**不自己扫事件猜标题**：标题的生成时机、
 *      用户改名（`source.kind === 'user'` 会钉住）都是官方语义，抄一遍必然漂移。
 *   2. **摘要**扫事件流里的**第一条非空** `user/message`（形状：
 *      `{ data: { content: [{ type: 'text', text }] } }`）。用于标题还没生成、或标题太短认不出人的时候。
 *
 * 读不到（宿主没有 sessionQuery / 会话日志损坏 / 权限）一律返回空对象，调用方降级回时间戳——
 * 这条路绝不能因为"读摘要失败"而让转正本身不可用。
 */
import { observeSessionSnapshot } from './sessions.js';
import type { SeedSourceEvent } from './seed.js';

export interface SessionDescription {
  /** DSH 总结（或被用户改名）的会话标题。 */
  title?: string;
  /** 第一条用户消息的摘要（已压平空白并截断）。 */
  preview?: string;
}

/** 摘要的默认长度上限（列表里一行放得下、又足够认人）。 */
export const PREVIEW_MAX_CHARS = 160;

interface MessageBlock {
  readonly type?: string;
  readonly text?: string;
}

interface UserMessageEvent extends SeedSourceEvent {
  readonly data?: {
    readonly content?: readonly MessageBlock[];
    readonly role?: string;
  };
}

/** 官方投影里的标题（`titleProjectionDefinition` 的 key 是 `"title"`，值可能是 null）。 */
export function projectedTitle(projections: unknown): string | undefined {
  if (projections === null || typeof projections !== 'object') return undefined;
  const values = (projections as { values?: unknown }).values;
  if (values === null || typeof values !== 'object') return undefined;
  const title = (values as Record<string, unknown>)[ 'title' ];
  if (typeof title !== 'string') return undefined;
  const trimmed = title.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** 把一段文本压成单行摘要（空白折叠 + 截断 + 省略号）。 */
export function condense(text: string, maxChars: number = PREVIEW_MAX_CHARS): string | undefined {
  const flat = text.replace(/\s+/gu, ' ').trim();
  if (flat.length === 0) return undefined;
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, Math.max(1, maxChars - 1))}…`;
}

/**
 * 第一条**非空**用户消息的摘要。
 *
 * 为什么要跳过空的：附件消息、只有图片的消息在 `content` 里没有 `text` 块——那种消息
 * 拿来认人毫无用处，继续往后找下一条。
 */
export function firstUserExcerpt(
  events: readonly SeedSourceEvent[],
  maxChars: number = PREVIEW_MAX_CHARS,
): string | undefined {
  for (const event of events) {
    if (event?.type !== 'user/message') continue;
    const content = (event as UserMessageEvent).data?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '')
      .join(' ');
    const condensed = condense(text, maxChars);
    if (condensed !== undefined) return condensed;
  }
  return undefined;
}

/**
 * 读一条会话的标题与摘要。失败一律当成"没有"，不抛错。
 * @param sessionId 目标会话。
 */
export async function describeSession(
  ctx: DshContext,
  sessionId: string | undefined,
): Promise<SessionDescription> {
  if (sessionId === undefined || sessionId.length === 0) return {};
  const query = ctx.get<DshSessionQueryService>('sessionQuery');
  if (query === undefined || typeof query.observeSession !== 'function') return {};
  try {
    // 不传 projectionMode：默认投影才带 title（与 agentPreset 同一条路径）。
    // 用 observeSessionSnapshot 而不是直接 observeSession：它的返回值是租约，
    // 不归还就会把这条会话的日志钉在宿主的观察缓存里（见 sessions.ts）。
    const observed = await observeSessionSnapshot(query, sessionId);
    const description: SessionDescription = {};
    const title = projectedTitle(observed.projections);
    if (title !== undefined) description.title = title;
    const preview = firstUserExcerpt(observed.events as readonly SeedSourceEvent[]);
    if (preview !== undefined) description.preview = preview;
    return description;
  } catch {
    return {};
  }
}

/** 一次任务级"认人"的结果：选中的那条会话 + 它的标题/摘要。 */
export interface TaskDescription extends SessionDescription {
  /** 这些信息取自哪条会话（一个任务名下可能有好几条）。 */
  sessionId?: string;
  /** 实际读过内容的会话条数（日志/调试用）。 */
  scanned: number;
}

/**
 * 一个任务名下挑一条**有内容**的会话，读出标题与摘要。
 *
 * 为什么不能只看 `task.sessionId`：本插件每次 `/temptask open` 都会在同一个任务目录里新开一条会话，
 * 于是**最后一条往往是空会话**（只有 permission/preset、sandbox/mode 这几条），
 * 真正聊过的那条躺在同一个任务目录下更早的会话里。实测用户的任务正是这样：
 * 任务记录指向 4 行的空会话，而它有标题的"兄弟"是 179 行的真对话。
 *
 * 选择顺序（`sessionIds` 是"新→旧"，由 host 组装时保证）：
 *   1. 第一条**有标题**的（标题最能说明"这是什么项目"）；
 *   2. 否则第一条**有摘要**的；
 *   3. 都没有 → 空对象（UI 退回时间戳）。
 *
 * @param sessionIds 该任务名下的会话（新→旧）。
 * @param limit 最多打开几条会话日志（默认 3）——每条都要读一份日志，不能无上限。
 */
export async function describeTaskSessions(
  ctx: DshContext,
  sessionIds: readonly string[],
  limit = 3,
): Promise<TaskDescription> {
  const ids = sessionIds.filter((id) => id.length > 0).slice(0, Math.max(1, limit));
  let withPreview: TaskDescription | undefined;
  let scanned = 0;
  for (const sessionId of ids) {
    const described = await describeSession(ctx, sessionId);
    scanned += 1;
    if (described.title !== undefined) return { ...described, sessionId, scanned };
    if (withPreview === undefined && described.preview !== undefined) {
      withPreview = { ...described, sessionId, scanned };
    }
  }
  if (withPreview !== undefined) return { ...withPreview, scanned };
  return { scanned };
}
