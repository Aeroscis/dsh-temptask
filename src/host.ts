/**
 * dsh-temptask — host half（Cordis 插件入口）。
 *
 * 组成：
 *   - TaskStoreFile  : `<pluginDataDir>/tasks.json` 原子持久化（跨进程安全）
 *   - TemptaskManager: 任务业务（目录、工作区、会话、登记、清理）
 *   - hooks          : session/created、session/disposed、session/event
 *   - commands       : /temptask list|new|open|clean|help
 *   - routes         : /dsh-temptask/api/*（client half 的唯一数据通道）
 *
 * 依赖策略：**全部使用可选服务**（`ctx.get` + 缺失即降级），不 declare inject，
 * 这样任一服务缺失时插件仍能加载，并在 UI 里如实显示能力缺失，而不是静默不工作。
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTaskCommand } from './commands.js';
import {
  SETTINGS_NAMESPACE,
  buildLegacySchema,
  buildPluginConfigFields,
  configFileIn,
  normalizeConfigInput,
  readConfigFile,
  storeFileIn,
  writeJsonAtomic,
} from './config.js';
import type { SchemasteryLike } from './config.js';
import { createHookHandlers, registerHooks } from './hooks.js';
import { API_PREFIX, createRoutes, type RouteHost } from './routes.js';
import { canOpenPath, messageOf, openPathInFileManager } from './sessions.js';
import { TaskStoreFile } from './store.js';
import { TemptaskManager } from './tasks.js';
import {
  ERROR_CODES,
  type ApiResult,
  type ConfigSource,
  type DeleteSessionPolicy,
  type TemptaskConfig,
} from './types.js';

export const name = 'dsh-temptask';
export const version = '0.4.0';

/** 不声明硬依赖：所有服务都按可选处理（见文件头说明）。 */
export const inject: string[] = [];

/**
 * 插件自己的 Config schema —— DSH 0.2.0-rc.1 起，官方「设置 → 插件」的表单
 * 就是按各插件条目 Config 里的 volatile 字段投影出来的（`dsh-settings` 的 `volatileForm`），
 * 而 `ctx.settings.register(namespace, schema)` 那套命名空间注册表在新宿主里已经不存在。
 *
 * 因此这里**动态** import schemastery（而不是静态 import）：
 *   - 新宿主的加载器会把 `@deepseek-ai/schemastery` 解析到运行时自带的那份（3.18.4，有 volatile）；
 *   - 离线冒烟测试 / 旧宿主上取不到它时，`Config` 为 undefined，插件照常加载并退化成
 *     「行配置 + config.json」，而不是整个插件加载失败。
 */
const schemastery = await import('@deepseek-ai/schemastery')
  .then((module) => module.default as SchemasteryLike)
  .catch(() => undefined);

/** 没有 schemastery 时导出 undefined：加载器只把有 schema 的条目视为「可表单配置」。 */
export const Config =
  schemastery === undefined ? undefined : schemastery.object(buildPluginConfigFields(schemastery));


/** 是否检测到 EAC 桌面版自带的 dsh-side-session（仅提示，不冲突、不禁用）。 */
export function detectSideSession(): boolean {
  try {
    const pluginDir = dirname(dirname(fileURLToPath(import.meta.url))); // <pkg>/lib/host.js → <pkg>
    return existsSync(join(dirname(pluginDir), 'dsh-side-session', 'package.json'));
  } catch {
    return false;
  }
}

/**
 * 读一个配置字段：DSH 0.2.0-rc.1 起 volatile 字段交到插件手里的是**引用**（`{ get(), … }`），
 * 0.1.x 宿主与声明了 Config 的旧加载器给的是普通值；两种形态都要能吃下。
 */
export function readField(value: unknown): unknown {
  return value !== null &&
    typeof value === 'object' &&
    typeof (value as { get?: unknown }).get === 'function'
    ? (value as { get(): unknown }).get()
    : value;
}

/**
 * 把行配置拍平成普通对象（引用取当前值）。类型收敛交给 `normalizeConfigInput`，
 * 这里只负责去掉「引用」这层壳。
 */
export function rowConfigNow(raw: unknown): Partial<TemptaskConfig> | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const fields = raw as Record<string, unknown>;
  return {
    rootDir: readField(fields['rootDir']) as string | undefined,
    autoCleanDays: readField(fields['autoCleanDays']) as number | undefined,
    onDeleteSessions: readField(fields['onDeleteSessions']) as DeleteSessionPolicy | undefined,
    dataDir: readField(fields['dataDir']) as string | undefined,
  };
}

/**
 * @param ctx Cordis 上下文。
 * @param config 插件行配置：新宿主上是**引用对象**（volatile 字段带 `.get()`），旧宿主上是普通对象。
 */
export function apply(ctx: DshContext, config?: unknown): void {
  /** 行配置原样（0.2.0 上是引用对象）；每次要值时现读，见 `rowConfigNow`。 */
  const rowInput = config;
  /** 首帧的行配置快照：只用来定初始配置与初始来源，之后一律现读。 */
  const initialRowConfig = rowConfigNow(rowInput);

  const log = (level: 'info' | 'warn' | 'error', message: string): void => {
    const logger = ctx.logger;
    if (logger === undefined) return;
    const write = logger[level] ?? logger.info;
    try {
      write?.call(logger, `[dsh-temptask] ${message}`);
    } catch {
      /* 日志失败绝不影响业务 */
    }
  };

  /* ── 配置状态（0.2.0 起字段是活引用：值在「读」的那一刻才取） ── */
  const initialConfig = normalizeConfigInput(initialRowConfig);
  let currentConfig: TemptaskConfig = initialConfig;
  let currentSource: ConfigSource = initialRowConfig === undefined ? 'defaults' : 'cordis-row';
  /** 旧宿主：`ctx.settings.register` 命名空间作用域（新宿主没有这个 API）。 */
  let settingsScope: DshSettingsScope | undefined;
  let settingsReady = false;
  /** 旧宿主：config.json 里读到的补丁（settings 不可用时的降级通道）。 */
  let fileConfig: Partial<TemptaskConfig> | undefined;
  let dataDirNote: string | undefined;

  /**
   * 生效配置 = 「宿主配置层」叠在行配置上。
   *
   * 宿主配置层按宿主能力选择：新宿主用 `configEditor`（官方表单与齿轮面板都写进同一处
   * profile 补丁，Config 引用会自动跟着变），旧宿主用 settings 命名空间或 config.json。
   * 行配置每次**现读**：0.2.0 的 volatile 字段是活引用，官方表单改完值就在引用里，
   * 缓存一份普通对象会让热更新看不见。
   */
  function computeConfig(): TemptaskConfig {
    const row = rowConfigNow(rowInput) ?? {};
    const host = settingsScopeValue() ?? fileConfig;
    return normalizeConfigInput(host === undefined ? row : { ...row, ...host });
  }

  /* ── 持久化与业务核心 ── */
  /** 挂载状态：能力探测必须如实反映，UI 据此提示降级。 */
  const mounted = { webServer: false, commands: false };

  /**
   * 运行期告警出口。
   * TaskStoreFile 必须先于 TaskManager 构造（manager 依赖它），所以用一个可后置填充的
   * 槽位把 store 的告警接到 manager 的告警列表上（面板顶部会显示）。
   */
  let storeWarningSink: ((message: string) => void) | undefined;

  const store = new TaskStoreFile(storeFileIn(initialConfig.dataDir), initialConfig.rootDir, {
    onWarning: (message) => storeWarningSink?.(message),
  });
  const manager = new TemptaskManager({
    ctx,
    store,
    version,
    config: () => currentConfig,
    configSource: () => currentSource,
    log,
    sideSessionDetected: detectSideSession,
    capabilities: () => ({
      sessionController: ctx.get('sessionController') !== undefined,
      agents: ctx.get('agents') !== undefined,
      /**
       * 宿主是否托管本插件配置：
       * 0.1.x = settings 命名空间注册成功；0.2.0-rc.1 起 = 有 configEditor
       * （插件自己的 Config schema 就是官方「设置 → 插件」表单）。
       */
      settings: settingsReady || ctx.get('configEditor') !== undefined,
      webServer: mounted.webServer,
      commands: mounted.commands,
      workspaceRegistry: ctx.get('workspaceRegistry') !== undefined,
      canOpenPath: canOpenPath(ctx),
    }),
  });
  storeWarningSink = (message) => manager.recordWarning(message);

  /** 启动流程：先解析配置（宿主配置层 → 行配置），再载入清单。 */
  const ready = (async (): Promise<void> => {
    try {
      await loadSettings();
    } catch (error) {
      log('warn', `settings 初始化失败，改用 config.json：${messageOf(error)}`);
    }
    if (!settingsReady) {
      try {
        await loadLocalConfig();
      } catch (error) {
        log('warn', `读取 config.json 失败：${messageOf(error)}`);
      }
    }
    currentConfig = computeConfig();
    currentSource = resolveSource();
    try {
      await manager.initialize();
      log(
        'info',
        `v${version} 已就绪：根目录 ${manager.rootDir()}，共 ${store.list().length} 个任务，配置来源 ${currentSource}`,
      );
    } catch (error) {
      // 根目录不可建等致命问题：不阻塞加载，而是把原因显式暴露给 UI 与命令。
      const message = `任务根目录不可用：${messageOf(error)}`;
      manager.recordWarning(message);
      log('error', message);
    }
  })();

  /**
   * 重新读一遍配置（新宿主上官方设置表单改了 Config 引用就会走这里）。
   * 根目录变了要重新载入清单——这是「改完设置立刻生效」的关键一步。
   */
  const refreshConfig = async (): Promise<void> => {
    const next = computeConfig();
    const rootChanged = next.rootDir !== currentConfig.rootDir;
    if (next.dataDir !== currentConfig.dataDir && dataDirNote === undefined) {
      dataDirNote = `dataDir 已改为 ${next.dataDir}，需要重启 DSH 才会切换记录文件位置`;
      log('warn', dataDirNote);
    }
    currentConfig = next;
    currentSource = resolveSource();
    if (rootChanged) {
      await manager.initialize();
      log('info', `配置已更新：根目录 ${next.rootDir}`);
    }
  };

  // 热更新通知：0.2.0 的加载器在 volatile 字段值变化后往插件自己的 ctx 上发这个事件。
  ctx.effect(
    () =>
      ctx.on('loader/volatile-update', () => {
        void ready.then(refreshConfig).catch((error: unknown) => {
          log('warn', `配置热更新处理失败：${messageOf(error)}`);
        });
      }),
    'dsh-temptask: volatile config',
  );

  /* ── 事件钩子 ── */
  const handlers = createHookHandlers(manager, ready, log);
  const hookDisposers = registerHooks(ctx, handlers);
  ctx.effect(
    () => () => {
      for (const dispose of hookDisposers) dispose();
    },
    'dsh-temptask: session hooks',
  );

  /* ── /temptask 命令 ── */
  ctx.inject(['commands'], (sctx) => {
    const commands = sctx.get<DshCommandsService>('commands');
    if (commands === undefined) return;
    const dispose = commands.register(createTaskCommand({ manager, ready }));
    mounted.commands = true;
    log('info', '已注册 /temptask 命令');
    // 副作用挂在**注入子上下文**上：commands 服务消失/替换时随之回收。
    sctx.effect(() => dispose, 'dsh-temptask: /temptask command');
  });

  /* ── HTTP 桥（client half 的数据通道） ── */
  const routeHost: RouteHost = {
    manager,
    ready,
    writeLocalConfig: writeConfig,
    /** 打开任务根目录：用官方 `openWorkspacePath`（它接受任意路径）。 */
    openRoot: async () => {
      const path = manager.rootDir();
      const result = await openPathInFileManager(ctx, path);
      return {
        path,
        opened: result.opened,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      };
    },
    trustedHosts: () => {
      const connection = ctx.get<{ trustedHosts?: unknown }>('connection');
      const hosts = connection?.trustedHosts;
      return Array.isArray(hosts) ? hosts.filter((host): host is string => typeof host === 'string') : [];
    },
    log,
  };

  ctx.inject(['webServer'], (sctx) => {
    const webServer = sctx.get<DshWebServerService>('webServer');
    if (webServer === undefined) return;
    const routes = createRoutes(routeHost);
    const disposers = routes.map((route) =>
      webServer.register({
        kind: 'exact',
        path: route.path,
        handler: (req, res) => route.handle(req, res),
      }),
    );
    log('info', `已挂载 ${routes.length} 条 HTTP 路由（${API_PREFIX}/*）`);
    mounted.webServer = true;
    sctx.effect(
      () => () => {
        for (const dispose of disposers) dispose();
      },
      'dsh-temptask: http routes',
    );
  });

  /* ─────────────────────── 内部实现 ─────────────────────── */

  /** settings 命名空间（旧宿主）当前值；没有就是 undefined（此时由行配置/config.json 说话）。 */
  function settingsScopeValue(): Partial<TemptaskConfig> | undefined {
    if (settingsScope === undefined) return undefined;
    const value = settingsScope.get();
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<TemptaskConfig>)
      : undefined;
  }

  /** 配置来源（UI 据此决定「能不能在齿轮里改」以及把人送去哪里）。 */
  function resolveSource(): ConfigSource {
    if (settingsReady) return 'settings';
    if (fileConfig !== undefined) return 'config-file';
    // configEditor 在 = 这是个「插件配置写 profile 补丁」的宿主（0.2.0-rc.1 起的形态）：
    // 官方「设置 → 插件」表单与齿轮面板写的是同一处。
    if (ctx.get('configEditor') !== undefined) return 'plugin-config';
    return rowConfigNow(rowInput) === undefined ? 'defaults' : 'cordis-row';
  }

  /**
   * 旧宿主的 settings 命名空间（0.2.0-rc.1 已移除这套 API：新宿主用的是
   * 「插件自己的 Config schema + configEditor」）。探测不到就什么都不做。
   */
  async function loadSettings(): Promise<void> {
    const settings = ctx.get<DshSettingsService>('settings');
    if (settings === undefined || typeof settings.register !== 'function') return;

    // 两个可选依赖都用动态 import：缺失时只降级，不让整个插件加载失败。
    let settingsNamespace: ((namespace: string) => string) | undefined;
    let z: SchemasteryLike | undefined;
    try {
      const settingsModule = await import('@deepseek-ai/dsh-settings');
      settingsNamespace = settingsModule.settingsNamespace;
      const schemaModule = await import('@deepseek-ai/schemastery');
      z = schemaModule.default;
    } catch (error) {
      log('warn', `缺少 @deepseek-ai/dsh-settings / schemastery，配置走 config.json：${messageOf(error)}`);
      return;
    }
    if (settingsNamespace === undefined || z === undefined) return;

    const scope = settings.register(settingsNamespace(SETTINGS_NAMESPACE), buildLegacySchema(z), {
      base: rowConfigNow(rowInput) ?? {},
    });
    settingsScope = scope;
    settingsReady = true;
    currentSource = 'settings';

    scope.watch(() => {
      try {
        currentConfig = computeConfig();
        currentSource = resolveSource();
        log('info', `配置已更新（settings）：rootDir=${currentConfig.rootDir}`);
      } catch (error) {
        log('warn', `settings 变更处理失败：${messageOf(error)}`);
      }
    });
    ctx.effect(
      () => () => {
        settingsScope?.dispose?.();
      },
      'dsh-temptask: settings scope',
    );
  }

  /** 降级配置：`<pluginDataDir>/config.json`（旧宿主没有 settings 时，或新宿主写不动 profile 时）。 */
  async function loadLocalConfig(): Promise<void> {
    const patch = await readConfigFile(configFileIn(initialConfig.dataDir));
    if (patch === undefined) return;
    fileConfig = patch;
    log('info', `已读取 config.json：rootDir=${normalizeConfigInput({ ...(rowConfigNow(rowInput) ?? {}), ...patch }).rootDir}`);
  }

  /**
   * 写入插件配置。
   *
   * 三条路，按宿主能力选：
   *   1. 新宿主：`ctx.configEditor.edit()` —— 写进 profile 的 cordis 补丁，
   *      与官方「设置 → 插件」表单同一处，改完加载器会把新值灌进 Config 引用并热更新；
   *   2. 旧宿主的 settings 命名空间：拒绝（并指路）——配置归 settings 文档所有，
   *      插件自己再写一份会互相覆盖；
   *   3. 都没有：`<pluginDataDir>/config.json` 降级通道。
   */
  async function writeConfig(
    patch: Partial<TemptaskConfig>,
  ): Promise<ApiResult<{ config: TemptaskConfig; note?: string }>> {
    if (settingsReady) {
      return {
        ok: false,
        code: ERROR_CODES.badRequest,
        message: '当前配置由 DSH settings 命名空间管理',
        hint: '请在「设置 → 插件 → 临时任务（dsh-temptask）」中修改，改完立即生效。',
      };
    }

    const editor = ctx.get<DshConfigEditorService>('configEditor');
    const entry = ctx.fiber?.entry;
    if (editor !== undefined && typeof editor.edit === 'function' && entry !== undefined) {
      try {
        await editor.edit(entry, (current: unknown) => ({
          ...(current !== null && typeof current === 'object' ? (current as object) : {}),
          ...patch,
        }));
        // 加载器把新值灌进 Config 引用后（必要时会发 volatile-update），这里再同步一次，
        // 保证紧接着返回给客户端的 config 已经是最新值。
        await refreshConfig();
        const result: ApiResult<{ config: TemptaskConfig; note?: string }> = {
          ok: true,
          config: currentConfig,
          ...(dataDirNote === undefined ? {} : { note: dataDirNote }),
        };
        log('info', `插件配置已更新：rootDir=${currentConfig.rootDir}`);
        return result;
      } catch (error) {
        return {
          ok: false,
          code: ERROR_CODES.fs,
          message: '写入插件配置失败',
          hint: messageOf(error),
        };
      }
    }

    try {
      const file = configFileIn(initialConfig.dataDir);
      const existing = (await readConfigFile(file)) ?? {};
      const merged: Partial<TemptaskConfig> = { ...(rowConfigNow(rowInput) ?? {}), ...existing, ...patch };
      await writeJsonAtomic(file, merged);
      fileConfig = merged;
      currentConfig = computeConfig();
      currentSource = resolveSource();
      await mkdir(currentConfig.rootDir, { recursive: true });
      // 重新载入：新根目录、自动清理与清单位置都可能变化。
      await manager.initialize();
      const result: ApiResult<{ config: TemptaskConfig; note?: string }> = {
        ok: true,
        config: currentConfig,
        ...(dataDirNote === undefined ? {} : { note: dataDirNote }),
      };
      log('info', `config.json 已更新：rootDir=${currentConfig.rootDir}`);
      return result;
    } catch (error) {
      return {
        ok: false,
        code: ERROR_CODES.fs,
        message: '写入 config.json 失败',
        hint: messageOf(error),
      };
    }
  }
}

export default { name, version, inject, Config, apply };
