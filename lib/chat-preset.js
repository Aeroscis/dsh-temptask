/**
 * dsh-temptask — 「聊天」preset 的 persona 子插件。
 *
 * 这个 preset 只做一件事：给模型注入当天日期，并且不加载任何工具。
 * 不写「该助手为 DeepSeek Chat，由深度求索公司创造」这种身份句：
 * 聊天模式可以用任意 API 路由，选中别的模型时这句身份就是错的。
 * 只保留网页端同样会注入的动态日期。
 *
 * persona 走 `ctx.systemPrompt.section()` 而不是 `@deepseek-ai/dsh-persona`，
 * 因为这里还要同时注册日期变量；一个子插件注册两样东西，比在 bundle patch
 * 里拼两个包更不容易漏。
 *
 * `complete: true` 会让这一句成为该 preset 的**唯一**系统提示词；
 * `suppressRuntimeContext()` 再去掉可选的运行时上下文（工作目录这种
 * 必需上下文仍会保留，这是宿主的下限，不是本插件能改的）。
 */
/** 日期在提示词里通过这个变量名引用，和 persona 文本里的 `{{…}}` 对应。 */
const CHAT_DATE_VARIABLE = 'temptask_chat_date';
/** 只属于本 preset 的段落名；`complete` 生效后它就是整段系统提示词。 */
const CHAT_PERSONA_SECTION = 'temptask-chat:persona';
export const name = 'dsh-temptask-chat';
/** 等宿主把 `systemPrompt` 服务挂出来再注册；缺失时该子插件保持 pending。 */
export const inject = ['systemPrompt'];
/**
 * 把 Date 渲染成网页端那种中文日期：`2026年11月17日，星期一`。
 *
 * 用 `formatToParts()` 自己拼分隔符，而不是 `format()`：中文 locale 的
 * `format()` 在日期和星期之间没有逗号，而这里要保留网页端的逗号格式。
 *
 * @param date 要渲染的时刻；默认当前时刻。
 * @param timeZone 可选的 IANA 时区；省略时用进程时区。
 * @returns 中文日期；格式化器不可用时退回 `YYYY年M月D日`。
 */
export function formatChatDate(date = new Date(), timeZone) {
    try {
        const parts = new Intl.DateTimeFormat('zh-CN', {
            ...(timeZone === undefined ? {} : { timeZone }),
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            weekday: 'long',
        }).formatToParts(date);
        const pick = (type) => parts.find((part) => part.type === type)?.value;
        const year = pick('year');
        const month = pick('month');
        const day = pick('day');
        const weekday = pick('weekday');
        if (year !== undefined && month !== undefined && day !== undefined && weekday !== undefined) {
            return `${year}年${month}月${day}日，${weekday}`;
        }
    }
    catch {
        /* 时区非法或时刻无效时走下面的兜底 */
    }
    return fallbackDate(date);
}
function fallbackDate(date) {
    try {
        return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
    }
    catch {
        return '';
    }
}
/**
 * 在 preset 作用域里注册日期变量、persona 段落与运行时上下文抑制。
 *
 * 三个注册都挂在 preset 自己的作用域上：它们只影响选了「聊天」的会话，
 * 不影响标准模式等其他 preset。
 */
export function apply(ctx) {
    const prompt = ctx.get('systemPrompt');
    if (prompt === undefined)
        return;
    ctx.effect(() => prompt.variable(CHAT_DATE_VARIABLE, () => formatChatDate()), 'dsh-temptask: chat date variable');
    ctx.effect(() => prompt.section({
        name: CHAT_PERSONA_SECTION,
        order: 0,
        // 只留日期，不写助手身份：模型可能是任意 API 路由。
        text: `今天是{{${CHAT_DATE_VARIABLE}}}。`,
        complete: true,
    }), 'dsh-temptask: chat persona');
    ctx.effect(() => prompt.suppressRuntimeContext(), 'dsh-temptask: chat runtime context');
}
/**
 * 在 agent 创建后把宿主层的全局工具从「聊天」会话里摘掉。
 *
 * 为什么不在 preset 挂载时做：preset 声明是**提前**加载的，挂载它的时候
 * `tool-working-directory` 这类宿主工具行可能还没注册完，`tools.schemas()`
 * 会是空数组——那时 deny 列表为空，限制等于没做。`agent/created` 发生在
 * 所有宿主行都注册之后、agent 被驱动之前，是唯一既能看到完整工具目录、
 * 又还来得及影响第一条模型请求的时点。
 *
 * 由主 host 插件调用（而不是 preset 子插件自己监听）：保证监听器挂在
 * host 作用域，能看到所有 `agent/created`，再用 preset id 过滤出聊天会话。
 *
 * @param ctx host 上下文。
 * @param log 主插件的日志出口；测试/旧宿主可不传。
 */
export function installChatToolRestriction(ctx, log) {
    ctx.inject(['agentPresets', 'tools'], (child) => {
        const presets = child.get('agentPresets');
        const tools = child.get('tools');
        if (presets === undefined || tools === undefined)
            return;
        child.on('agent/created', ({ agent }) => {
            try {
                const presetId = presets.composedPreset?.(agent.ctx)
                    ?? presets.presetForSession?.(agent.session) ?? undefined;
                if (presetId !== 'chat')
                    return;
                const deny = tools.schemas().map((tool) => tool.name);
                if (deny.length === 0)
                    return;
                const scopedTools = agent.ctx.tools;
                if (scopedTools === undefined) {
                    log?.('warn', '聊天模式拿不到 agent 作用域的工具注册表，宿主工具没有隐藏');
                    return;
                }
                scopedTools.restrict({ deny });
                log?.('info', `聊天模式已隐藏宿主工具：${deny.join('、')}`);
            }
            catch (error) {
                // 不把 agent 创建流程一起弄挂；聊天模式退化成“宿主工具仍在”，日志会说明。
                log?.('warn', `聊天模式隐藏宿主工具失败：${String(error)}`);
            }
        });
    });
}
