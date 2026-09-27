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
};
