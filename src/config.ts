/**
 * dsh-temptask — 配置解析与持久化。
 *
 * 配置来源按 DSH 版本分两条路：
 *
 * 0.2.0-rc.1 起（本包导出的 `Config` schema = 官方「设置 → 插件」表单）：
 *   1. 插件行的 `config:` 段（由 `configEditor.edit()` 写入 profile 的 cordis 补丁，
 *      官方表单与插件自己的齿轮面板写的是同一处）；
 *   2. 内置默认值。
 *
 * 0.1.x 旧宿主（没有 configEditor，settings 服务是「命名空间注册表」那套）：
 *   1. settings 命名空间 `dsh-temptask`（`ctx.settings.register`）；
 *   2. 插件数据目录下的 `config.json`（settings 服务不可用时的降级通道）；
 *   3. 插件行的 `config:` 段；
 *   4. 内置默认值。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { defaultDataDir, defaultRootDir, normalizeRoot } from './paths.js';
import type { DeleteSessionPolicy, TemptaskConfig } from './types.js';

/** 内置默认值（空字符串 = 「按平台/环境推导」，不在这里写死具体路径）。 */
export const CONFIG_DEFAULTS: TemptaskConfig = {
  rootDir: '',
  autoCleanDays: 0,
  dataDir: '',
  onDeleteSessions: 'archive',
};

/** settings 命名空间名，同时用作 config.json 的归属标记。 */
export const SETTINGS_NAMESPACE = 'dsh-temptask';

/** 自动清理天数上限，避免误填把刚关掉的任务删掉。 */
const MAX_AUTO_CLEAN_DAYS = 3650;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * 归一化任意来源的原始配置：类型收敛 + 空值回落到平台默认。
 * @param raw 合并后的原始字段（可能来自 settings / config.json / cordis 行）。
 * @param platform 注入便于测试。
 */
export function normalizeConfigInput(
  raw: Partial<TemptaskConfig> | undefined,
  home?: string,
  env?: NodeJS.ProcessEnv,
): TemptaskConfig {
  const input = raw ?? {};

  const rootDirRaw = asString(input.rootDir)?.trim() ?? '';
  const rootDir =
    rootDirRaw.length > 0
      ? normalizeRoot(rootDirRaw)
      : normalizeRoot(
          home === undefined || env === undefined ? defaultRootDir() : defaultRootDir(home, env),
        );

  const autoCleanRaw = asNumber(input.autoCleanDays) ?? CONFIG_DEFAULTS.autoCleanDays;
  const autoCleanDays = Math.min(Math.max(Math.trunc(autoCleanRaw), 0), MAX_AUTO_CLEAN_DAYS);

  const dataDirRaw = asString(input.dataDir)?.trim() ?? '';
  const dataDir =
    dataDirRaw.length > 0
      ? normalizeRoot(dataDirRaw)
      : home === undefined || env === undefined
        ? normalizeRoot(defaultDataDir())
        : normalizeRoot(defaultDataDir(home, env));

  // 枚举收敛：只有明确写 keep 才用 keep，其余（含拼错/缺失）一律回到默认 archive。
  const onDeleteSessions: DeleteSessionPolicy =
    input.onDeleteSessions === 'keep' ? 'keep' : 'archive';

  return { rootDir, autoCleanDays, dataDir, onDeleteSessions };
}

/** `tasks.json` / `config.json` 的路径（用 path.join，不硬编码分隔符）。 */
export function storeFileIn(dataDir: string): string {
  return join(dataDir, 'tasks.json');
}

export function configFileIn(dataDir: string): string {
  return join(dataDir, 'config.json');
}

/** 原子写 JSON：先写 `<file>.tmp` 再 rename（同目录 rename 在 Windows/POSIX 都是替换语义）。 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/** 读取降级配置文件；不存在或损坏都返回 undefined（调用方继续用默认值）。 */
export async function readConfigFile(file: string): Promise<Partial<TemptaskConfig> | undefined> {
  try {
    const text = await readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Partial<TemptaskConfig>;
  } catch {
    return undefined;
  }
}

/** schemastery 的最小结构（避免静态 import 一个可选依赖）。 */
export interface SchemasteryField {
  default(value: unknown): SchemasteryField;
  description(text: string): SchemasteryField;
  /**
   * 标记「热更新字段」：DSH 0.2.0-rc.1 起，插件用 Config schema 里的 volatile 字段
   * 声明自己的设置表单，字段值以引用（`.get()`）形式交给插件，改动不需要重启插件。
   * `@deepseek-ai/schemastery` 3.18.4 才有这个方法；旧宿主上没有它，见 `live()`。
   */
  volatile?(): SchemasteryField;
}

export interface SchemasteryLike {
  object(shape: Record<string, unknown>): unknown;
  string(): SchemasteryField;
  number(): SchemasteryField;
  /** 枚举成员（用于「删除策略」这种有限取值，官方设置页会渲成下拉）。 */
  const<T>(value: T): SchemasteryField;
  union(list: readonly unknown[]): SchemasteryField;
}

/** 字段描述文案（官方「设置 → 插件」表单直接显示这些文字）。 */
export const FIELD_DESCRIPTIONS = {
  rootDir: '任务根目录（空 = 平台默认 <DSH_HOME>/dsh-temptask，不掺进你的工作目录）',
  autoCleanDays: '自动清理：>0 时，启动清理「已关闭且最后打开超过 N 天」的任务（0 = 关闭）',
  onDeleteSessions:
    '删除任务时如何处理它的会话：archive = 归档（默认，从侧边栏消失，日志保留）/ keep = 留在未分组',
  dataDir: '插件数据目录（空 = <DSH_HOME>/plugin-data/dsh-temptask）',
} as const;

/**
 * 把字段标记为 volatile —— 但只在宿主真的支持时。
 *
 * `@deepseek-ai/schemastery` 3.18.2（0.1.5-rc.2 宿主附带的那份）**没有** `volatile()`；
 * 无条件调用会让插件在旧宿主上加载即抛错。探测不到就退化成普通字段：新宿主上少了热更新，
 * 但表单与取值语义不变。
 */
function live(field: SchemasteryField): SchemasteryField {
  return typeof field.volatile === 'function' ? field.volatile() : field;
}

/**
 * 构造插件自己的 Config schema（0.2.0-rc.1 起官方「设置 → 插件」表单据此渲染，
 * 也决定 `apply(ctx, config)` 拿到的是「引用」还是「普通值」——见 host.ts 的 `readField`）。
 */
export function buildPluginConfigFields(z: SchemasteryLike): Record<string, unknown> {
  return {
    rootDir: live(z.string().default('').description(FIELD_DESCRIPTIONS.rootDir)),
    autoCleanDays: live(z.number().default(0).description(FIELD_DESCRIPTIONS.autoCleanDays)),
    onDeleteSessions: live(
      z
        .union([z.const('archive'), z.const('keep')])
        .default('archive')
        .description(FIELD_DESCRIPTIONS.onDeleteSessions),
    ),
    dataDir: live(z.string().default('').description(FIELD_DESCRIPTIONS.dataDir)),
  };
}

/**
 * 旧宿主（0.1.x）的 settings 命名空间 schema：同一组字段，但**不带** volatile。
 * 那套 API 是「值文档 + watch」，字段本来就是热生效的，标 volatile 只会给旧加载器
 * 添麻烦（旧 schemastery 根本没有这个方法）。
 */
export function buildLegacySchema(z: SchemasteryLike): unknown {
  return z.object({
    rootDir: z.string().default('').description(FIELD_DESCRIPTIONS.rootDir),
    autoCleanDays: z.number().default(0).description(FIELD_DESCRIPTIONS.autoCleanDays),
    onDeleteSessions: z
      .union([z.const('archive'), z.const('keep')])
      .default('archive')
      .description(FIELD_DESCRIPTIONS.onDeleteSessions),
    dataDir: z.string().default('').description(FIELD_DESCRIPTIONS.dataDir),
  });
}
