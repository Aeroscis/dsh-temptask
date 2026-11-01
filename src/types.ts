/**
 * dsh-temptask — 共享类型（host 与 client 都编译本文件）。
 *
 * 约束：本文件不得 import 任何 node 内置模块或 host 专属类型，否则 client 包会被污染。
 *
 * 形态说明：一个「临时任务」= 任务根目录下的一个时间戳目录 **+** 指向该目录的一个临时工作区。
 * 因为 DSH 的硬约束是「会话能归到某工作区 ⟺ session.cwd === workspace.path」，
 * 只有把任务目录本身做成工作区，侧边栏才会长成「任务节点 → 它的会话」这棵树。
 * 显示名不归本插件管：节点标题就是工作区标题，而工作区标题默认取**目录 basename**，
 * 之后只有显式 rename 才变（DSH 自己的语义）。DSH 自动总结的会话标题显示在**会话行**上。
 */

/** 任务状态：active = 会话尚在；closed = 会话已销毁（可被自动清理）。 */
export type TaskStatus = 'active' | 'closed';

/** 一条临时任务记录。 */
export interface Task {
  /** 唯一 ID（时间戳 + 随机串，稳定且可读）。 */
  id: string;
  /** 目录名：`YYYY-MM-DD-HH-mm-ss`（任务根目录下的直接子目录名，创建后不可变）。 */
  dirName: string;
  /** 绝对路径 = 任务的临时工作目录 = 工作区路径 = 会话 cwd。 */
  path: string;
  /** 对应的临时工作区 ID（侧边栏那个节点）。 */
  workspaceId?: string;
  /** 创建时间（epoch ms）。 */
  createdAt: number;
  /** 最后一次打开/使用时间（epoch ms）。 */
  lastOpenedAt?: number;
  /** 会话关闭时间（epoch ms）。 */
  closedAt?: number;
  /** 最近一次关联的会话 ID。 */
  sessionId?: string;
  status: TaskStatus;
}

/** tasks.json 的磁盘结构。 */
export interface TaskStore {
  version: 1;
  /** 记录创建时使用的任务根目录（仅作参考，真正生效的是配置）。 */
  rootDir: string;
  tasks: Task[];
}

/** 删除任务时如何处理它的会话。 */
export type DeleteSessionPolicy = 'archive' | 'keep';

/** 插件配置（DSH settings 命名空间 `dsh-temptask` 的字段）。 */
export interface TemptaskConfig {
  /** 任务根目录；空字符串 = `<DSH_HOME>/dsh-temptask`。 */
  rootDir: string;
  /** 自动清理：>0 时，启动清理「已关闭且最后打开时间超过 N 天」的任务。 */
  autoCleanDays: number;
  /** 插件数据目录；空字符串 = `<DSH_HOME>/plugin-data/dsh-temptask`。 */
  dataDir: string;
  /**
   * 删除任务（含自动清理）时对它的会话做什么：
   *   - `archive`（默认）：逐条归档 → 从侧边栏隐藏（日志仍在磁盘；DSH 0.1.7-rc.2 起可取消归档）
   *   - `keep`：什么都不做 → 会话落到官方的「未分组」桶里
   */
  onDeleteSessions: DeleteSessionPolicy;
}

/**
 * 配置的实际来源，决定 UI 该把用户送去哪里改配置。
 *
 *   - `plugin-config`：DSH 0.2.0-rc.1 起插件自己的 Config schema（官方「设置 → 插件」表单，
 *      写进 profile 的 cordis 补丁）；
 *   - `settings`：0.1.x 的 settings 命名空间；
 *   - `config-file`：`<pluginDataDir>/config.json`；
 *   - `cordis-row`：插件行的 `config:` 段（只读）；
 *   - `defaults`：内置默认值。
 */
export type ConfigSource =
  | 'plugin-config'
  | 'settings'
  | 'config-file'
  | 'cordis-row'
  | 'defaults';

/** 由 host 端发起的「请打开这个会话」请求（供 /temptask new、/temptask open 使用）。 */
export interface PendingOpen {
  taskId: string;
  sessionId: string;
  /** 产生时间（epoch ms），客户端超过 TTL 就不再消费。 */
  at: number;
}

/** 运行期能力探测结果，用于 UI 降级提示。 */
export interface TemptaskCapabilities {
  sessionController: boolean;
  agents: boolean;
  /** 宿主是否托管本插件配置（0.1.x 的 settings 命名空间，或 0.2.0-rc.1 起的 configEditor）。 */
  settings: boolean;
  webServer: boolean;
  commands: boolean;
  /** 工作区注册表：缺了它就无法把任务做成侧边栏节点（只能建目录）。 */
  workspaceRegistry: boolean;
  /** 宿主桌面能否在文件管理器里打开路径（决定那一行是"打开根目录"还是"复制根目录"）。 */
  canOpenPath: boolean;
}

/** 列表里的一行：任务记录 + 从工作区注册表读到的展示信息。 */
export interface TaskView extends Task {
  /** 工作区标题（默认 = 目录 basename；本插件不会改写它）；工作区缺失时为 undefined。 */
  title?: string;
  /** 工作区是否仍在注册表里。 */
  workspacePresent: boolean;
  /** 该任务当前的会话是否还活着（运行中）——UI 用它显示「运行中」并在删除时提示会中止当轮。 */
  live: boolean;
  /**
   * 该任务名下的**全部**会话（`workspace.sessionIds` ∪ 记录里的最后一条）。
   *
   * 为什么列表要带上它：侧边栏的会话行菜单（官方槽位 `sidebar.workspaces.session.menu.item`）
   * 只告诉我们一个 sessionId，客户端得据此反查「这条会话属于哪个临时任务」，
   * 才能把「转正」挂到正确的那一行上。工作区记录一删这份账目就没了，因此随 /state 一起发。
   */
  sessionIds: string[];
}

/** `GET /dsh-temptask/api/state` 的返回体。 */
export interface TemptaskState {
  ok: true;
  /**
   * host 半边的插件版本。它的用途很具体：host 代码只在 DSH 启动时加载，
   * 所以「我改了代码但你看到的还是旧行为」几乎总是**没重启**。
   * 把它显示在 UI 上，就不用靠猜。
   */
  pluginVersion: string;
  rootDir: string;
  dataFile: string;
  configSource: ConfigSource;
  config: TemptaskConfig;
  tasks: TaskView[];
  pendingOpen?: PendingOpen;
  warnings: string[];
  capabilities: TemptaskCapabilities;
  /** 是否检测到 EAC 桌面版自带的 dsh-side-session 插件（仅提示，不冲突）。 */
  sideSessionDetected: boolean;
  /** 服务端时间（epoch ms）。 */
  now: number;
  /**
   * 宿主用户目录（`os.homedir()`）——**只给「转正」表单当默认父目录**用。
   * 插件无法猜出用户想把成果放进哪个盘，所以这个值只是输入框的起点，
   * 真正落点由用户在表单里填/选（官方目录选择器）。
   */
  home: string;
}

/** 新建任务的结果：目录、工作区、会话都已经就位。 */
export interface TemptaskCreation {
  task: TaskView;
  sessionId: string;
  workspaceId: string;
  /** 工作区是本次新建的，还是复用了已存在的（同一目录重复创建时）。 */
  workspaceCreated: boolean;
}

/**
 * 转正候选：任务 + 从它的会话里摘出来的「认得出来」的信息。
 *
 * 为什么要有这一层：任务名就是时间戳（本插件刻意不改写工作区标题），列表里光看时间戳
 * 认不出"这是哪个对话"。`sessionTitle` 是 DSH 自己总结（或被用户改名）的标题，
 * `preview` 是第一条用户消息的摘要——两者都由 `describe.ts` 从官方投影/事件流里**只读**取出。
 */
export interface PromoteCandidate extends TaskView {
  /** DSH 总结的会话标题；还没有就是 undefined。 */
  sessionTitle?: string;
  /** 第一条用户消息的摘要（标题缺失或太短时用来认人）。 */
  preview?: string;
  /** 标题/摘要取自哪条会话（一个任务名下可能有好几条，最新那条常是空的）。 */
  describedSessionId?: string;
  /** 该任务名下的会话条数（列表里显示"3 条会话"）。 */
  sessionCount: number;
}

/** `POST /dsh-temptask/api/candidates` 的结果（转正模态打开时取一次）。 */
export interface PromoteCandidates {
  tasks: PromoteCandidate[];
  /** 因为超过上限而没读会话内容的任务数（避免一次读几十条大日志）。 */
  skipped: number;
  /** 宿主能不能读会话内容：不能时 UI 只显示时间戳，并如实说明原因。 */
  describeSessions: boolean;
}

/**
 * 「修复」：把一个**已经存在**的工作区与它的"孤儿"临时会话接上（只读旧日志，复刻成新会话）。
 *
 * 为什么需要它：早期的转正实现只认任务记录里的**最后一条**会话，而本插件每次
 * `/temptask open` 都会在同一个任务目录里新开一条会话——于是"最后一条是空会话"的任务会
 * 转正成功但历史没带过去。旧会话日志仍在磁盘上，所以可以事后补一次。
 */
export interface RepairResult {
  workspaceId: string;
  workspacePath: string;
  /** 新建的会话（带历史）。 */
  sessionId?: string;
  /** 历史来自哪条孤儿会话。 */
  sourceSessionId?: string;
  /** 那条会话的标题（有的话）——让用户确认"补回来的是不是那段对话"。 */
  sourceTitle?: string;
  carried: boolean;
  /** 找到的孤儿会话条数（含被跳过的空会话）。 */
  candidates: number;
  /** 降级/失败原因。 */
  reason?: string;
}

/**
 * 「转正」请求：把某个临时任务变成正式工作区。
 *
 * 三个字段就是用户的全部决策：**叫什么名字、放到哪个父目录、要不要把对话带过去**。
 * 目录名（`name`）同时是新节点的标题——DSH 的工作区标题默认取目录 basename，
 * 这一步正好是「显式 rename」，所以本插件不需要也不应该再调 `setTitle`。
 */
export interface PromoteRequest {
  /** 任务 ID（与 query 二选一，ID 优先）。 */
  id: string;
  /** 任务 ID / 目录名 / 节点标题片段（与 id 二选一）。 */
  query: string;
  /** 新目录名 = 新节点名（同样必须是单段路径，不含分隔符）。 */
  name: string;
  /** 目标父目录（绝对路径；不存在会被拒绝，不会替你造盘符目录）。 */
  parentDir: string;
  /** 是否用官方 fork 的 seed 机制把旧对话复刻进新工作区的会话（默认 true）。 */
  carry: boolean;
  /** 转正完成后是否请求前端打开新会话（默认 true）。 */
  open: boolean;
}

/**
 * 「转正」结果。
 *
 * 注意 `historyCarried` 与 `historyReason`：搬目录一定会成功或整体失败，
 * 但「把对话带过去」是**尽力而为**（见 promote.ts 的降级链），
 * 所以成功响应里也要能把「历史没带上、原因是什么」如实告诉用户。
 */
export interface PromoteResult {
  /** 转正前的任务快照（记录已被移除，所以这是唯一的回执）。 */
  task: TaskView;
  /** 目录从哪来、到哪去（都是归一化后的绝对路径）。 */
  from: string;
  to: string;
  /** 新工作区（正式节点）ID。 */
  workspaceId: string;
  /** 新工作区下那条会话；创建失败时为 undefined。 */
  sessionId?: string;
  historyCarried: boolean;
  historyReason?: string;
  sessionsArchived: number;
  sessionsCanceled: number;
  /** 目录是原地 rename 搬走的，还是跨卷时退化成「复制 + 删除」。 */
  moved: 'rename' | 'copy';
}

/** 统一错误体。 */
export interface ApiError {
  ok: false;
  /** 机器可读错误码，客户端据此做特殊处理（如 MISSING_DIR）。 */
  code: string;
  message: string;
  hint?: string;
}

export type ApiResult<T> = ({ ok: true } & T) | ApiError;

/** 错误码常量（host 抛出、client 判别，双端共享）。 */
export const ERROR_CODES = {
  badRequest: 'BAD_REQUEST',
  notFound: 'TASK_NOT_FOUND',
  ambiguous: 'TASK_AMBIGUOUS',
  missingDir: 'MISSING_DIR',
  outsideRoot: 'OUTSIDE_ROOT',
  noSession: 'SESSION_UNAVAILABLE',
  noWorkspace: 'WORKSPACE_UNAVAILABLE',
  fs: 'FS_ERROR',
  confirm: 'CONFIRM_REQUIRED',
  /** 转正目标已存在（目录/文件占位）——绝不覆盖，要求用户改名。 */
  targetExists: 'TARGET_EXISTS',
  /** 搬目录被占用（Windows 上活着的会话/终端握着 cwd）——错误里会带怎么解决。 */
  dirBusy: 'DIR_BUSY',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
