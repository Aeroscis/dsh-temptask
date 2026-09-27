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
  buildSettingsSchema,
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
import { ERROR_CODES, type ApiResult, type ConfigSource, type TemptaskConfig } from './types.js';

export const name = 'dsh-temptask';
export const version = '0.3.3';

/** 不声明硬依赖：所有服务都按可选处理（见文件头说明）。 */
export const inject: string[] = [];

/** 是否检测到 EAC 桌面版自带的 dsh-side-session（仅提示，不冲突、不禁用）。 */
export function detectSideSession(): boolean {
  try {
    const pluginDir = dirname(dirname(fileURLToPath(import.meta.url))); // <pkg>/lib/host.js → <pkg>
    return existsSync(join(dirname(pluginDir), 'dsh-side-session', 'package.json'));
  } catch {
    return false;
  }
}

export function apply(ctx: DshContext, config?: Partial<TemptaskConfig>): void {
  const rowConfig: Partial<TemptaskConfig> = config ?? {};

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

  /* ── 配置状态（可变，settings 热更新会改写它） ── */
  const initialConfig = normalizeConfigInput(rowConfig);
  let currentConfig: TemptaskConfig = initialConfig;
  let currentSource: ConfigSource = config === undefined ? 'defaults' : 'cordis-row';
  let settingsScope: DshSettingsScope | undefined;
  let settingsReady = false;
  let dataDirNote: string | undefined;

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
      settings: settingsReady,
      webServer: mounted.webServer,
      commands: mounted.commands,
      workspaceRegistry: ctx.get('workspaceRegistry') !== undefined,
      canOpenPath: canOpenPath(ctx),
    }),
  });
  storeWarningSink = (message) => manager.recordWarning(message);

  /** 启动流程：先解析配置（settings → config.json → cordis 行），再载入清单。 */
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
    writeLocalConfig,
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

  /** 官方 settings 命名空间：可用时它拥有配置，否则回落到 config.json。 */
  async function loadSettings(): Promise<void> {
    const settings = ctx.get<DshSettingsService>('settings');
    if (settings === undefined || typeof settings.register !== 'function') {
      log('warn', '本宿主未提供 settings 服务，配置走 config.json');
      return;
    }

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

    const scope = settings.register(settingsNamespace(SETTINGS_NAMESPACE), buildSettingsSchema(z), {
      base: rowConfig,
    });
    settingsScope = scope;
    settingsReady = true;
    currentSource = 'settings';

    const sync = (): void => {
      const value = scope.get();
      const record =
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? (value as Partial<TemptaskConfig>)
          : {};
      const next = normalizeConfigInput({ ...rowConfig, ...record });
      if (next.dataDir !== initialConfig.dataDir) {
        dataDirNote = `dataDir 已改为 ${next.dataDir}，需要重启 DSH 才会切换记录文件位置`;
        log('warn', dataDirNote);
      }
      currentConfig = next;
      log('info', `配置已更新（settings）：rootDir=${next.rootDir}`);
    };
    sync();
    scope.watch(() => {
      try {
        sync();
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

  /** 降级配置：`<pluginDataDir>/config.json`。 */
  async function loadLocalConfig(): Promise<void> {
    const patch = await readConfigFile(configFileIn(initialConfig.dataDir));
    if (patch === undefined) return;
    currentConfig = normalizeConfigInput({ ...rowConfig, ...patch });
    currentSource = 'config-file';
    log('info', `已读取 config.json：rootDir=${currentConfig.rootDir}`);
  }

  /** 写入降级配置（settings 可用时拒绝，并告诉用户去哪里改）。 */
  async function writeLocalConfig(
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
    try {
      const file = configFileIn(initialConfig.dataDir);
      const existing = (await readConfigFile(file)) ?? {};
      const merged: Partial<TemptaskConfig> = { ...rowConfig, ...existing, ...patch };
      await writeJsonAtomic(file, merged);
      currentConfig = normalizeConfigInput(merged);
      currentSource = 'config-file';
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

export default { name, version, inject, apply };
