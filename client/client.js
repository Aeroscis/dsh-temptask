/**
 * dsh-temptask — client half（构建产物，请勿直接编辑）。
 *
 * 源文件：src/client.tsx；构建：pnpm build:client
 * （tsc → build/client/client.js → 本脚本包装成 ModuleLoader 包）。
 *
 * 运行在 DSH Web 页面里，通过 ctx.slots / ctx.locale / ctx.sessions / ctx.layout
 * 与宿主通信，通过 fetch("/dsh-temptask/api/*") 与 host half 通信。
 */
window.__ModuleLoader__.load({
  id: "@aeroscis/dsh-temptask",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");

    /**
     * dsh-temptask — client half（TSX 源文件）。
     *
     * 构建产物：`client/client.js`（ModuleLoader 包，见 scripts/build-client.mjs）。
     *
     * 形态（与用户确认过的 UI 一致）：
     *   - 侧边栏**一行**：自绘的「🗂 临时任务」标记 + 四个小 pushbutton（清理 / 打开或复制根目录 /
     *     说明 / 设置），行内每个字形都是本插件自己画的 SVG（见下面「图标」一节）；
     *     位置在「新建会话」按钮正下方——注册 `order` 取负值，排在官方「插件」面板行（order 0）之前；
     *     **点击标签不会有任何页面**。
     *   - 任务列表不归本插件渲染：每个任务就是一个临时工作区，官方的
     *     WorkspaceBrowser 负责「任务节点 → 它的会话」那棵树（展开/归档/重命名/搜索/拖拽全原生）。
     *   - ? 说明是锚在该行下方的小气泡；垃圾桶按钮是居中确认框；两者都渲染在 `shell.overlay` 浮层里
     *     （不会被侧边栏的滚动容器裁掉，也不会嵌套进官方那个 <button>）。
     *
     * 两个必须知道的实现细节：
     *   1. `sidebar.panellist` 在官方源码里是**导航按钮**（`PanelRow` → `onClick: selectPanel(id)`，
     *      键盘 Enter/Space 也只走它）。所以：行内所有点击都 stopPropagation 拦住导航；
     *      同时注册一个同名 `main` 面板作为兜底——它**渲染 null 并立刻切回 conversation**，
     *      万一行被键盘激活，也只是闪一下，绝不会出现空白页或新页面。
     *      代价：行内那四个小按钮处在官方 `aria-hidden` 的字形槽里，对屏幕阅读器不可见；
     *      同样的动作在「设置 → 插件 → 临时任务」与 `/temptask new|clean` 命令里都可键盘到达。
     *   2. 行文字由本插件渲染（因为要「标签在左、按钮在右」的排布）；注册时给的 `label`
     *      仍然是 i18n thunk，官方用它做 tooltip 与无障碍名。
     *
     * 与 host 的唯一数据通道是 `fetch("/dsh-temptask/api/*")`，见 src/routes.ts。
     */

    const NS = 'dsh-temptask';
    const API = '/dsh-temptask/api';
    /**
     * 客户端半边的版本，与 package.json / host.ts 保持一致（发布时一起改）。
     *
     * 为什么要单独写一个：host 的版本只能证明 **host** 半边刷新了。
     * 纯客户端改动（比如这一版只调了 UI）host 版本号不变，气泡里并排显示两半，
     * 才能判断"到底是哪半边还是旧的"。
     */
    const CLIENT_VERSION = '0.3.3';
    /**
     * `?` 气泡的"鼠标离开后自动收起"延迟（毫秒）。
     * 取值依据：450ms 是「不误收」与「不显得拖沓」之间的取值（600ms 偏慢）。
     */
    const TRAY_AUTO_CLOSE_MS = 450;
    /* ─────────────────────────── 文案 ─────────────────────────── */
    const ZH = {
        nav: '临时任务',
        create: '新建临时任务',
        creating: '创建中…',
        cleanup: '清理临时任务',
        copyRoot: '复制任务根目录',
        openRoot: '打开任务根目录',
        openRootFailed: '打开任务根目录失败',
        openRootHint: '可改用齿轮里的「复制根目录」',
        copied: '已复制根目录',
        copyFailed: '复制失败，请手动复制',
        help: '说明',
        close: '关闭',
        ok: '知道了',
        intro: '每个任务 = DSH 目录下的一个时间戳目录，同时就是一个临时工作区。不需要起名：会话标题由 DSH 根据首条消息自动总结（显示在会话行上），节点名则保持目录名不动。',
        link: '会话在哪',
        linkHint: '左侧任务节点：展开就是它的会话；右键可归档 / 重命名。',
        count: '任务数量',
        rootDir: '任务根目录',
        configSource: '配置来源',
        dataFile: '记录文件',
        versionLabel: '版本',
        hostLabel: '插件后端',
        clientLabel: '插件界面',
        versionHint: '「插件后端」只在 DSH 启动时加载（改了插件要重启 DSH）；「插件界面」刷新页面即更新。两者都是本插件的版本，与 DSH 自身版本无关。',
        versionMismatch: '⚠️ 两半版本不一致：有一半还是旧的——重启 DSH 可让两半同时更新。',
        settingsManaged: 'DSH 设置（设置 → 插件 → 临时任务）',
        fileManaged: '插件数据目录下的 config.json',
        moreSettings: '更多设置 → 设置 → 插件 → 临时任务',
        autoCloseHint: '鼠标移开后自动关闭（再点一次 ? 也会收起）',
        cleanTitle: '清理临时任务',
        cleanBodyArchive: '删除会同时移除任务目录、侧边栏节点与记录（不可恢复）。它的会话会被【归档】——从侧边栏消失；日志仍在磁盘上，但 DSH 没有反归档入口：',
        cleanBodyKeep: '删除会同时移除任务目录、侧边栏节点与记录（不可恢复）。按当前设置，它的会话会【留在「未分组」】（想改成归档：齿轮 → 设置）：',
        liveTag: '运行中',
        liveWarning: '⚠️ 列表里有正在运行的任务（标着「运行中」）：删除它们之前会先中止当轮的对话。',
        policy: '删除任务时',
        policyArchive: '归档会话（推荐）',
        policyKeep: '留在未分组',
        policyArchiveHint: '从侧边栏消失；日志仍在磁盘上（DSH 没有反归档入口）。',
        policyKeepHint: 'DSH 原生行为：会话掉进官方的「未分组」桶，需要你自己收拾。',
        settingsTitle: '临时任务设置',
        settingsSaved: '已保存',
        settingsFailed: '保存失败',
        selectAll: '全选',
        selectNone: '全不选',
        confirmClean: '确认清理',
        cleaning: '清理中…',
        cancel: '取消',
        active: '使用中',
        closed: '已关闭',
        empty: '暂无临时任务',
        missingNode: '节点已不存在',
        created: '已创建临时任务，正在切到它的会话…',
        createFailed: '创建失败',
        settings: '配置',
        save: '保存',
        saved: '已保存',
        saveFailed: '保存失败',
        autoCleanDays: '自动清理天数（0 = 关闭）',
        autoCleanHint: '大于 0 时，插件启动会删除「已关闭且最后打开超过 N 天」的任务',
        sideSessionTitle: '与 dsh-side-session 的区别',
        sideSessionBody: 'dsh-temptask 管的是「临时任务」：目录建在 DSH 自己的目录下、以临时工作区的形态出现在侧边栏、可整体清理；dsh-side-session 面向侧边会话/并行会话。两者可同时使用，行为互不覆盖。',
        sideSessionDetected: '检测到 dsh-side-session 已安装（不影响本插件）。',
        capabilityMissing: '宿主能力缺失',
        capabilitySession: '当前宿主未提供 sessionController/agents，无法新建会话。',
        capabilityWorkspace: '当前宿主未提供 workspaceRegistry，无法把任务做成侧边栏节点。',
    };
    const EN = {
        nav: 'Temporary tasks',
        create: 'New temporary task',
        creating: 'Creating…',
        cleanup: 'Clean up temporary tasks',
        copyRoot: 'Copy task root path',
        openRoot: 'Open task root folder',
        openRootFailed: 'Could not open the task root folder',
        openRootHint: 'Use “Copy task root path” in the gear menu instead',
        copied: 'Root path copied',
        copyFailed: 'Copy failed — copy it manually',
        help: 'About',
        close: 'Close',
        ok: 'Got it',
        intro: 'Each task is a timestamped directory under DSH that is itself a temporary workspace. Nothing needs naming: DSH summarizes the session title from the first message (shown on the session row), while the node keeps its directory name.',
        link: 'Where are the sessions?',
        linkHint: 'Left task nodes: expand for its sessions; right-click to archive or rename.',
        count: 'Tasks',
        rootDir: 'Task root',
        configSource: 'Config source',
        dataFile: 'Record file',
        versionLabel: 'Version',
        hostLabel: 'backend',
        clientLabel: 'UI',
        versionHint: 'The backend half loads only when DSH starts (restart DSH after changing the plugin); the UI half updates on page reload. Both are this plugin\u2019s own versions, unrelated to the DSH version.',
        versionMismatch: '⚠️ Halves disagree — one of them is still the old build. Restarting DSH updates both.',
        settingsManaged: 'DSH settings (Settings → Plugins → Temporary tasks)',
        fileManaged: 'config.json in the plugin data directory',
        moreSettings: 'More settings → Settings → Plugins → Temporary tasks',
        autoCloseHint: 'Closes automatically when the pointer leaves (clicking ? again also collapses it)',
        cleanTitle: 'Clean up temporary tasks',
        cleanBodyArchive: 'This removes the task directory, its sidebar node and its record (irreversible). Its sessions are ARCHIVED — they leave the sidebar; logs stay on disk, and DSH has no un-archive entry:',
        cleanBodyKeep: 'This removes the task directory, its sidebar node and its record (irreversible). With the current setting, its sessions STAY under "Ungrouped" (switch to archiving via the gear → settings):',
        liveTag: 'running',
        liveWarning: '⚠️ The list contains running tasks (tagged “running”): deleting them cancels their current turn first.',
        policy: 'When deleting a task',
        policyArchive: 'Archive its sessions (recommended)',
        policyKeep: 'Leave them ungrouped',
        policyArchiveHint: 'Leaves the sidebar; logs stay on disk (DSH has no un-archive entry).',
        policyKeepHint: 'DSH-native: sessions land in the shipped "Ungrouped" bucket for you to tidy up.',
        settingsTitle: 'Temporary task settings',
        settingsSaved: 'Saved',
        settingsFailed: 'Save failed',
        selectAll: 'All',
        selectNone: 'None',
        confirmClean: 'Clean up',
        cleaning: 'Cleaning…',
        cancel: 'Cancel',
        active: 'in use',
        closed: 'closed',
        empty: 'No temporary tasks yet',
        missingNode: 'node missing',
        created: 'Temporary task created — switching to its session…',
        createFailed: 'Creation failed',
        settings: 'Configuration',
        save: 'Save',
        saved: 'Saved',
        saveFailed: 'Save failed',
        autoCleanDays: 'Auto-clean after N days (0 = off)',
        autoCleanHint: 'When > 0, startup deletes tasks closed for longer than N days',
        sideSessionTitle: 'Difference from dsh-side-session',
        sideSessionBody: 'dsh-temptask owns temporary tasks: directories under DSH\u2019s own folder, shown as temporary workspaces, cleanable as a whole. dsh-side-session is about side/parallel sessions. Both can be enabled at once.',
        sideSessionDetected: 'dsh-side-session detected (no conflict with this plugin).',
        capabilityMissing: 'Missing host capability',
        capabilitySession: 'This host exposes no sessionController/agents, so sessions cannot be created.',
        capabilityWorkspace: 'This host exposes no workspaceRegistry, so tasks cannot become sidebar nodes.',
    };
    /* ─────────────────────────── 样式 ─────────────────────────── */
    const CSS = [
        // 侧边栏那一行：官方行是 flex + padding 7px 8px；这里让标签在左、按钮在右。
        '.__tt_row{display:flex;align-items:center;gap:8px;width:100%;min-width:0}',
        // 宽栏这一行沿用官方「新建会话」按钮的规格（边框 + elevated 底色），避免与侧边栏背景混成一片。
        // 取值逐条抄自官方 .EXfQ3q_newSession：.5px border-l3 + button-elevated-fill + r12 + h38 + padding 8/16。
        '.__tt_rowWide{box-sizing:border-box;min-height:38px;padding:0;gap:0;margin:0 2px 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-button-elevated-fill)}',
        '.__tt_rowWide:hover{background:var(--dsw-alias-button-floating-hover)}',
        // 官方 .panelRow 自带 padding 与 hover 背景，会把边框挤在里面并露出一圈"行背景"——
        // 所以只在含本行的那一行里清掉（:has 限定，不影响其它面板行）。
        // 官方 .panelGlyph 默认 flex:none，只会缩到内容宽度，行内的 width:100% 撑不开，
        // 于是整行不随侧边栏宽度变化。只在含本行的那一行里把它改成可伸展。
        '[class*="panelRow"]:has(.__tt_row) [class*="panelGlyph"]{flex:1 1 auto;min-width:0;justify-content:flex-start}',
        '[class*="panelRow"]:has(.__tt_row){padding:0;background:transparent;min-height:0}',
        '[class*="panelRow"]:has(.__tt_row):hover{background:transparent}',
        // 主区（整块可点 = 新建）+ 右侧次要动作区（竖线分隔）
        '.__tt_primary{display:flex;align-items:center;gap:8px;flex:1;min-width:0;height:100%;padding:8px 12px;border-radius:11px 0 0 11px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;font-weight:500;cursor:pointer}',
        '.__tt_primary:hover:not(.__tt_primaryBusy){background:var(--dsw-alias-button-floating-hover)}',
        '.__tt_primary:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:-2px}',
        '.__tt_primaryBusy{cursor:default;color:var(--dsw-alias-label-tertiary)}',
        '.__tt_primaryRail{justify-content:center;padding:0}',
        '.__tt_primaryLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.__tt_spin{animation:__tt-rot 1s linear infinite}',
        '@keyframes __tt-rot{to{transform:rotate(360deg)}}',
        '.__tt_divider{flex:none;width:1px;height:20px;background:var(--dsw-alias-border-l2)}',
        '.__tt_tinyDanger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary)}',
        '.__tt_rowActions{display:inline-flex;align-items:center;gap:2px;flex:none;padding:0 8px 0 4px}',
        // 小 pushbutton：对齐官方 .iconButton 的观感（28×28 圆形 + hover 背景）
        '.__tt_tiny{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;line-height:1;cursor:pointer}',
        '.__tt_tiny:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.__tt_tiny:disabled{opacity:.45;cursor:default}',
        '.__tt_tinyOk{color:var(--dsw-alias-state-success-primary)}',
        // 浮层里的气泡与确认框
        '.__tt_pop{position:fixed;z-index:90;width:340px;max-height:min(70vh,520px);overflow:auto;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 40px rgba(0,0,0,.28);display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-primary)}',
        '.__tt_popTitle{margin:0;font-size:14px;line-height:22px;font-weight:600}',
        '.__tt_hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
        '.__tt_error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
        '.__tt_kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px;line-height:18px}',
        '.__tt_key{color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
        '.__tt_val{color:var(--dsw-alias-label-secondary);word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
        '.__tt_sep{height:1px;background:var(--dsw-alias-border-l2);margin:2px 0}',
        '.__tt_actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.__tt_btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}',
        '.__tt_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
        '.__tt_btn:disabled{opacity:.45;cursor:default}',
        '.__tt_btnPrimary{border:none;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
        '.__tt_btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
        '.__tt_btnDanger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
        '.__tt_overlay{position:fixed;inset:0;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center;z-index:95}',
        '.__tt_dialog{width:min(520px,calc(100vw - 48px));max-height:calc(100vh - 96px);overflow:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:18px 20px;display:flex;flex-direction:column;gap:12px;box-shadow:0 12px 40px rgba(0,0,0,.28)}',
        '.__tt_dialogTitle{margin:0;font-size:15px;line-height:23px;font-weight:600}',
        '.__tt_dialogActions{display:flex;justify-content:flex-end;gap:8px}',
        '.__tt_list{display:flex;flex-direction:column;gap:4px;max-height:300px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px}',
        '.__tt_item{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px;min-width:0}',
        '.__tt_itemLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.__tt_itemDir{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
        '.__tt_tag{font-size:11px;line-height:16px;padding:0 6px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}',
        '.__tt_tagLive{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
        '.__tt_option{box-sizing:border-box;display:flex;flex-direction:column;gap:2px;width:100%;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}',
        '.__tt_option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
        '.__tt_option:disabled{opacity:.6;cursor:default}',
        '.__tt_optionOn{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-active)}',
        '.__tt_optionHead{display:flex;align-items:center;gap:8px;font-weight:500}',
        '.__tt_radio{width:12px;height:12px;flex:none;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l3)}',
        '.__tt_radioOn{border-color:var(--dsw-alias-brand-primary);box-shadow:inset 0 0 0 3px var(--dsw-alias-brand-primary)}',
        '.__tt_section{max-width:720px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary)}',
        '.__tt_card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}',
        '.__tt_cardTitle{margin:0;font-size:14px;line-height:22px;font-weight:500}',
        '.__tt_field{display:flex;flex-direction:column;gap:6px}',
        '.__tt_label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
        '.__tt_input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px}',
        '.__tt_input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
        // 官方 PanelRow 会把注册时的 `label` 再渲染成一个 title span（排在字形槽之后）。
        // 本行自己画了标签文字，所以**只在本行内**把它隐藏，否则会出现两遍「临时任务」。
        // 用 :has(.__tt_row) 限定作用域，绝不会影响其它面板行；
        // 万一官方改了类名命名格式导致选择器失效，最坏情况也只是文字重复一遍，不会坏功能。
        '[class*="_panelRow"]:has(.__tt_row) [class*="_panelTitle"],[class*="panelRow"]:has(.__tt_row) [class*="panelTitle"]{display:none}',
    ].join('');
    /** 注入插件自有样式（按 data-plugin 标记，便于 HMR/卸载时识别）。 */
    function injectStyles() {
        if (typeof document === 'undefined')
            return;
        if (document.querySelector('style[data-plugin-css="dsh-temptask/main.css"]') !== null)
            return;
        const tag = document.createElement('style');
        tag.dataset.plugin = NS;
        tag.dataset.pluginCss = 'dsh-temptask/main.css';
        tag.textContent = CSS;
        document.head.appendChild(tag);
    }
    /* ─────────────────────────── HTTP 客户端 ─────────────────────────── */
    async function call(path, method, body) {
        try {
            const response = await fetch(`${API}${path}`, {
                method,
                headers: body === undefined ? undefined : { 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
                credentials: 'same-origin',
            });
            if (!response.ok) {
                return { ok: false, code: 'HTTP', message: `HTTP ${response.status} ${response.statusText}` };
            }
            return (await response.json());
        }
        catch (error) {
            return { ok: false, code: 'NETWORK', message: String(error?.message ?? error) };
        }
    }
    /** 一行的展示名：工作区标题（= 目录 basename，本插件不改写它）；缺失时回落到目录名。 */
    function labelOf(task) {
        return task.title !== undefined && task.title.length > 0 ? task.title : task.dirName;
    }
    /**
     * 本插件的后端版本与界面版本是否不一致。
     *
     * 为什么值得单独一个函数：后端（Node 侧）只在 DSH 启动时加载插件代码，而界面是按页面重新
     * 拉取客户端包的——所以两半确实可能一旧一新。拿不到后端版本时不做任何断言（不猜）。
     */
    function halvesDiffer(hostVersion, clientVersion) {
        return hostVersion !== undefined && hostVersion !== clientVersion;
    }
    /**
     * 那第三个按钮该做什么：宿主能打开文件夹就「打开」，否则退回「复制」。
     *
     * 抽成纯函数是为了可测——SSR 里拿不到 /state，组件内的分支测不到，这个判断必须自己可验证。
     */
    function rootAction(canOpenPath) {
        return canOpenPath === true ? 'open' : 'copy';
    }
    function createTray() {
        let state = { panel: 'none', anchor: null };
        const listeners = new Set();
        return {
            get: () => state,
            set(next) {
                state = { ...state, ...next };
                for (const listener of [...listeners])
                    listener();
            },
            subscribe(listener) {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
        };
    }
    /**
     * 下面两个谓词只为一件事：官方注入的是 slot owner props（size/active/…），
     * 而不是 runtime/tray。放宽成「可注入但必须长得对」之后，离线渲染自测就能
     * 直接把 runtime/tray 传进已注册的组件里（既测了组件，也测了注册时的装配）。
     */
    function isRuntime(value) {
        return (typeof value === 'object' && value !== null && typeof value.t === 'function');
    }
    function isTray(value) {
        return (typeof value === 'object' && value !== null && typeof value.get === 'function');
    }
    /** 行首的文件夹字形（刻意不带加号：行尾已有「新建」按钮，加号会撞意）。 */
    function TaskIcon(props) {
        const size = props.size ?? 16;
        return (React.createElement("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
            React.createElement("path", { d: "M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2l1.6 2H18.5A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z" })));
    }
    /**
     * 自绘「临时任务」标记：文件夹 + 小时钟徽标。
     *
     * 为什么要自绘：`＋` 在 28px 里辨识度低；而且窄栏只剩它时，跟官方「新建会话」的气泡加号
     * 几乎分不出来——这一行需要自己的记号。文件夹轮廓沿用官方图标的比例（与全站一致），
     * 右下角加一枚时钟（"有时限的目录" = 临时），16px 下仍能看清。
     */
    function TemporaryTaskMark(props) {
        const size = props.size ?? 16;
        return (React.createElement("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "data-tt-mark": "temporary", "aria-hidden": "true" },
            React.createElement("path", { d: "M1.9 5.3a1.2 1.2 0 0 1 1.2-1.2h2.2l1.1 1.4h4.3a1.2 1.2 0 0 1 1.2 1.2v1" }),
            React.createElement("path", { d: "M1.9 5.3v6.4a1.2 1.2 0 0 0 1.2 1.2h3.2" }),
            React.createElement("circle", { cx: "11.4", cy: "11.4", r: "3.1" }),
            React.createElement("path", { d: "M11.4 9.9v1.6l1.1.6" })));
    }
    /**
     * 统一的 16px 线框外壳：`viewBox` 16、`currentColor` 描边、1.4px 线宽（与「临时任务」标记同一规格）。
     *
     * `data-tt-icon` 是留给离线渲染自测与人工排查的记号：图标改成自绘之后，测试不能再靠宿主图标包的
     * `data-official` 标记来判断"现在用的是哪一枚"。
     */
    function Glyph(props) {
        const size = props.size ?? 16;
        return (React.createElement("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", className: props.className, "data-tt-icon": props.name, "aria-hidden": "true" }, props.children));
    }
    /** 清理：垃圾桶（盖 + 桶身 + 两条竖线）。 */
    function IconTrash(props) {
        return (React.createElement(Glyph, { name: "trash", size: props.size },
            React.createElement("path", { d: "M2.6 4.6h10.8" }),
            React.createElement("path", { d: "M6.3 4.6V3.4a.9.9 0 0 1 .9-.9h1.6a.9.9 0 0 1 .9.9v1.2" }),
            React.createElement("path", { d: "M4.35 4.6l.55 7.9a1.15 1.15 0 0 0 1.15 1.05h3.9a1.15 1.15 0 0 0 1.15-1.05l.55-7.9" }),
            React.createElement("path", { d: "M6.85 6.9v4.35M9.15 6.9v4.35" })));
    }
    /** 打开任务根目录：右上箭头（"甩出去"语义，与官方的外部打开同义）。 */
    function IconRightUp(props) {
        return (React.createElement(Glyph, { name: "open", size: props.size },
            React.createElement("path", { d: "M5.4 10.6 10.6 5.4" }),
            React.createElement("path", { d: "M6.9 5.4h3.7v3.7" })));
    }
    /**
     * 复制（宿主打不开文件夹时的退路，例如浏览器里跑的时候）：前后两张纸。
     *
     * 只画后面那张**露在框外**的部分（上边 + 左上角 + 左边 + 左下角 + 底边的一小截），
     * 否则两张纸的轮廓会在透明背景上互相穿帮。
     */
    function IconCopy(props) {
        return (React.createElement(Glyph, { name: "copy", size: props.size },
            React.createElement("path", { d: "M9.5 6V4.4a1.4 1.4 0 0 0-1.4-1.4H4.1a1.4 1.4 0 0 0-1.4 1.4v4.2a1.4 1.4 0 0 0 1.4 1.4h1.6" }),
            React.createElement("path", { d: "M7.6 6.2h4.6a1.4 1.4 0 0 1 1.4 1.4v4.6a1.4 1.4 0 0 1-1.4 1.4H7.6a1.4 1.4 0 0 1-1.4-1.4V7.6a1.4 1.4 0 0 1 1.4-1.4z" })));
    }
    /** 复制成功：对勾。 */
    function IconCheck(props) {
        return (React.createElement(Glyph, { name: "check", size: props.size },
            React.createElement("path", { d: "M3.4 8.5l3 3 6.2-6.7" })));
    }
    /** 说明：圈起的问号（外圈 + 问号主体一笔 + 圆点）。 */
    function IconQuestion(props) {
        return (React.createElement(Glyph, { name: "help", size: props.size },
            React.createElement("circle", { cx: "8", cy: "8", r: "5.9" }),
            React.createElement("path", { d: "M6.3 6.35a1.7 1.7 0 0 1 3.4 0c0 .95-.6 1.35-1.2 1.75-.3.2-.5.45-.5.85v.55" }),
            React.createElement("path", { d: "M8 11.35v.01" })));
    }
    /**
     * 设置：八齿齿轮 + 中孔。
     *
     * 齿的位置是极坐标算出来的（外圈 R=5.45 / 齿谷 r=3.95，每 45° 一齿、齿顶跨 18°），
     * 所以路径里全是 `A`（圆弧）+ 径向 `L`——手写坐标容易歪，这样至少是几何正确的。
     */
    function IconSettings(props) {
        return (React.createElement(Glyph, { name: "settings", size: props.size },
            React.createElement("path", { d: "M13.38 7.15A5.45 5.45 0 0 1 13.38 8.85L11.90 8.62A3.95 3.95 0 0 1 11.20 10.32L12.41 11.20A5.45 5.45 0 0 1 11.20 12.41L10.32 11.20A3.95 3.95 0 0 1 8.62 11.90L8.85 13.38A5.45 5.45 0 0 1 7.15 13.38L7.38 11.90A3.95 3.95 0 0 1 5.68 11.20L4.80 12.41A5.45 5.45 0 0 1 3.59 11.20L4.80 10.32A3.95 3.95 0 0 1 4.10 8.62L2.62 8.85A5.45 5.45 0 0 1 2.62 7.15L4.10 7.38A3.95 3.95 0 0 1 4.80 5.68L3.59 4.80A5.45 5.45 0 0 1 4.80 3.59L5.68 4.80A3.95 3.95 0 0 1 7.38 4.10L7.15 2.62A5.45 5.45 0 0 1 8.85 2.62L8.62 4.10A3.95 3.95 0 0 1 10.32 4.80L11.20 3.59A5.45 5.45 0 0 1 12.41 4.80L11.20 5.68A3.95 3.95 0 0 1 11.90 7.38Z" }),
            React.createElement("circle", { cx: "8", cy: "8", r: "2.05" })));
    }
    /** 创建中：缺口圆环（外层套 `__tt_spin` 旋转；不需要任何 keyframes 之外的资源）。 */
    function IconSpinner(props) {
        return (React.createElement(Glyph, { name: "busy", size: props.size, className: "__tt_spin" },
            React.createElement("circle", { cx: "8", cy: "8", r: "5.4", opacity: "0.3" }),
            React.createElement("path", { d: "M8 2.6a5.4 5.4 0 0 1 5.4 5.4" })));
    }
    /**
     * 动作按钮的字形表。
     *
     * 为什么是自绘，而不是去 require 宿主的图标包（`@deepseek-ai/dsh-client-ui-primitives`）：
     * 那个包在 0.1.7-rc.2 里把图标导出名从 `<Name>Outline<尺寸>`（`IconTrashOutline16`）改成了
     * `<Name>OutlineRegular|Medium`，于是同一份插件代码在 0.1.5 宿主上拿到线框图标、
     * 在 0.1.7 宿主上 `pick()` 全部落空、静默降级成 🧹 📂 ? ⚙。自绘之后宿主怎么改名都与本插件无关，
     * 代价是观感要自己对齐官方（16px、currentColor、1.4px 线宽）。
     */
    const ICONS = {
        loading: IconSpinner,
        trash: IconTrash,
        external: IconRightUp,
        copy: IconCopy,
        check: IconCheck,
        question: IconQuestion,
        settings: IconSettings,
    };
    /**
     * 面板行内容：`🗂 临时任务` │ 四个自绘图标按钮（清理 / 打开或复制根目录 / 说明 / 设置）。
     *
     * 唯一职责是把「标签 + 四个动作」画出来并把点击拦住——**不导航、不出页面**。
     * 所有弹层都由浮层里的 TemptaskTray 呈现（避免嵌套进官方那个 <button>）。
     */
    function TemptaskRow(props) {
        const { runtime, tray } = props;
        const wide = (props.size ?? 16) === 16;
        const [busy, setBusy] = React.useState(false);
        const [copied, setCopied] = React.useState(false);
        const [canOpen, setCanOpen] = React.useState(undefined);
        const copyTimer = React.useRef(undefined);
        React.useEffect(() => () => {
            if (copyTimer.current !== undefined)
                clearTimeout(copyTimer.current);
        }, []);
        // 三号按钮是「打开」还是「复制」，取决于宿主桌面能否打开文件夹 → 挂载时问一次宿主能力。
        // 拿不到之前按「复制」渲染（SSR / 老宿主都安全）。
        React.useEffect(() => {
            let alive = true;
            void call('/state', 'GET').then((result) => {
                if (alive && result.ok) {
                    setCanOpen(result.capabilities.canOpenPath);
                }
            });
            return () => {
                alive = false;
            };
        }, []);
        /** 统一拦住事件：官方行是导航按钮，任何点击都不该冒泡到它。 */
        const swallow = (event) => {
            event.stopPropagation();
        };
        const anchorOf = (target) => {
            const rect = target instanceof HTMLElement ? target.getBoundingClientRect() : undefined;
            if (rect === undefined)
                return { left: 12, top: 120 };
            return {
                left: Math.max(12, rect.left - 6),
                top: rect.bottom + 8,
                source: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
            };
        };
        const create = async (event) => {
            swallow(event);
            if (busy)
                return;
            setBusy(true);
            const result = await call('/create', 'POST', {});
            setBusy(false);
            if (!result.ok) {
                const message = result.hint === undefined ? result.message : `${result.message}（${result.hint}）`;
                tray.set({ panel: 'notice', anchor: anchorOf(event.currentTarget), message });
                return;
            }
            runtime.notice(runtime.t('created'));
            runtime.openSession(result.sessionId);
        };
        const copyRoot = async (event) => {
            swallow(event);
            const state = await call('/state', 'GET');
            const root = state.ok ? state.rootDir : '';
            try {
                await navigator.clipboard.writeText(root);
                setCopied(true);
                if (copyTimer.current !== undefined)
                    clearTimeout(copyTimer.current);
                copyTimer.current = setTimeout(() => setCopied(false), 1500);
                runtime.notice(runtime.t('copied'));
            }
            catch {
                tray.set({ panel: 'notice', anchor: anchorOf(event.currentTarget), message: runtime.t('copyFailed') });
            }
        };
        const openHelp = (event) => {
            swallow(event);
            // 再点一次 = 收起（悬浮气泡的常规手感）
            tray.set(tray.get().panel === 'help'
                ? { panel: 'none', anchor: null }
                : { panel: 'help', anchor: anchorOf(event.currentTarget) });
        };
        /** 打开任务根目录（走官方 openWorkspacePath；失败时提示可改用齿轮里的复制）。 */
        const openRoot = async (event) => {
            swallow(event);
            const result = await call('/open-root', 'POST', {});
            if (!result.ok) {
                tray.set({
                    panel: 'notice',
                    anchor: anchorOf(event.currentTarget),
                    message: `${runtime.t('openRootFailed')}：${result.message}`,
                });
                return;
            }
            if (!result.opened) {
                tray.set({
                    panel: 'notice',
                    anchor: anchorOf(event.currentTarget),
                    message: `${runtime.t('openRootFailed')}：${result.reason ?? ''}（${runtime.t('openRootHint')}）`,
                });
            }
        };
        const openClean = (event) => {
            swallow(event);
            tray.set({ panel: 'clean', anchor: anchorOf(event.currentTarget) });
        };
        const openSettings = (event) => {
            swallow(event);
            tray.set({ panel: 'settings', anchor: anchorOf(event.currentTarget) });
        };
        /** 主区键盘激活（Enter/Space）——官方行的 Enter 只会触发导航，所以这里自己接。 */
        const onPrimaryKey = (event) => {
            if (event.key !== 'Enter' && event.key !== ' ')
                return;
            event.preventDefault();
            swallow(event);
            void create(event);
        };
        return (React.createElement("span", { className: `__tt_row${wide ? ' __tt_rowWide' : ''}`, onClick: swallow, onMouseDown: swallow },
            React.createElement("span", { className: `__tt_primary${busy ? ' __tt_primaryBusy' : ''}${wide ? '' : ' __tt_primaryRail'}`, role: "button", tabIndex: 0, "aria-label": runtime.t('create'), title: busy ? runtime.t('creating') : runtime.t('create'), onClick: (event) => void create(event), onKeyDown: onPrimaryKey },
                busy ? (React.createElement(ICONS.loading, { size: 16 })) : (React.createElement(TemporaryTaskMark, { size: 16 })),
                wide ? (React.createElement("span", { className: "__tt_primaryLabel" }, busy ? runtime.t('creating') : runtime.t('nav'))) : null),
            wide ? React.createElement("span", { className: "__tt_divider", "aria-hidden": "true" }) : null,
            wide ? (React.createElement("span", { className: "__tt_rowActions" },
                React.createElement("button", { type: "button", className: "__tt_tiny __tt_tinyDanger", title: runtime.t('cleanup'), "aria-label": runtime.t('cleanup'), onClick: openClean },
                    React.createElement(ICONS.trash, { size: 16 })),
                rootAction(props.canOpenPath ?? canOpen) === 'open' ? (React.createElement("button", { type: "button", className: "__tt_tiny", title: runtime.t('openRoot'), "aria-label": runtime.t('openRoot'), onClick: (event) => void openRoot(event) },
                    React.createElement(ICONS.external, { size: 16 }))) : (React.createElement("button", { type: "button", className: `__tt_tiny${copied ? ' __tt_tinyOk' : ''}`, title: copied ? runtime.t('copied') : runtime.t('copyRoot'), "aria-label": runtime.t('copyRoot'), onClick: (event) => void copyRoot(event) }, copied ? React.createElement(ICONS.check, { size: 16 }) : React.createElement(ICONS.copy, { size: 16 }))),
                React.createElement("button", { type: "button", className: "__tt_tiny", title: runtime.t('help'), "aria-label": runtime.t('help'), onClick: openHelp },
                    React.createElement(ICONS.question, { size: 16 })),
                React.createElement("button", { type: "button", className: "__tt_tiny", title: runtime.t('settingsTitle'), "aria-label": runtime.t('settingsTitle'), onClick: openSettings },
                    React.createElement(ICONS.settings, { size: 16 })))) : null));
    }
    function TemptaskTray(props) {
        const { runtime, tray } = props;
        // settingsScope 可能由外部注入（离线渲染自测用），否则用 apply 时绑定的那个
        const scope = props.scope;
        const [state, setState] = React.useState(() => tray.get());
        const [tasks, setTasks] = React.useState([]);
        const [snapshot, setSnapshot] = React.useState(null);
        React.useEffect(() => tray.subscribe(() => setState(tray.get())), [tray]);
        // 打开任一浮层时拉一次状态（说明要显示数量/根目录，清理要显示列表）
        React.useEffect(() => {
            if (state.panel === 'none')
                return;
            let alive = true;
            void call('/state', 'GET').then((result) => {
                if (!alive || !result.ok)
                    return;
                const value = result;
                setSnapshot(value);
                setTasks(value.tasks);
            });
            return () => {
                alive = false;
            };
        }, [state.panel]);
        const close = React.useCallback(() => {
            tray.set({ panel: 'none', anchor: null, message: undefined });
        }, [tray]);
        React.useEffect(() => {
            if (state.panel === 'none')
                return undefined;
            const onKey = (event) => {
                if (event.key === 'Escape')
                    close();
            };
            window.addEventListener('keydown', onKey);
            return () => window.removeEventListener('keydown', onKey);
        }, [state.panel, close]);
        const popRef = React.useRef(null);
        const closeTimer = React.useRef(undefined);
        const cancelClose = React.useCallback(() => {
            if (closeTimer.current !== undefined) {
                clearTimeout(closeTimer.current);
                closeTimer.current = undefined;
            }
        }, []);
        /**
         * 「悬浮详情」语义：指针离开气泡（并且也不在来源按钮上）后延时自动收起。
         *
         * 只在 help 面板启用——齿轮与清理是**操作**面板，鼠标飘走就关掉会很烦。
         * 判据是 pointermove 的位置而不是 mouseleave：这样"点了 ? 但一直没碰气泡"的情况
         * 也会在移开鼠标后关掉，不会永远挂在那儿。
         */
        React.useEffect(() => {
            if (state.panel !== 'help') {
                cancelClose();
                return undefined;
            }
            const graceMs = TRAY_AUTO_CLOSE_MS;
            const onMove = (event) => {
                const pop = popRef.current;
                if (pop !== null && event.target instanceof Node && pop.contains(event.target)) {
                    cancelClose();
                    return;
                }
                const source = state.anchor?.source;
                if (source !== undefined &&
                    event.clientX >= source.left &&
                    event.clientX <= source.right &&
                    event.clientY >= source.top &&
                    event.clientY <= source.bottom) {
                    cancelClose();
                    return;
                }
                if (closeTimer.current === undefined) {
                    closeTimer.current = setTimeout(() => {
                        closeTimer.current = undefined;
                        close();
                    }, graceMs);
                }
            };
            window.addEventListener('pointermove', onMove);
            return () => {
                window.removeEventListener('pointermove', onMove);
                cancelClose();
            };
        }, [state.panel, state.anchor, close, cancelClose]);
        if (state.panel === 'none')
            return null;
        const position = {
            left: state.anchor?.left ?? 12,
            top: state.anchor?.top ?? 120,
        };
        if (state.panel === 'notice') {
            return (React.createElement("div", { className: "__tt_pop", style: position, role: "dialog", "aria-label": runtime.t('nav') },
                React.createElement("p", { className: "__tt_error" },
                    "\u274C ",
                    state.message),
                React.createElement("div", { className: "__tt_actions" },
                    React.createElement("button", { type: "button", className: "__tt_btn", onClick: close }, runtime.t('ok')))));
        }
        if (state.panel === 'help') {
            return (React.createElement("div", { className: "__tt_pop", style: position, role: "dialog", "aria-label": runtime.t('help'), ref: popRef },
                React.createElement("h2", { className: "__tt_popTitle" }, runtime.t('nav')),
                React.createElement("p", { className: "__tt_hint" }, runtime.t('intro')),
                React.createElement("div", { className: "__tt_sep" }),
                React.createElement("div", { className: "__tt_kv" },
                    React.createElement("span", { className: "__tt_key" }, runtime.t('count')),
                    React.createElement("span", { className: "__tt_val" }, tasks.length),
                    React.createElement("span", { className: "__tt_key" }, runtime.t('rootDir')),
                    React.createElement("span", { className: "__tt_val" }, snapshot?.rootDir ?? '…'),
                    React.createElement("span", { className: "__tt_key" }, runtime.t('configSource')),
                    React.createElement("span", { className: "__tt_val" }, snapshot?.configSource === 'settings'
                        ? runtime.t('settingsManaged')
                        : runtime.t('fileManaged')),
                    React.createElement("span", { className: "__tt_key" }, runtime.t('dataFile')),
                    React.createElement("span", { className: "__tt_val" }, snapshot?.dataFile ?? '…'),
                    React.createElement("span", { className: "__tt_key" }, runtime.t('versionLabel')),
                    React.createElement("span", { className: "__tt_val" },
                        runtime.t('hostLabel'),
                        " v",
                        snapshot?.pluginVersion ?? '…',
                        "\u3000\u00B7",
                        runtime.t('clientLabel'),
                        " v",
                        CLIENT_VERSION)),
                React.createElement("p", { className: "__tt_hint" }, runtime.t('versionHint')),
                halvesDiffer(snapshot?.pluginVersion, CLIENT_VERSION) ? (React.createElement("p", { className: "__tt_error" }, runtime.t('versionMismatch'))) : null,
                React.createElement("div", { className: "__tt_sep" }),
                React.createElement("p", { className: "__tt_hint" },
                    React.createElement("strong", null, runtime.t('link')),
                    "\uFF1A",
                    runtime.t('linkHint')),
                React.createElement("div", null,
                    React.createElement("p", { className: "__tt_hint" },
                        React.createElement("strong", null, runtime.t('sideSessionTitle'))),
                    React.createElement("p", { className: "__tt_hint" }, runtime.t('sideSessionBody')),
                    snapshot?.sideSessionDetected === true ? (React.createElement("p", { className: "__tt_hint" },
                        "\u2139\uFE0F ",
                        runtime.t('sideSessionDetected'))) : null),
                snapshot !== null && snapshot.warnings.length > 0 ? (React.createElement("p", { className: "__tt_hint" },
                    "\u26A0\uFE0F ",
                    snapshot.warnings.join('；'))) : null,
                snapshot !== null &&
                    !snapshot.capabilities.sessionController &&
                    !snapshot.capabilities.agents ? (React.createElement("p", { className: "__tt_error" },
                    "\u26A0\uFE0F ",
                    runtime.t('capabilityMissing'),
                    "\uFF1A",
                    runtime.t('capabilitySession'))) : null,
                snapshot !== null && !snapshot.capabilities.workspaceRegistry ? (React.createElement("p", { className: "__tt_error" },
                    "\u26A0\uFE0F ",
                    runtime.t('capabilityMissing'),
                    "\uFF1A",
                    runtime.t('capabilityWorkspace'))) : null,
                React.createElement("div", { className: "__tt_sep" }),
                React.createElement("p", { className: "__tt_hint" }, runtime.t('moreSettings')),
                React.createElement("p", { className: "__tt_hint" }, runtime.t('autoCloseHint'))));
        }
        if (state.panel === 'settings') {
            return (React.createElement(TaskSettingsPanel, { runtime: runtime, policy: snapshot?.config.onDeleteSessions ?? 'archive', pluginVersion: snapshot?.pluginVersion, rootDir: snapshot?.rootDir, style: position, scope: scope, onSaved: () => {
                    // 保存后立刻重读一次，让齿轮里的选中态与设置卡片一致
                    void call('/state', 'GET').then((result) => {
                        if (result.ok)
                            setSnapshot(result);
                    });
                }, onClose: close }));
        }
        // panel === 'clean'
        return (React.createElement(CleanDialog, { runtime: runtime, tasks: tasks, policy: snapshot?.config.onDeleteSessions ?? 'archive', onClose: close, onDone: close }));
    }
    /**
     * 齿轮里的设置：只放「删除任务时怎么处理会话」这一个策略。
     *
     * 写入路径有两条（哪条可用走哪条，与设置卡片一致）：
     *   1. `settingsScope.set(...)` —— 写进 DSH 官方 settings 命名空间（推荐路径）；
     *   2. 没有 settings 服务时 POST `/api/config` —— 写插件数据目录下的 config.json。
     */
    function TaskSettingsPanel(props) {
        const { runtime, scope } = props;
        const [value, setValue] = React.useState(props.policy);
        const [busy, setBusy] = React.useState(false);
        const [notice, setNotice] = React.useState(null);
        const [error, setError] = React.useState(null);
        React.useEffect(() => {
            setValue(props.policy);
        }, [props.policy]);
        const choose = async (next) => {
            if (busy || next === value)
                return;
            setBusy(true);
            setNotice(null);
            setError(null);
            setValue(next);
            try {
                if (scope !== undefined && typeof scope.set === 'function') {
                    await scope.set('onDeleteSessions', next);
                }
                else {
                    const result = await call('/config', 'POST', { onDeleteSessions: next });
                    if (!result.ok)
                        throw new Error(result.message);
                }
                setNotice(runtime.t('settingsSaved'));
                props.onSaved();
            }
            catch (cause) {
                setError(`${runtime.t('settingsFailed')}：${String(cause?.message ?? cause)}`);
            }
            finally {
                setBusy(false);
            }
        };
        /** 复制根目录：次要动作放这里，不跟那一行抢图标位。 */
        const copyRootPath = async () => {
            setError(null);
            try {
                await navigator.clipboard.writeText(props.rootDir ?? '');
                setNotice(runtime.t('copied'));
            }
            catch {
                setError(runtime.t('copyFailed'));
            }
        };
        const options = [
            { id: 'archive', label: runtime.t('policyArchive'), hint: runtime.t('policyArchiveHint') },
            { id: 'keep', label: runtime.t('policyKeep'), hint: runtime.t('policyKeepHint') },
        ];
        return (React.createElement("div", { className: "__tt_pop", style: props.style, role: "dialog", "aria-label": runtime.t('settingsTitle') },
            React.createElement("h2", { className: "__tt_popTitle" }, runtime.t('settingsTitle')),
            React.createElement("p", { className: "__tt_hint" }, runtime.t('policy')),
            options.map((option) => (React.createElement("button", { key: option.id, type: "button", className: `__tt_option${value === option.id ? ' __tt_optionOn' : ''}`, "aria-pressed": value === option.id, onClick: () => void choose(option.id), disabled: busy },
                React.createElement("span", { className: "__tt_optionHead" },
                    React.createElement("span", { className: `__tt_radio${value === option.id ? ' __tt_radioOn' : ''}` }),
                    option.label),
                React.createElement("span", { className: "__tt_hint" }, option.hint)))),
            React.createElement("div", { className: "__tt_sep" }),
            React.createElement("p", { className: "__tt_hint" },
                runtime.t('moreSettings'),
                "\u3000\u00B7\u3000",
                runtime.t('hostLabel'),
                " v",
                props.pluginVersion ?? '…',
                ' / ',
                runtime.t('clientLabel'),
                " v",
                CLIENT_VERSION,
                halvesDiffer(props.pluginVersion, CLIENT_VERSION) ? ' ⚠️' : ''),
            React.createElement("div", { className: "__tt_actions" },
                notice !== null ? React.createElement("span", { className: "__tt_hint" },
                    "\u2705 ",
                    notice) : null,
                error !== null ? React.createElement("span", { className: "__tt_error" },
                    "\u274C ",
                    error) : null,
                props.rootDir !== undefined && props.rootDir.length > 0 ? (React.createElement("button", { type: "button", className: "__tt_btn", onClick: () => void copyRootPath(), disabled: busy },
                    "\u29C9 ",
                    runtime.t('copyRoot'))) : null,
                React.createElement("button", { type: "button", className: "__tt_btn", onClick: props.onClose, disabled: busy }, runtime.t('close')))));
    }
    function CleanDialog(props) {
        const { runtime, tasks } = props;
        const [selected, setSelected] = React.useState(() => tasks.filter((task) => task.status === 'closed').map((task) => task.id));
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState(null);
        const toggle = (id) => {
            setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
        };
        const run = async () => {
            setBusy(true);
            setError(null);
            const result = await call('/clean', 'POST', { ids: selected, confirm: true });
            setBusy(false);
            if (!result.ok) {
                setError(result.message);
                return;
            }
            runtime.notice(`已清理 ${result.removed.length} 个任务，归档 ${result.sessionsArchived} 条会话 / ` +
                `cleaned ${result.removed.length}, archived ${result.sessionsArchived}`);
            props.onDone();
        };
        return (React.createElement("div", { className: "__tt_overlay", role: "presentation", onClick: () => (!busy ? props.onClose() : undefined) },
            React.createElement("div", { className: "__tt_dialog", role: "dialog", "aria-modal": "true", onClick: (event) => event.stopPropagation() },
                React.createElement("h2", { className: "__tt_dialogTitle" }, runtime.t('cleanTitle')),
                React.createElement("p", { className: "__tt_hint" }, props.policy === 'archive' ? runtime.t('cleanBodyArchive') : runtime.t('cleanBodyKeep')),
                tasks.length === 0 ? (React.createElement("p", { className: "__tt_hint" }, runtime.t('empty'))) : (React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "__tt_actions" },
                        React.createElement("button", { type: "button", className: "__tt_btn", onClick: () => setSelected(tasks.map((task) => task.id)) }, runtime.t('selectAll')),
                        React.createElement("button", { type: "button", className: "__tt_btn", onClick: () => setSelected([]) }, runtime.t('selectNone'))),
                    React.createElement("div", { className: "__tt_list" }, tasks.map((task) => (React.createElement("label", { key: task.id, className: "__tt_item" },
                        React.createElement("input", { type: "checkbox", checked: selected.includes(task.id), onChange: () => toggle(task.id) }),
                        React.createElement("span", { className: "__tt_itemLabel", title: task.path }, labelOf(task)),
                        React.createElement("span", { className: "__tt_itemDir" }, task.dirName),
                        React.createElement("span", { className: "__tt_tag" }, task.status === 'active' ? runtime.t('active') : runtime.t('closed')),
                        task.live ? (React.createElement("span", { className: "__tt_tag __tt_tagLive" }, runtime.t('liveTag'))) : null,
                        !task.workspacePresent ? (React.createElement("span", { className: "__tt_tag" }, runtime.t('missingNode'))) : null)))))),
                tasks.some((task) => task.live) ? (React.createElement("p", { className: "__tt_hint" }, runtime.t('liveWarning'))) : null,
                error !== null ? React.createElement("p", { className: "__tt_error" },
                    "\u274C ",
                    error) : null,
                React.createElement("div", { className: "__tt_dialogActions" },
                    React.createElement("button", { type: "button", className: "__tt_btn", onClick: props.onClose, disabled: busy }, runtime.t('cancel')),
                    React.createElement("button", { type: "button", className: "__tt_btn __tt_btnDanger", onClick: () => void run(), disabled: busy || selected.length === 0 }, busy ? runtime.t('cleaning') : `${runtime.t('confirmClean')}（${selected.length}）`)))));
    }
    /* ─────────────────────────── 常驻守护组件 ─────────────────────────── */
    /**
     * 常驻（注册在 shell.overlay，渲染 null）。
     *
     * 消费 host 的 pendingOpen：`/temptask new`、`/temptask open` 以及行上主区的「新建」都只是在 host 侧登记
     * 一个请求，真正把会话切到前台必须由页面来做。会话刚创建时客户端可能还没收到会话列表更新，
     * 所以这里带重试（见 runtime.openSession）。
     */
    function PendingOpenWatcher(props) {
        const { runtime } = props;
        React.useEffect(() => {
            let alive = true;
            let busy = false;
            const tick = async () => {
                if (busy)
                    return;
                busy = true;
                try {
                    const result = await call('/state', 'GET');
                    if (alive && result.ok) {
                        const pending = result.pendingOpen;
                        if (pending !== undefined) {
                            runtime.openSession(pending.sessionId);
                            await call('/ack-open', 'POST', {});
                        }
                    }
                }
                finally {
                    busy = false;
                }
            };
            const timer = setInterval(() => void tick(), 2500);
            void tick();
            return () => {
                alive = false;
                clearInterval(timer);
            };
        }, [runtime]);
        return null;
    }
    function SettingsSection(props) {
        const { scope, runtime } = props;
        const [draft, setDraft] = React.useState(props.initial);
        const [state, setState] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [notice, setNotice] = React.useState(null);
        const [error, setError] = React.useState(null);
        const [cleanOpen, setCleanOpen] = React.useState(false);
        const pull = React.useCallback(async () => {
            const result = await call('/state', 'GET');
            if (result.ok)
                setState(result);
        }, []);
        React.useEffect(() => {
            const sync = () => {
                const snapshot = scope.getSnapshot();
                if (snapshot.status === 'ready' && snapshot.value !== undefined) {
                    setDraft(snapshot.value);
                }
            };
            if (typeof scope.load === 'function')
                void scope.load();
            sync();
            const unsubscribe = typeof scope.subscribe === 'function' ? scope.subscribe(sync) : null;
            void pull();
            return () => {
                if (unsubscribe !== null)
                    unsubscribe();
            };
        }, [scope, pull]);
        const save = async () => {
            setBusy(true);
            setNotice(null);
            setError(null);
            try {
                await scope.set('rootDir', draft.rootDir);
                await scope.set('autoCleanDays', Number(draft.autoCleanDays) || 0);
                setNotice(runtime.t('saved'));
                if (typeof scope.load === 'function')
                    void scope.load();
            }
            catch (cause) {
                setError(`${runtime.t('saveFailed')}：${String(cause?.message ?? cause)}`);
            }
            finally {
                setBusy(false);
            }
        };
        const tasks = state?.tasks ?? [];
        return (React.createElement("div", { className: "__tt_section" },
            React.createElement("div", { className: "__tt_card" },
                React.createElement("h3", { className: "__tt_cardTitle" },
                    runtime.t('nav'),
                    " \u00B7 ",
                    runtime.t('settings')),
                React.createElement("p", { className: "__tt_hint" }, runtime.t('intro')),
                React.createElement("label", { className: "__tt_field" },
                    React.createElement("span", { className: "__tt_label" }, runtime.t('rootDir')),
                    React.createElement("input", { className: "__tt_input", value: draft.rootDir, placeholder: "<DSH_HOME>/dsh-temptask", onChange: (event) => setDraft({ ...draft, rootDir: event.target.value }) })),
                React.createElement("label", { className: "__tt_field" },
                    React.createElement("span", { className: "__tt_label" }, runtime.t('autoCleanDays')),
                    React.createElement("input", { className: "__tt_input", type: "number", min: 0, value: String(draft.autoCleanDays), onChange: (event) => setDraft({ ...draft, autoCleanDays: Number(event.target.value) || 0 }) })),
                React.createElement("p", { className: "__tt_hint" }, runtime.t('autoCleanHint')),
                React.createElement("p", { className: "__tt_hint" },
                    runtime.t('configSource'),
                    "\uFF1A",
                    state?.configSource === 'settings' ? runtime.t('settingsManaged') : runtime.t('fileManaged'),
                    '　·　',
                    runtime.t('dataFile'),
                    "\uFF1A",
                    state?.dataFile ?? draft.dataDir),
                React.createElement("div", { className: "__tt_actions" },
                    React.createElement("button", { type: "button", className: "__tt_btn __tt_btnPrimary", onClick: () => void save(), disabled: busy }, runtime.t('save')),
                    React.createElement("button", { type: "button", className: "__tt_btn", onClick: () => setCleanOpen(true) },
                        "\uD83E\uDDF9 ",
                        runtime.t('confirmClean'),
                        "\uFF08",
                        tasks.length,
                        "\uFF09"),
                    notice !== null ? React.createElement("span", { className: "__tt_hint" },
                        "\u2705 ",
                        notice) : null,
                    error !== null ? React.createElement("span", { className: "__tt_error" },
                        "\u274C ",
                        error) : null)),
            React.createElement("div", { className: "__tt_card" },
                React.createElement("h3", { className: "__tt_cardTitle" }, runtime.t('sideSessionTitle')),
                React.createElement("p", { className: "__tt_hint" }, runtime.t('sideSessionBody')),
                state?.sideSessionDetected === true ? (React.createElement("p", { className: "__tt_hint" },
                    "\u2139\uFE0F ",
                    runtime.t('sideSessionDetected'))) : null),
            cleanOpen ? (React.createElement(CleanDialog, { runtime: runtime, tasks: tasks, policy: state?.config.onDeleteSessions ?? 'archive', onClose: () => setCleanOpen(false), onDone: () => {
                    setCleanOpen(false);
                    void pull();
                } })) : null));
    }
    const plugin = {
        // 只把「没有它就没有 UI」的服务声明为硬依赖；其余一律 ctx.get 可选获取。
        inject: ['slots', 'locale'],
        apply(ctx) {
            injectStyles();
            const slots = ctx.get('slots');
            if (slots === undefined) {
                ctx.logger?.warn?.('[dsh-temptask] slots 服务不可用，客户端 UI 未挂载');
                return;
            }
            const locale = ctx.get('locale');
            if (locale !== undefined) {
                ctx.effect(() => locale.register(NS, 'zh', ZH), 'dsh-temptask: zh dictionary');
                ctx.effect(() => locale.register(NS, 'en', EN), 'dsh-temptask: en dictionary');
            }
            /**
             * 每次调用都**当场**向 locale 取译文。
             *
             * 注册给官方面板行的 `label` 是个 thunk（官方每次投影都重读），所以这里必须当场解析：
             * 切换语言后 tooltip / 无障碍名跟着变，而不是停在挂载时的语言。
             */
            const t = (key) => {
                const bound = locale?.bind?.(NS);
                if (bound !== undefined) {
                    const value = bound(key);
                    if (typeof value === 'string' && value.length > 0 && value !== key)
                        return value;
                }
                const id = locale?.getLocale?.().id ?? 'zh';
                const dict = id.toLowerCase().startsWith('zh') ? ZH : EN;
                return dict[key] ?? ZH[key] ?? key;
            };
            /** 打开会话：客户端只认识「已知会话」，刚创建的会话可能晚一拍到达，所以带重试。 */
            const openSession = (sessionId, attempt = 0) => {
                const sessions = ctx.get('sessions');
                if (sessions === undefined) {
                    ctx.logger?.warn?.('[dsh-temptask] sessions 服务不可用，无法打开会话');
                    return;
                }
                try {
                    sessions.open(sessionId);
                    ctx.get('layout')?.selectPanel('conversation');
                }
                catch (error) {
                    if (attempt < 8) {
                        setTimeout(() => openSession(sessionId, attempt + 1), 400);
                        return;
                    }
                    ctx.logger?.warn?.(`[dsh-temptask] 会话 ${sessionId} 尚未出现在会话列表中，请从侧边栏任务节点下打开：${String(error)}`);
                }
            };
            const runtime = {
                t,
                openSession: (sessionId) => openSession(sessionId),
                notice: (message) => ctx.logger?.info?.(`[dsh-temptask] ${message}`),
            };
            const tray = createTray();
            /**
             * settingsScope（由 dsh-client-ui-settings 提供）：齿轮里的「删除策略」与设置卡片共用它。
             * 取不到时齿轮退回 `/api/config`（host 端的 config.json 降级通道），所以功能不丢。
             */
            const settingsScopeBinder = ctx.get('settingsScope');
            const settingsScope = settingsScopeBinder !== undefined && typeof settingsScopeBinder.bind === 'function'
                ? settingsScopeBinder.bind({ namespace: NS })
                : undefined;
            /**
             * 兜底：面板行的官方 onClick 是 `selectPanel(id)`（键盘激活也只走它）。
             * 本组件什么都不渲染，并在挂载瞬间切回会话——所以即使有人用键盘激活那一行，
             * 也只会闪一下，不会出现空白页或新页面。
             */
            function MainPanelBackstop() {
                React.useEffect(() => {
                    ctx.get('layout')?.selectPanel('conversation');
                }, []);
                return null;
            }
            /**
             * 侧边栏那一行：官方负责行的外观与 tooltip，本行自己画内容（要"标签在左、按钮在右"）。
             *
             * `order` 为什么是负数：0.1.7-rc.2 起官方 Web 端自己往 `sidebar.panellist` 注册了一个
             * 「插件」面板行（`id: "plugins"`、`order: 0`、图标是风车，见官方 `PluginsPanelIcon`）。
             * 面板列表按 `order` **升序**渲染，取 10 时那行「插件」会永远压在本行上面，
             * 本行就贴不到「新建会话」正下方；取负值才能排到它前面。
             * 也不要用 0：并列名次只能靠 `Array.prototype.sort` 的稳定性决定先后，太脆。
             */
            slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: NS, order: -100, label: () => t('nav'), locale: NS }, (raw) => {
                const injected = raw;
                return React.createElement(TemptaskRow, {
                    runtime: isRuntime(injected.runtime) ? injected.runtime : runtime,
                    tray: isTray(injected.tray) ? injected.tray : tray,
                    ...(typeof injected.size === 'number' ? { size: injected.size } : {}),
                    // 官方只会传 size/active；这一项留给离线渲染自测注入（生产环境由组件自己问 /state）
                    ...(typeof injected.canOpenPath === 'boolean'
                        ? { canOpenPath: injected.canOpenPath }
                        : {}),
                });
            }));
            // 该行在官方语义里指向一个面板；这里给一个"空面板 + 立刻返回会话"的兜底。
            slots.inject('main', () => slots.register({ name: 'main', key: NS }, () => React.createElement(MainPanelBackstop)));
            // 浮层：说明气泡 / 清理确认框 / 齿轮设置 / 失败提示 + 消费 pendingOpen 的常驻守护
            slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', id: `${NS}-tray`, order: 200, label: 'ds-temptask tray' }, (raw) => {
                const injected = raw;
                const scope = injected.scope !== undefined &&
                    typeof injected.scope.set === 'function'
                    ? injected.scope
                    : settingsScope;
                return React.createElement(TemptaskTray, {
                    runtime: isRuntime(injected.runtime) ? injected.runtime : runtime,
                    tray: isTray(injected.tray) ? injected.tray : tray,
                    scope,
                });
            }));
            slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', id: `${NS}-pending-open`, order: 210, label: 'ds-temptask pending open' }, () => React.createElement(PendingOpenWatcher, { runtime })));
            // 设置卡片（settingsScope 可用时才注册；缺失则只留齿轮里的精简设置）
            if (settingsScope !== undefined) {
                slots.inject('settings.section', () => slots.register({ name: 'settings.section', id: NS, order: 60, label: () => t('nav'), locale: NS }, () => React.createElement(SettingsSection, {
                    scope: settingsScope,
                    initial: defaultConfigShape(),
                    runtime,
                })));
            }
            ctx.logger?.info?.('[dsh-temptask] client half mounted');
        },
        __internals: {
            ZH,
            EN,
            TaskIcon,
            TemptaskRow,
            TemptaskTray,
            TaskSettingsPanel,
            CleanDialog,
            PendingOpenWatcher,
            SettingsSection,
            createTray,
            labelOf,
            halvesDiffer,
            rootAction,
            TemporaryTaskMark,
            TRAY_AUTO_CLOSE_MS,
        },
    };
    /** 设置卡片首次渲染的占位配置（真实值由 settingsScope 的 snapshot 覆盖）。 */
    function defaultConfigShape() {
        return { rootDir: '', autoCleanDays: 0, dataDir: '', onDeleteSessions: 'archive' };
    }
    var __plugin = plugin;

    module.exports = __plugin;
    return module.exports;
  },
});
