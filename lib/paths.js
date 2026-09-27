/**
 * dsh-temptask — 路径、命名与安全校验。
 *
 * 本模块是纯函数层：不读配置、不写盘（唯一例外是 uniqueDirName 需要探测目录是否已存在）。
 * 所有路径运算都走 `node:path`，不硬编码分隔符。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
/**
 * 平台默认任务根目录：**DSH 自己的目录** `<DSH_HOME>/dsh-temptask`
 * （Windows 即 `C:\Users\<你>\.dsh\dsh-temptask`）。
 */
export function defaultRootDir(home = homedir(), env = process.env) {
    return join(dshHome(home, env), 'dsh-temptask');
}
/** DSH_HOME：环境变量优先，其次 `~/.dsh`。 */
export function dshHome(home = homedir(), env = process.env) {
    const fromEnv = env.DSH_HOME?.trim();
    return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : join(home, '.dsh');
}
/** 插件数据目录默认值：`<DSH_HOME>/plugin-data/dsh-temptask`。 */
export function defaultDataDir(home = homedir(), env = process.env) {
    return join(dshHome(home, env), 'plugin-data', 'dsh-temptask');
}
/** 统一格式化：`YYYY-MM-DD-HH-mm-ss`（本地时间；等价于 taskDirName，给非目录名场景复用）。 */
export function formatStamp(date = new Date()) {
    return taskDirName(date);
}
/**
 * 任务目录名 = 时间戳：`YYYY-MM-DD-HH-mm-ss`（本地时间）。
 *
 * 任务不需要名字：DSH 本来就会用模型自动总结会话标题（显示在会话行上），
 * 而工作区节点名保持目录 basename —— 本插件不去改写它。
 * 目录名只做一件事——保证同一秒内不会撞车（撞车时 uniqueDirName 追加 `-2`）。
 */
export function taskDirName(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return (`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        `-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`);
}
/** 归一化根目录：绝对化并去掉尾部分隔符（保留盘符根 `C:\`）。 */
export function normalizeRoot(rootDir) {
    const absolute = resolve(rootDir.trim());
    if (absolute === sep)
        return absolute;
    return absolute.endsWith(sep) ? absolute.slice(0, -sep.length) : absolute;
}
/** 判断 target 是否位于 rootDir **内部**（不含 rootDir 自身）。 */
export function isInsideRoot(rootDir, target) {
    const root = normalizeRoot(rootDir);
    const candidate = normalizeRoot(target);
    const [a, b] = process.platform === 'win32'
        ? [root.toLowerCase(), candidate.toLowerCase()]
        : [root, candidate];
    if (b === a)
        return false;
    return b.startsWith(a + sep);
}
/**
 * 由（根目录, 目录名）解析出任务绝对路径，并做路径穿越校验。
 * @throws 目录名是绝对路径、含分隔符，或解析结果逃出根目录时抛错。
 */
export function resolveTaskPath(rootDir, dirName) {
    if (dirName.length === 0 || basename(dirName) !== dirName || isAbsolute(dirName)) {
        throw new Error(`非法的任务目录名：${JSON.stringify(dirName)}`);
    }
    const path = resolve(normalizeRoot(rootDir), dirName);
    if (!isInsideRoot(rootDir, path)) {
        throw new Error(`任务路径越界：${path} 不在任务根目录 ${rootDir} 内`);
    }
    return path;
}
/** 目录已存在时追加 `-1`、`-2`…（绝不覆盖已有目录）。 */
export function uniqueDirName(rootDir, base) {
    const root = normalizeRoot(rootDir);
    let candidate = base;
    let index = 1;
    while (existsSync(resolve(root, candidate))) {
        candidate = `${base}-${index}`;
        index += 1;
        if (index > 1000)
            throw new Error(`无法为 ${base} 找到可用目录名（尝试超过 1000 次）`);
    }
    return candidate;
}
/** 供命令层展示的根目录说明。 */
export function describeRoot(rootDir) {
    return rootDir;
}
