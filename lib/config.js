/**
 * dsh-temptask — 配置解析与持久化。
 *
 * 配置有三个来源，优先级从高到低：
 *   1. DSH 官方 settings 命名空间 `dsh-temptask`（设置页可改，热生效）；
 *   2. 插件数据目录下的 `config.json`（settings 服务不可用时的降级通道）；
 *   3. cordis 补丁行 `config:` 段；
 *   4. 内置默认值。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defaultDataDir, defaultRootDir, normalizeRoot } from './paths.js';
/** 内置默认值（空字符串 = 「按平台/环境推导」，不在这里写死具体路径）。 */
export const CONFIG_DEFAULTS = {
    rootDir: '',
    autoCleanDays: 0,
    dataDir: '',
    onDeleteSessions: 'archive',
};
/** settings 命名空间名，同时用作 config.json 的归属标记。 */
export const SETTINGS_NAMESPACE = 'dsh-temptask';
/** 自动清理天数上限，避免误填把刚关掉的任务删掉。 */
const MAX_AUTO_CLEAN_DAYS = 3650;
function asString(value) {
    return typeof value === 'string' ? value : undefined;
}
function asNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return undefined;
}
/**
 * 归一化任意来源的原始配置：类型收敛 + 空值回落到平台默认。
 * @param raw 合并后的原始字段（可能来自 settings / config.json / cordis 行）。
 * @param platform 注入便于测试。
 */
export function normalizeConfigInput(raw, home, env) {
    const input = raw ?? {};
    const rootDirRaw = asString(input.rootDir)?.trim() ?? '';
    const rootDir = rootDirRaw.length > 0
        ? normalizeRoot(rootDirRaw)
        : normalizeRoot(home === undefined || env === undefined ? defaultRootDir() : defaultRootDir(home, env));
    const autoCleanRaw = asNumber(input.autoCleanDays) ?? CONFIG_DEFAULTS.autoCleanDays;
    const autoCleanDays = Math.min(Math.max(Math.trunc(autoCleanRaw), 0), MAX_AUTO_CLEAN_DAYS);
    const dataDirRaw = asString(input.dataDir)?.trim() ?? '';
    const dataDir = dataDirRaw.length > 0
        ? normalizeRoot(dataDirRaw)
        : home === undefined || env === undefined
            ? normalizeRoot(defaultDataDir())
            : normalizeRoot(defaultDataDir(home, env));
    // 枚举收敛：只有明确写 keep 才用 keep，其余（含拼错/缺失）一律回到默认 archive。
    const onDeleteSessions = input.onDeleteSessions === 'keep' ? 'keep' : 'archive';
    return { rootDir, autoCleanDays, dataDir, onDeleteSessions };
}
/** `tasks.json` / `config.json` 的路径（用 path.join，不硬编码分隔符）。 */
export function storeFileIn(dataDir) {
    return join(dataDir, 'tasks.json');
}
export function configFileIn(dataDir) {
    return join(dataDir, 'config.json');
}
/** 原子写 JSON：先写 `<file>.tmp` 再 rename（同目录 rename 在 Windows/POSIX 都是替换语义）。 */
export async function writeJsonAtomic(file, value) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
}
/** 读取降级配置文件；不存在或损坏都返回 undefined（调用方继续用默认值）。 */
export async function readConfigFile(file) {
    try {
        const text = await readFile(file, 'utf8');
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return undefined;
        return parsed;
    }
    catch {
        return undefined;
    }
}
/** 构造 settings 命名空间的 schema（设置页据此渲染表单）。 */
export function buildSettingsSchema(z) {
    return z.object({
        rootDir: z
            .string()
            .default('')
            .description('任务根目录（空 = 平台默认 <DSH_HOME>/dsh-temptask，不掺进你的工作目录）'),
        autoCleanDays: z
            .number()
            .default(0)
            .description('自动清理：>0 时，启动清理「已关闭且最后打开超过 N 天」的任务（0 = 关闭）'),
        onDeleteSessions: z
            .union([z.const('archive'), z.const('keep')])
            .default('archive')
            .description('删除任务时如何处理它的会话：archive = 归档（默认，从侧边栏消失，日志保留）/ keep = 留在未分组'),
        dataDir: z
            .string()
            .default('')
            .description('插件数据目录（空 = <DSH_HOME>/plugin-data/dsh-temptask）'),
    });
}
