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
   *   - `archive`（默认）：逐条归档 → 从侧边栏消失（日志仍在磁盘；DSH 没有反归档入口）
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
}

/** 新建任务的结果：目录、工作区、会话都已经就位。 */
export interface TemptaskCreation {
  task: TaskView;
  sessionId: string;
  workspaceId: string;
  /** 工作区是本次新建的，还是复用了已存在的（同一目录重复创建时）。 */
  workspaceCreated: boolean;
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
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
