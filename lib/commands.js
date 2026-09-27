/**
 * dsh-temptask — `/temptask` 命令（host 侧）。
 *
 * `/temptask list | new | open <ID|目录名|标题> | clean [ID|目录名|标题] [--all] [--yes] | help`
 *
 * 定位：侧边栏已经是一棵树（任务节点 → 会话），所以命令是**补充入口**——
 * 用于脚本化、跨 profile 查看、以及不方便点鼠标的时候。
 *
 * 设计要点：
 *   - 参数解析支持引号包裹（例如 `/temptask open "2026-09-27"`）；
 *   - 破坏性操作（clean）必须显式带 `--yes` 才执行——这就是命令通道上的「二次确认」，
 *     第一次调用只打印将要删除的内容；
 *   - `/temptask new` / `/temptask open` 会登记 pendingOpen，前端轮询到后自动切到该会话
 *     （host 命令无法直接操作浏览器 UI）。
 */
import { messageOf } from './sessions.js';
/** 解析 `/temptask` 之后的参数，支持双引号/单引号包裹。 */
export function parseArgs(input) {
    const args = [];
    let current = '';
    let quote;
    let has = false;
    for (const char of input.trim()) {
        if (quote !== undefined) {
            if (char === quote)
                quote = undefined;
            else
                current += char;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            has = true;
            continue;
        }
        if (/\s/u.test(char)) {
            if (has || current.length > 0)
                args.push(current);
            current = '';
            has = false;
            continue;
        }
        current += char;
    }
    if (has || current.length > 0)
        args.push(current);
    return args;
}
function formatTime(value) {
    if (value === undefined)
        return '—';
    const date = new Date(value);
    const pad = (n) => String(n).padStart(2, '0');
    return (`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`);
}
function statusLabel(task) {
    return task.status === 'active' ? '🟢 active' : '⚪ closed';
}
/** 一行的展示名：工作区标题（= 目录 basename，本插件不改写它）；工作区缺失时回落到目录名。 */
function labelOf(task) {
    return task.title !== undefined && task.title.length > 0 ? task.title : task.dirName;
}
function renderTask(task, index) {
    const lines = [
        `${index === undefined ? '•' : `${index + 1}.`} ${labelOf(task)}  [${statusLabel(task)}]`,
        `   ID：${task.id}`,
        `   目录：${task.path}`,
        `   节点：${task.workspacePresent ? (task.workspaceId ?? '—') : '已不存在（可在侧边栏重建）'}`,
        `   创建：${formatTime(task.createdAt)}　最后打开：${formatTime(task.lastOpenedAt)}`,
    ];
    if (task.sessionId !== undefined)
        lines.push(`   会话：${task.sessionId}`);
    return lines.join('\n');
}
function renderError(error) {
    return error.hint === undefined ? `❌ ${error.message}` : `❌ ${error.message}\n   ↳ ${error.hint}`;
}
/** 构造 `/temptask` 命令定义。 */
export function createTaskCommand(deps) {
    const { manager, ready } = deps;
    return {
        name: 'temptask',
        description: '临时任务：在 DSH 自己的目录里开一个隔离的临时工作区+会话（目录名=时间戳，不用起名）',
        input: { hint: '[list | new | open <ID|目录名|标题> | clean [ID|目录名|标题] [--all] [--yes] | help]' },
        async handler(invocation) {
            try {
                await ready;
                // 命令基于「刚读到的磁盘状态」作答：另一个 profile 新建的任务也能列出来。
                await manager.refresh();
                return await handle(invocation.rawInput);
            }
            catch (error) {
                return { kind: 'error', text: `❌ /temptask 执行失败：${messageOf(error)}` };
            }
        },
    };
    async function handle(rawInput) {
        const args = parseArgs(stripCommandName(rawInput));
        const sub = (args[0] ?? 'help').toLowerCase();
        const rest = args.slice(1);
        switch (sub) {
            case 'list':
            case 'ls':
                return { kind: 'success', text: listText() };
            case 'new':
            case 'create':
                return createText();
            case 'open':
                return openText(rest.join(' '));
            case 'clean':
            case 'rm':
            case 'delete':
                return cleanText(rest);
            case 'help':
            case '--help':
            case '-h':
            default:
                return { kind: 'success', text: helpText() };
        }
    }
    function listText() {
        const tasks = manager.listSorted();
        const root = manager.rootDir();
        const warnings = manager.getWarnings();
        const warn = warnings.length > 0 ? `\n\n⚠️ ${warnings.join('\n⚠️ ')}` : '';
        if (tasks.length === 0) {
            return `📋 暂无临时任务（根目录：${root}）\n\n用 /temptask new 创建第一个任务，或点侧边栏底部的「新建临时任务」。${warn}`;
        }
        const body = tasks.map((task, index) => renderTask(task, index)).join('\n\n');
        return (`📋 临时任务（${tasks.filter((task) => task.status === 'active').length} 个 active）\n\n${body}\n\n` +
            `共 ${tasks.length} 个　根目录：${root}\n` +
            `侧边栏里的「任务节点 → 会话」就是这些任务；清理：/temptask clean <ID|目录名|标题> --yes${warn}`);
    }
    async function createText() {
        const result = await manager.create();
        if (!result.ok)
            return { kind: 'error', text: renderError(result) };
        const task = result.task;
        return {
            kind: 'success',
            text: `✅ 已创建临时任务：${labelOf(task)}\n` +
                `   目录：${task.path}（会话 cwd，与其他任务隔离）\n` +
                `   节点：${result.workspaceCreated ? '新建' : '复用'} ${result.workspaceId}\n` +
                `   会话：${result.sessionId}\n` +
                `   已请求前端切到该会话；它也会出现在侧边栏的对应任务节点下。\n` +
                `   无需起名：会话标题由 DSH 根据第一条消息自动总结，节点名保持目录名不动。`,
        };
    }
    async function openText(query) {
        if (query.trim().length === 0) {
            return { kind: 'error', text: '用法：/temptask open <ID|目录名|标题>（可先用 /temptask list 查看）' };
        }
        const result = await manager.open(query.trim());
        if (!result.ok)
            return { kind: 'error', text: renderError(result) };
        const how = result.reused ? '复用已有会话' : '在该目录新建会话';
        return {
            kind: 'success',
            text: `📂 已打开任务：${labelOf(result.task)}（${how}）\n` +
                `   目录：${result.task.path}\n` +
                `   会话：${result.sessionId}`,
        };
    }
    async function cleanText(args) {
        const all = args.some((arg) => arg === '--all' || arg === '-a');
        const confirmed = args.some((arg) => arg === '--yes' || arg === '-y');
        const query = args.filter((arg) => !arg.startsWith('-')).join(' ').trim();
        if (!all && query.length === 0) {
            return {
                kind: 'error',
                text: '用法：/temptask clean <ID|目录名|标题> --yes　或　/temptask clean --all --yes（先不带 --yes 可预览）',
            };
        }
        let ids = [];
        if (all) {
            ids = manager.listSorted().map((task) => task.id);
        }
        else {
            const resolved = manager.resolve(query);
            if ('ok' in resolved)
                return { kind: 'error', text: renderError(resolved) };
            ids = [resolved.task.id];
        }
        if (ids.length === 0)
            return { kind: 'success', text: '📋 没有可清理的任务。' };
        if (!confirmed) {
            const byId = new Map(manager.listSorted().map((task) => [task.id, task]));
            const preview = ids
                .map((id) => byId.get(id))
                .filter((task) => task !== undefined)
                .map((task, index) => renderTask(task, index))
                .join('\n\n');
            return {
                kind: 'success',
                text: `⚠️ 将要删除以下 ${ids.length} 个任务（目录 + 侧边栏节点 + 记录，不可恢复）：\n\n${preview}\n\n` +
                    `确认请重新执行并加上 --yes：\n  /temptask clean ${all ? '--all' : `"${query}"`} --yes`,
            };
        }
        const result = await manager.clean({ ids });
        if (!result.ok)
            return { kind: 'error', text: renderError(result) };
        const failed = result.failed.length > 0
            ? `\n⚠️ 有 ${result.failed.length} 个删除失败：\n` +
                result.failed.map((item) => `   • ${item.id}：${item.message}`).join('\n')
            : '';
        const archivedNote = manager.deleteSessionPolicy === 'archive'
            ? `已归档 ${result.sessionsArchived} 条会话（从侧边栏消失；日志仍在磁盘，DSH 无反归档入口）`
            : '会话按当前设置留在「未分组」（齿轮 → 设置里可改成归档）';
        return {
            kind: 'success',
            text: `🧹 已清理 ${result.removed.length} 个任务（只删除任务根目录下的对应子目录 + 侧边栏节点）。\n` +
                `   会话：${archivedNote}。${failed}`,
        };
    }
    function helpText() {
        return [
            '🗂 临时任务命令',
            '',
            '  /temptask list                       列出全部任务（ID / 目录 / 节点 / 状态 / 时间）',
            '  /temptask new                        新建任务并打开会话（目录名=时间戳，节点名就是它）',
            '  /temptask open <ID|目录名|标题>      打开任务；支持片段匹配，多个匹配会提示消歧',
            '  /temptask clean <ID|目录名|标题>     删除任务目录与节点（先预览，加 --yes 才执行）',
            '  /temptask clean --all --yes          删除全部任务',
            '  /temptask help                       显示本帮助',
            '',
            `任务根目录：${manager.rootDir()}`,
            `任务记录文件：${manager.dataFile}`,
            '',
            '日常使用不必敲命令：侧边栏底部有「新建临时任务」，任务会作为节点出现在侧边栏，',
            '像工作区一样展开就是它的会话；归档/重命名/搜索都用 DSH 自己的界面。',
            '提示：目录名是时间戳，/temptask list 里列出的片段直接粘即可；含空格时用引号，例如 /temptask open "2026-09-27"',
        ].join('\n');
    }
}
/** 命令的 rawInput 一般已是参数部分；万一带了命令名则剥掉。 */
function stripCommandName(rawInput) {
    const text = rawInput.replace(/^\s*\/?temptask\b/u, '').trim();
    return text.length > 0 ? text : rawInput.trim();
}
