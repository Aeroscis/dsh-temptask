/**
 * dsh-temptask — 「把一段已完成的对话变成新会话的种子」（官方 fork 语义的最小实现）。
 *
 * 为什么需要它：DSH 里工作区分组**就是 cwd 的函数**（`WorkspaceEntity.attachSession` 硬校验
 * 会话 header 的 cwd realpath 等于工作区路径），而会话 header 一旦落盘就**没有任何官方
 * 入口可以改写 cwd**（全库没有 setCwd/updateHeader；JSONL 存储是仅追加的，已提交帧绝不重写）。
 * 所以「把对话搬进新工作区」唯一不触碰别家存储的做法，就是官方 fork 自己那套：
 * 把来源会话的**事件前缀**当作新会话的 `seed`，配上**新的 cwd** 重建一条会话。
 *
 * 与官方的差异只有一个：官方 `sessionController.fork()` 把子会话的 cwd 固定成
 * `source.header.cwd`（`dsh-api-session-controller/lib/index.js` 的 `meta: {...cwd: source.header.cwd}`），
 * 我们把它换成目标路径——其余逐字对齐。
 *
 * 官方 `buildForkSeed()`（`@deepseek-ai/dsh-session/fork`，9 行）做两件事：
 *   1. 取「已完成前缀」`events.slice(0, boundary + 1)`，再补一个 `session/end-seed`（`inherited: true`）；
 *   2. 用 `openTurnClosers(prefix, { kind: 'forked' })` 给**未收尾的尾巴**补合成事件。
 * 第 2 步的实现在 `dsh-session/lib/types/repair.js` 里明确写着「Balanced log (no open tail turn):
 * nothing to close」，而我们的边界**正是**一个收尾过的时间点——所以这一步在我们的场景里
 * 恒为空数组，可以整段省掉；这个前提由 `completedPrefixBoundary()` 保证，不是假设。
 *
 * 为什么不直接 import 官方那两个模块：插件装在 profile 里，那里**解析不到** `@deepseek-ai/dsh-session`
 * （实测 MODULE_NOT_FOUND：profile 的 `@deepseek-ai` 下只有 cosmokit/dsh-brand/schemastery）。
 * 为一个 9 行函数新增一个与宿主同档的重依赖不划算，所以这里照抄语义并把它做成纯函数，
 * 由 smoke 用例盯住（见 scripts/smoke.mjs 的 seed 一节）。
 */

/**
 * 本模块只读事件上的这三个字段，因此不依赖 `@deepseek-ai/dsh-session` 的类型。
 * `seq` 必须等于该事件在数组里的下标——这是 DSH 会话日志的不变式，也是下面
 * 「按 seq 切片」能成立的前提；不满足时我们**拒绝**造种子（调用方降级），而不是猜。
 */
export interface SeedSourceEvent {
  readonly type?: string;
  readonly seq?: number;
  readonly time?: number;
  /** `user/message` 上的表层语义：`append` = 真的用户输入（见官方边界函数的判定）。 */
  readonly surfaceOp?: string;
}

export interface BuiltSeed {
  /** 传给 `ctx.agents.create({ seed })` 的事件数组（新会话据此重建历史）。 */
  seed: Record<string, unknown>[];
  /**
   * 传给 `ctx.agents.create({ inheritedEventCount })` 的值 = 继承进来的事件条数（= boundary + 1）。
   * DSH 用它区分「继承来的前缀」与「这条会话自己产生的事件」。
   */
  inheritedEventCount: number;
}

/**
 * 找到「最后一个已完成回合」的边界（逐字对齐官方 `latestCompletedPrefixBoundary`）。
 *
 * 官方语义：从最后一个 `turn/end` 出发向后吞掉那些**不开启新回合**的事件
 * （心跳、标题、工具结果等），遇到下面三种之一就停：
 *   - `turn/start`（新回合开始了）
 *   - `user/message` 且 `surfaceOp === 'append'`（用户又说话了）
 *   - `agent/inbox/spliced`（收件箱被改写）
 * 找不到任何 `turn/end` 时返回 undefined —— 那意味着这段对话**没有一轮完整结束**，
 * 没有值得继承的边界（例如会话建好后一个字都没说）。
 */
export function completedPrefixBoundary(events: readonly SeedSourceEvent[]): number | undefined {
  let end = -1;
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]?.type === 'turn/end') end = index;
  }
  if (end < 0) return undefined;

  let boundary = end;
  for (let index = end + 1; index < events.length; index += 1) {
    const next = events[index];
    if (next === undefined) break;
    if (
      next.type === 'turn/start' ||
      (next.type === 'user/message' && next.surfaceOp === 'append') ||
      next.type === 'agent/inbox/spliced'
    ) {
      break;
    }
    boundary = index;
  }
  return boundary;
}

/**
 * 由来源会话的完整事件流造一份 fork 种子。
 *
 * @returns 可用的种子；`undefined` = 这段对话没有可继承的已完成前缀（调用方降级为「不带历史」）。
 */
export function buildSeed(events: readonly SeedSourceEvent[]): BuiltSeed | undefined {
  // seq == 下标：官方 fork 也用 `events[boundary].seq !== boundary` 做前置校验，
  // 不成立时那一层会直接抛错。我们这里退回 undefined，让调用方走降级链。
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]?.seq !== index) return undefined;
  }

  const boundary = completedPrefixBoundary(events);
  if (boundary === undefined) return undefined;

  const last = events[boundary];
  if (last === undefined) return undefined;

  const seed: Record<string, unknown>[] = events
    .slice(0, boundary + 1)
    .map((event) => ({ ...(event as Record<string, unknown>) }));
  seed.push({
    type: 'session/end-seed',
    seq: boundary + 1,
    time: last.time,
    data: { inherited: true },
  });

  return { seed, inheritedEventCount: boundary + 1 };
}

/** `buildSeed` 是否可能产出「空历史但有边界」的种子（用于 UI 文案：0 轮对话就别装了）。 */
export function hasInheritableHistory(events: readonly SeedSourceEvent[]): boolean {
  return completedPrefixBoundary(events) !== undefined;
}
