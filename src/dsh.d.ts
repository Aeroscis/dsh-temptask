/**
 * dsh-temptask — DSH 接口的最小环境声明。
 *
 * 为什么需要这个文件：DSH 以「已打包的 JS」发布（`@deepseek-ai/dsh-*` 的 lib/*.js），
 * 包内**不携带 .d.ts**，因此插件无法直接 import 官方类型。这里只声明本插件真正
 * 用到的那些叶子契约——字段与签名逐条抄自当前 DSH 版本的 live Inspect 目录
 * （Service/Event/Slot 目录），不是猜测，也不覆盖未使用的 API。
 *
 * 本文件是全局脚本（无 import/export），因此同时给 host 与 client 提供全局符号。
 */

/* ─────────────────────────── 通用 ─────────────────────────── */

interface DshLogger {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
  debug?(message: string): void;
}

/** Cordis Context：只列出本插件使用的方法。 */
interface DshContext {
  readonly logger?: DshLogger;
  /** 可选服务读取：拿到 undefined 时必须自行降级。 */
  get<T = unknown>(name: string): T | undefined;
  /** 硬依赖注入：依赖出现后才执行回调，随该 fiber 卸载自动回收。 */
  inject(names: string[], callback: (ctx: DshContext) => void | (() => void)): () => void;
  on(event: string, listener: (...args: never[]) => void): () => void;
  effect(callback: () => void | (() => void), label?: string): () => void;
}

/* ─────────────────────── host 服务契约 ─────────────────────── */

/** `ctx.commands` — 人类命令注册表。 */
interface DshCommandResult {
  kind: 'success' | 'error';
  text?: string;
}
interface DshCommandInvocation {
  readonly agent: { readonly id: string };
  readonly rawInput: string;
}
interface DshCommandDefinition {
  name: string;
  description: string;
  input?: { hint: string; attachments?: boolean };
  recordInput?: boolean;
  handler(invocation: DshCommandInvocation): DshCommandResult | Promise<DshCommandResult>;
}
interface DshCommandsService {
  register(definition: DshCommandDefinition): () => void;
}

/** `ctx.webServer` — 浏览器 HTTP 载体。 */
interface DshWebRoute {
  kind: 'exact' | 'prefix';
  path: string;
  handler(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): void | Promise<void>;
}
interface DshWebServerService {
  register(route: DshWebRoute): () => void;
}

/** `ctx.settings` — 官方配置服务（动态 import 的 schema 由 schemastery 提供）。 */
interface DshSettingsScope {
  get(): unknown;
  set(key: string, value: unknown): Promise<void>;
  unset(key: string): Promise<void>;
  watch(callback: () => void): () => void;
  dispose?(): void;
}
interface DshSettingsService {
  readonly writable: boolean;
  register(namespace: string, schema: unknown, options?: { base?: unknown }): DshSettingsScope;
}

/** `ctx.sessionController` — 会话业务面（`ctx.remote.session` 的 host 实现）。 */
interface DshSessionControllerService {
  /**
   * 创建或幂等收养一个普通会话。
   * 传 `cwd` 且不传 `workspaceId` = 「有工作目录、但不绑定任何工作空间」——本插件的核心路径。
   */
  create(request: {
    cwd?: string;
    workspaceId?: string;
    sessionId?: string;
    agentPreset?: string;
  }): Promise<{ sessionId: string; agentPreset?: string }>;
  /**
   * 中止某会话正在进行的回合（UI 上「停止」按钮的同一个入口）。
   * 注意：**不能**用它销毁会话本身——会话对象的生命周期归创建它的 agent 工厂所有。
   */
  cancel?(request: { sessionId: string }): Promise<unknown>;
  /** 宿主桌面能否打开/定位路径（无 GUI 宿主为 false）。 */
  canOpenWorkspacePath?(): boolean;
  /**
   * 在宿主桌面的文件管理器里打开（或 `action: 'reveal'` 定位）一个**路径**。
   * 它接受任意路径、不限于已注册的工作区——本插件用它打开任务根目录。
   */
  openWorkspacePath?(
    request: { path: string; action?: 'reveal' },
    signal?: AbortSignal,
  ): Promise<{ opened: boolean }>;
}

/** `ctx.agents` — agent 注册表与工厂（sessionController 不可用时的降级路径）。 */
interface DshAgentsService {
  create(options: {
    sessionId: string;
    meta?: { cwd?: string; agentPreset?: string };
  }): Promise<{ agent: { readonly id: string } }>;
  get(id: string): unknown;
}

/** `ctx.sessions` — host 侧会话存储。 */
interface DshSessionsService {
  get(id: string): unknown;
  list(): unknown[];
}

/**
 * `ctx.workspaceRegistry` — 持久化工作区注册表。
 * 侧边栏的「工作区节点」就是它；本插件用「目录 == 工作区」把任务做成节点。
 */
interface DshWorkspaceEntity {
  readonly id: string;
  /** realpath 归一化后的路径——会话 cwd 必须与它**完全相等**才能挂载。 */
  readonly path: string;
  readonly title: string;
  readonly sessionIds: string[];
  /** 设置节点标题（本插件不调用它；节点名默认就是目录 basename，改名交给用户/官方 UI）。 */
  setTitle(title: string): Promise<void>;
  /**
   * 把一个已存在的会话挂进本工作区。
   * **硬约束**：会话 `header.cwd` 的 realpath 必须等于 `workspace.path`，否则抛错——
   * 这就是为什么「一个容器工作区 + 多个各自带 cwd 的子会话」在 DSH 里无法表达。
   */
  attachSession(sessionId: string): Promise<void>;
}

interface DshWorkspaceRegistryService {
  /** 路径必须已存在（内部 realpath 归一化；不存在会 ENOENT）。 */
  create(path: string, title?: string): Promise<DshWorkspaceEntity>;
  get(id: string): DshWorkspaceEntity | undefined;
  list(): DshWorkspaceEntity[];
  /** 删除注册表记录（不删目录、不删会话日志）。 */
  delete(id: string): Promise<boolean>;
  resolveByPath(path: string): Promise<DshWorkspaceEntity | undefined>;
  /** 归档会话（清理任务时顺带把它的会话收进归档，而不是丢在「未分组」）。 */
  archiveSession(sessionId: string): Promise<void>;
}

/* 说明：本插件**不使用** `ctx.sessionTitle`。
 * 会话标题由 DSH 自己渲染在会话行上；把它写回工作区标题会让节点每轮改名，
 * 并覆盖用户的手动改名——所以那条路径被显式删掉了（见 workspaces.ts 的注释）。 */

/** `session/created` 与 `session/disposed` 的载荷（只取本插件需要的叶子字段）。 */
interface DshSessionLike {
  readonly id: string;
  readonly header?: { readonly cwd?: string; readonly id?: string };
}

/** `session/event` 的载荷。 */
interface DshSessionEventLike {
  readonly type?: string;
}

/* ─────────────────────── client 契约 ─────────────────────── */

interface DshSlotRegistrationOptions {
  name: string;
  id?: string;
  key?: string;
  order?: number;
  label?: string | (() => string);
  locale?: string;
}
interface DshSlotsService {
  register(
    options: DshSlotRegistrationOptions,
    component: (props: never) => unknown,
  ): () => void;
  inject(key: string, callback: () => (() => void) | void): () => void;
}

interface DshLocaleSnapshot {
  id: string;
}
interface DshLocaleService {
  register(namespace: string, locale: string, dict: Record<string, string>): () => void;
  register(namespace: string, dicts: Record<string, Record<string, string>>): () => void;
  bind(namespace: string): (key: string) => string;
  getLocale?(): DshLocaleSnapshot;
  subscribe?(callback: () => void): () => void;
}

/** 客户端 sessions 服务：`open` 只能打开客户端已知的会话，未知会抛错。 */
interface DshClientSessionsService {
  open(id: string): void;
}

/** 客户端 layout 服务：主面板选择。 */
interface DshLayoutService {
  selectPanel(panelId: string | null): void;
  toggleSidebar(): void;
}

interface DshClientSettingsScope {
  getSnapshot(): { status: string; value?: unknown; writable?: boolean };
  load?(): unknown;
  subscribe?(callback: () => void): () => void;
  set(key: string, value: unknown): Promise<void>;
  unset(key: string): Promise<void>;
  dispose?(): void;
}
interface DshSettingsScopeBinder {
  bind(options: { namespace: string }): DshClientSettingsScope;
}

/* ─────────────────────── 浏览器侧全局 ─────────────────────── */

interface DshModuleLoaderRegistration {
  id: string;
  factory(require: (spec: string) => unknown): unknown;
}
interface Window {
  __ModuleLoader__: {
    load(registration: DshModuleLoaderRegistration): void;
  };
}

/* ─────────────── 可选依赖（动态 import，可能不存在） ─────────────── */

declare module '@deepseek-ai/dsh-settings' {
  /** 把普通命名空间名变成 DSH 认可的 settings namespace 品牌类型（运行期等价）。 */
  export function settingsNamespace(namespace: string): string;
}

declare module '@deepseek-ai/schemastery' {
  /** schemastery 字段：只声明本插件用到的可链式方法。 */
  export interface SchemasteryField {
    default(value: unknown): SchemasteryField;
    description(text: string): SchemasteryField;
  }
  /** schemastery 的 z：本插件只用到最小子集。 */
  export interface SchemaLike {
    object(shape: Record<string, unknown>): unknown;
    string(): SchemasteryField;
    number(): SchemasteryField;
    const<T>(value: T): SchemasteryField;
    union(list: readonly unknown[]): SchemasteryField;
  }
  const z: SchemaLike;
  export default z;
}
