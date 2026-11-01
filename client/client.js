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
     *   - 侧边栏**一行**：自绘的「🗂 临时任务」标记 + 五个小 pushbutton（**转正** / 清理 /
     *     打开或复制根目录 / 说明 / 设置），行内每个字形都是本插件自己画的 SVG（见下面「图标」一节）；
     *     位置在「新建会话」按钮正下方——注册 `order` 取负值，排在官方「插件」面板行（order 0）之前；
     *     **点击标签不会有任何页面**。
     *   - 「转正」还有两个入口挂在**官方会话行**上（`sidebar.workspaces.session.menu.item` 的
     *     "…" 菜单行 + `sidebar.workspaces.session.row.action` 的行尾悬停按钮）：只有这条会话
     *     属于某个临时任务（`TaskView.sessionIds` 里有它）时才出现，点了就打开同一个托盘面板
     *     并预选那个任务。会话归属靠 `/state` 的**共享快照**反查，不额外起轮询。
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
     * 客户端半边的版本 —— **构建期注入，不要手写**。
     *
     * `0.5.0` 是 `scripts/build-client.mjs` 的替换点：包装 ModuleLoader
     * 包时换成当时的 `package.json` 的 `version`，找不到占位符就直接构建失败。浏览器里
     * 读不到 `package.json`，所以这一半只能在构建期定版。
     *
     * 为什么要单独留一个：host 的版本只能证明 **host** 半边刷新了。纯客户端改动
     * （比如某一版只调了 UI）host 版本可能不变，气泡里并排显示两半，才能判断
     * "到底是哪半边还是旧的"。
     *
     * 历史：0.4.0 忘了改这里的字面量，发布出去的包里 host 报 `0.4.0`、界面报 `0.3.3`，
     * 设置卡片与 `?` 气泡一直挂着"两半版本不一致"的告警。改成注入后不可能再漂移。
     */
    const CLIENT_VERSION = '0.5.0';
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
        linkHint: '左侧任务节点：展开就是它的会话；右键可归档 / 重命名。',
        count: '任务数量',
        rootDir: '任务根目录',
        configSource: '配置来源',
        dataFile: '记录文件',
        hostLabel: '插件后端',
        clientLabel: '插件界面',
        versionMismatch: '⚠️ 两半版本不一致：有一半还是旧的——重启 DSH 可让两半同时更新。',
        pluginManaged: 'DSH 插件配置（设置 → 插件 → 临时任务）',
        settingsManaged: 'DSH 设置（设置 → 插件 → 临时任务）',
        fileManaged: '插件数据目录下的 config.json',
        rowManaged: '插件行配置（只读）',
        defaultsManaged: '内置默认值',
        moreSettings: '更多设置 → 设置 → 插件 → 临时任务',
        cleanTitle: '清理临时任务',
        cleanBodyArchive: '删除会同时移除任务目录、侧边栏节点与记录（不可恢复）。它的会话会被【归档】——默认从侧边栏隐藏、日志仍留在磁盘上；要放回来：侧栏「视图选项 → 全部对话（显示已归档）」，再在会话上右键「取消归档」（DSH 0.1.7-rc.2 起）：',
        cleanBodyKeep: '删除会同时移除任务目录、侧边栏节点与记录（不可恢复）。按当前设置，它的会话会【留在「未分组」】（想改成归档：齿轮 → 设置）：',
        liveTag: '运行中',
        liveWarning: '⚠️ 列表里有正在运行的任务（标着「运行中」）：删除它们之前会先中止当轮的对话。',
        policy: '删除任务时',
        policyArchive: '归档会话（推荐）',
        policyKeep: '留在未分组',
        policyArchiveHint: '从侧边栏隐藏；日志仍在磁盘上，可在「视图选项 → 全部对话（显示已归档）」里取消归档（DSH 0.1.7-rc.2 起）。',
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
        capabilityMissing: '宿主能力缺失',
        capabilitySession: '当前宿主未提供 sessionController/agents，无法新建会话。',
        capabilityWorkspace: '当前宿主未提供 workspaceRegistry，无法把任务做成侧边栏节点。',
        // 「转正」（临时任务 → 正式工作区）：入口三处（侧边栏爱心 / 会话行菜单 / 会话行悬停按钮），
        // 面板一套文案。带历史是默认且推荐，所以 carry 的文案要如实说清"复刻一轮对话 + 旧会话归档"。
        promote: '转正…',
        promoteTitle: '转正为正式工作区',
        promoteIntro: '把任务目录搬到新位置，并以新目录名注册成正式工作区。原临时节点会消失；搬目录这一步不可自动撤销。',
        promoteTask: '要转正的任务',
        promoteEmpty: '暂无临时任务可转正',
        promoteName: '新目录名',
        promoteNameHint: '同时就是新节点的标题（只能是单段名字，不含路径分隔符）',
        promoteParent: '目标父目录',
        promoteParentHint: '新目录会建在这里；父目录必须已经存在（不替你造目录——用「浏览…」在目标位置新建文件夹）',
        promoteParentPlaceholder: '例如 D:\\code（不认识就点「浏览…」）',
        promoteFilterAll: '显示全部',
        promoteFilterOnlyNode: '只显示有节点的',
        promoteNoNodeHint: '这些任务在侧边栏已经没有节点了（删工作区不会删文件夹，这是 DSH 的语义）：只剩文件夹与记录，转正会把文件夹搬走并重新建一个正式节点。',
        promoteNoNodeTag: '无节点',
        promoteReading: '正在读取会话标题…',
        promoteSessions: '条会话',
        promoteStaleHost: '插件后端还是旧版本（改完代码后没重启 DSH）：面板里有些默认值会缺失，例如目标父目录。重启 DSH 后再转正。',
        promoteBrowse: '浏览…',
        promoteBrowseFailed: '打开目录选择器失败',
        promoteCarry: '把对话带过去',
        promoteCarryHint: '用官方 fork 种子把已完成的一轮对话复刻进新工作区的会话；旧会话按现有策略归档。',
        promoteOpen: '完成后打开新会话',
        promoteSubmit: '转正',
        promoteConfirmTitle: '确认转正',
        promoteConfirmBody: '目录会被搬到新位置（不可自动撤销）：',
        promoteConfirmCarry: '会尝试把对话复刻到新会话',
        promoteConfirmNoCarry: '不带对话：只有目录搬走',
        promoteConfirm: '确认转正',
        promoteBack: '返回修改',
        promoteRunning: '正在转正…',
        promoteFailed: '转正失败',
        promoteDoneTitle: '已转正',
        promoteFrom: '原目录',
        promoteTo: '新目录',
        promoteWorkspace: '新工作区',
        promoteHistory: '对话历史',
        promoteHistoryYes: '已带上（官方 fork 种子）',
        promoteHistoryNo: '未带上',
        promoteArchived: '已归档会话',
        promoteCanceled: '已中止当轮',
        promoteCopied: '跨卷：目录是「复制 + 删除」搬过去的（原路径已清理）',
        promoteOpenHint: '新会话在新节点下；若没有自动切过去，展开侧边栏那个节点即可打开。',
        promoteNeedName: '请填写新目录名',
        promoteNeedParent: '请填写目标父目录',
        promoteLiveHint: '该任务正在运行：转正会先中止它当轮的对话。',
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
        linkHint: 'Left task nodes: expand for its sessions; right-click to archive or rename.',
        count: 'Tasks',
        rootDir: 'Task root',
        configSource: 'Config source',
        dataFile: 'Record file',
        hostLabel: 'backend',
        clientLabel: 'UI',
        versionMismatch: '⚠️ Halves disagree — one of them is still the old build. Restarting DSH updates both.',
        pluginManaged: 'DSH plugin config (Settings → Plugins → Temporary tasks)',
        settingsManaged: 'DSH settings (Settings → Plugins → Temporary tasks)',
        fileManaged: 'config.json in the plugin data directory',
        rowManaged: 'plugin row config (read-only)',
        defaultsManaged: 'built-in defaults',
        moreSettings: 'More settings → Settings → Plugins → Temporary tasks',
        cleanTitle: 'Clean up temporary tasks',
        cleanBodyArchive: 'This removes the task directory, its sidebar node and its record (irreversible). Its sessions are ARCHIVED — hidden from the sidebar by default, logs stay on disk. To bring one back: view options → "All conversations (show archived)", then right-click the session → "Unarchive" (DSH 0.1.7-rc.2 and later):',
        cleanBodyKeep: 'This removes the task directory, its sidebar node and its record (irreversible). With the current setting, its sessions STAY under "Ungrouped" (switch to archiving via the gear → settings):',
        liveTag: 'running',
        liveWarning: '⚠️ The list contains running tasks (tagged “running”): deleting them cancels their current turn first.',
        policy: 'When deleting a task',
        policyArchive: 'Archive its sessions (recommended)',
        policyKeep: 'Leave them ungrouped',
        policyArchiveHint: 'Hidden from the sidebar; logs stay on disk and can be restored via "All conversations (show archived)" (DSH 0.1.7-rc.2 and later).',
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
        capabilityMissing: 'Missing host capability',
        capabilitySession: 'This host exposes no sessionController/agents, so sessions cannot be created.',
        capabilityWorkspace: 'This host exposes no workspaceRegistry, so tasks cannot become sidebar nodes.',
        promote: 'Promote…',
        promoteTitle: 'Promote to a permanent workspace',
        promoteIntro: 'Moves the task directory to a new location and registers it as a permanent workspace under the new directory name. The temporary node disappears; moving the directory cannot be undone automatically.',
        promoteTask: 'Task to promote',
        promoteEmpty: 'No temporary tasks to promote',
        promoteName: 'New directory name',
        promoteNameHint: 'Also the new node title (a single path segment, no separators)',
        promoteParent: 'Destination parent folder',
        promoteParentHint: 'The new directory is created here; the parent must already exist (nothing is invented for you — use "Browse…" to create a folder there first)',
        promoteParentPlaceholder: 'e.g. D:\\code (use "Browse…" if unsure)',
        promoteFilterAll: 'Show all',
        promoteFilterOnlyNode: 'Only with a node',
        promoteNoNodeHint: 'These tasks no longer have a sidebar node (deleting a workspace never deletes its folder — that is DSH semantics): only the folder and its record remain. Promotion moves the folder and creates a fresh permanent node.',
        promoteNoNodeTag: 'no node',
        promoteReading: 'Reading session titles…',
        promoteSessions: 'sessions',
        promoteStaleHost: 'The plugin backend is still the old version (DSH was not restarted after the code change): some defaults such as the destination folder are missing. Restart DSH before promoting.',
        promoteBrowse: 'Browse…',
        promoteBrowseFailed: 'Could not open the directory picker',
        promoteCarry: 'Carry the conversation over',
        promoteCarryHint: 'Uses the official fork seed to copy the finished conversation into the new workspace session; the old session is archived by the current policy.',
        promoteOpen: 'Open the new session when done',
        promoteSubmit: 'Promote',
        promoteConfirmTitle: 'Confirm promotion',
        promoteConfirmBody: 'The directory is moved to the new location (it cannot be undone automatically):',
        promoteConfirmCarry: 'The conversation will be copied into the new session',
        promoteConfirmNoCarry: 'No conversation: only the directory moves',
        promoteConfirm: 'Promote now',
        promoteBack: 'Back',
        promoteRunning: 'Promoting…',
        promoteFailed: 'Promotion failed',
        promoteDoneTitle: 'Promoted',
        promoteFrom: 'From',
        promoteTo: 'To',
        promoteWorkspace: 'New workspace',
        promoteHistory: 'Conversation history',
        promoteHistoryYes: 'Carried over (official fork seed)',
        promoteHistoryNo: 'Not carried over',
        promoteArchived: 'Sessions archived',
        promoteCanceled: 'Running turns canceled',
        promoteCopied: 'Cross-volume: the directory was copied and the old one removed',
        promoteOpenHint: 'The new session sits under the new node; expand that node in the sidebar if it did not switch automatically.',
        promoteNeedName: 'Enter a directory name',
        promoteNeedParent: 'Enter a destination parent folder',
        promoteLiveHint: 'This task is running: promotion cancels its current turn first.',
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
        /*
         * 浮层里的子项一律**不许被压缩**。
         *
         * 这条是修一个真实事故：`__tt_pop` 有 `max-height`，而 flex 子项默认 `flex-shrink:1`；
         * 带 `overflow:auto` 的子项（任务列表）其 `min-height:auto` 会退化成 0，于是**只有它**被压成
         * 十几像素的一条——内容全被裁掉，看起来像一个"空的坏输入框"（转正面板在 1366×768 / 高缩放的
         * 屏幕上就中过这一枪）。浮层该做的是**自己滚动**，不是把子项挤扁。
         */
        '.__tt_pop > *{flex:0 0 auto}',
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
        // 标题行：左边标题、右上角 X（对话框的通用出口；底部按钮也留着，两条路都通）。
        '.__tt_dialogHead{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}',
        /*
         * 模态里的"功能区"：**一个描边卡片**包住整块（标题 + 控件 + 说明）。
         *
         * 为什么要有这个：早先每个区的标签都是 12px 三级灰，和它下面的说明文字一个样，整面板
         * 糊成一片、没有视觉重心（用户实测指出"根本分不清功能节"）。先试过"顶部一条 1px 分隔线"，
         * 反馈还是不够明显——于是改成**围一圈**：描边 + 12px 圆角 + 内边距，每块自成一体。
         * 层级仍是：区标题 13px/600/主色 → 输入/列表 → 说明 12px/三级灰。
         * 卡片里那层任务列表因此**去掉自己的边框**，免得出现"框中框"。
         */
        '.__tt_group{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}',
        '.__tt_groupHead{display:flex;align-items:center;justify-content:space-between;gap:8px}',
        '.__tt_groupTitle{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}',
        // 结果卡/确认卡里的键值对也装进一个描边框，当成"摘要块"读，而不是和说明文字混在一起。
        '.__tt_kv{padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}',
        '.__tt_iconBtn{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
        '.__tt_iconBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.__tt_iconBtn:disabled{opacity:.45;cursor:default}',
        '.__tt_dialogActions{display:flex;justify-content:flex-end;gap:8px}',
        '.__tt_list{display:flex;flex-direction:column;gap:4px;max-height:300px;min-height:56px;flex:none;overflow:auto;border:none;border-radius:8px;padding:0}',
        // 「要转正的任务」那一行：左边标签、右边过滤开关（"显示全部 / 只显示有节点的"）。
        '.__tt_listHead{display:flex;align-items:center;justify-content:space-between;gap:8px}',
        '.__tt_link{appearance:none;border:none;background:transparent;padding:0;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-brand-primary);cursor:pointer}',
        '.__tt_link:hover{text-decoration:underline}',
        // 会话摘要：最多两行，超出省略（标题说"叫什么"，摘要说"聊了什么"）。
        '.__tt_preview{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
        '.__tt_item{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px;min-width:0}',
        '.__tt_itemLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.__tt_itemDir{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
        '.__tt_tag{font-size:11px;line-height:16px;padding:0 6px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}',
        '.__tt_tagLive{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
        '.__tt_option{box-sizing:border-box;display:flex;flex-direction:column;gap:2px;width:100%;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}',
        '.__tt_option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
        '.__tt_option[aria-disabled="true"]{opacity:.6;cursor:default}',
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
        // 官方会话行 "…" 菜单里的一行。本插件自绘（不 require 宿主 ui-primitives 的 MenuItemButton，
        // 理由与图标一致：那个包的导出名改过一次），所以观感要自己对上官方菜单行：13px、圆角、hover 底色。
        '.__tt_menuItem{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}',
        '.__tt_menuItem:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        // 失败块：message 与 hint 一起停在表单里（不飘走），所以给它一个边框把两条绑在一起。
        '.__tt_errorBlock{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px}',
        '.__tt_code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);margin-left:6px}',
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
        const existing = document.querySelector('style[data-plugin-css="dsh-temptask/main.css"]');
        if (existing !== null) {
            /*
             * 已经注入过：**内容变了要就地更新**，不能直接 return。
             *
             * 为什么：这个模块可能被宿主热替换 / 重复执行（浏览器缓存、插件热更新），而 `<style>` 标签
             * 是挂在 `document.head` 上的、不会跟着模块重生成。早先这里 `return` 了，于是出现过
             * "新 DOM + 旧 CSS"——右上角 X 已经渲染出来，但 `__tt_dialogHead` / `__tt_iconBtn` 的规则
             * 还没生效，看起来就是"X 掉到标题底下、按钮没圆角"（用户实测截图确认过）。
             */
            if (existing.textContent !== CSS)
                existing.textContent = CSS;
            return;
        }
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
    /* ─────────────────────────── 配置读写桥 ─────────────────────────── */
    /**
     * 把 0.2.0-rc.1 的 `ctx.configForms.get(entryId)` 适配成组件认识的 shape。
     *
     * 为什么 `set` 要抛：ConfigForm 的 `set` 用布尔回答「宿主收没收」，
     * 而组件靠异常分支显示失败；返回 false 却当作成功会给出「已保存」的假象。
     */
    function adaptConfigForm(form) {
        const require = (accepted, action) => {
            if (accepted !== true)
                throw new Error(`宿主拒绝了这次配置${action}`);
        };
        return {
            getSnapshot: () => form.getSnapshot(),
            subscribe: (listener) => form.subscribe(listener),
            set: async (key, value) => require(await form.set(key, value), '写入'),
            unset: async (key) => require(await form.unset(key), '清除'),
        };
    }
    /**
     * 找一条客户端配置通道：
     *   1. 0.2.0-rc.1：`configForms.get(行 id)` —— 与官方「设置 → 插件」表单同一份数据；
     *   2. 0.1.x：`settingsScope.bind({ namespace })` —— 老宿主上的 settings 命名空间；
     *   3. 都没有：undefined，组件退回插件自己的 `/api/config`（host 端写 profile 或 config.json）。
     */
    function resolveConfigScope(ctx) {
        const forms = ctx.get('configForms');
        if (forms !== undefined && typeof forms.get === 'function') {
            try {
                return adaptConfigForm(forms.get(NS));
            }
            catch (error) {
                ctx.logger?.warn?.(`[dsh-temptask] configForms 不可用，配置改走插件自己的通道：${String(error)}`);
            }
        }
        const binder = ctx.get('settingsScope');
        if (binder !== undefined && typeof binder.bind === 'function') {
            try {
                return binder.bind({ namespace: NS });
            }
            catch (error) {
                ctx.logger?.warn?.(`[dsh-temptask] settingsScope 绑定失败：${String(error)}`);
            }
        }
        return undefined;
    }
    /**
     * 写一项配置：先走客户端配置桥，桥不可用或被拒时退回插件自己的 HTTP 通道。
     * 两条路的 host 端最终都写进同一处（新宿主是 profile 补丁，旧宿主是 settings/配置文件）。
     */
    async function writeConfigField(scope, field, value) {
        let bridgeError;
        if (scope !== undefined && typeof scope.set === 'function') {
            try {
                await scope.set(field, value);
                return;
            }
            catch (error) {
                bridgeError = error;
            }
        }
        const result = await call('/config', 'POST', { [field]: value });
        if (result.ok)
            return;
        throw new Error(result.message.length > 0 ? result.message : String(bridgeError ?? '配置写入失败'));
    }
    /** 一行的展示名：工作区标题（= 目录 basename，本插件不改写它）；缺失时回落到目录名。 */
    function labelOf(task) {
        return task.title !== undefined && task.title.length > 0 ? task.title : task.dirName;
    }
    /**
     * 打开会话：客户端只认识「已知会话」，刚创建的会话可能晚一拍到达，所以带重试。
     *
     * 入口按宿主版本选：0.2.0-rc.1 起统一走 `ctx.uiWorkspace.openSession(target)`
     * （它一次做完「选中会话 + 切到对话面板」，旧宿主的 `ctx.sessions.open` 在新宿主里已不存在）；
     * 0.1.x 上退回 `sessions.open` + `layout.selectPanel('conversation')`。
     */
    function createOpenSession(ctx) {
        return function openSession(sessionId, attempt = 0) {
            const uiWorkspace = ctx.get('uiWorkspace');
            const sessions = ctx.get('sessions');
            try {
                if (uiWorkspace !== undefined && typeof uiWorkspace.openSession === 'function') {
                    uiWorkspace.openSession(sessionId);
                }
                else if (sessions !== undefined && typeof sessions.open === 'function') {
                    sessions.open(sessionId);
                    ctx.get('layout')?.selectPanel('conversation');
                }
                else {
                    throw new Error('既没有 uiWorkspace 也没有 sessions 服务');
                }
            }
            catch (error) {
                if (attempt < 8) {
                    setTimeout(() => openSession(sessionId, attempt + 1), 400);
                    return;
                }
                ctx.logger?.warn?.(`[dsh-temptask] 会话 ${sessionId} 尚未出现在会话列表中，请从侧边栏任务节点下打开：${String(error)}`);
            }
        };
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
    /** 配置来源 → 人类可读标签（未知来源原样显示，便于排查新版宿主）。 */
    function configSourceLabel(source, runtime) {
        switch (source) {
            case 'plugin-config':
                return runtime.t('pluginManaged');
            case 'settings':
                return runtime.t('settingsManaged');
            case 'config-file':
                return runtime.t('fileManaged');
            case 'cordis-row':
                return runtime.t('rowManaged');
            case 'defaults':
                return runtime.t('defaultsManaged');
            default:
                return source ?? '…';
        }
    }
    /**
     * 那第三个按钮该做什么：宿主能打开文件夹就「打开」，否则退回「复制」。
     *
     * 抽成纯函数是为了可测——SSR 里拿不到 /state，组件内的分支测不到，这个判断必须自己可验证。
     */
    function rootAction(canOpenPath) {
        return canOpenPath === true ? 'open' : 'copy';
    }
    /**
     * 从一个被点的元素算出锚点。
     *
     * 抽到模块级是因为现在有**三处**入口共用它：侧边栏那一行的按钮、官方会话行的菜单项、
     * 会话行的悬停按钮。拿不到矩形（SSR / 合成事件之外）时给一组固定坐标，绝不因此抛错。
     */
    function anchorOfTarget(target) {
        // `HTMLElement` 本身在非浏览器环境（离线渲染自测 / SSR）里不存在：先探再 instanceof，
        // 不能直接引用全局构造器——这个函数现在会被测试直接调用。
        const element = typeof HTMLElement !== 'undefined' && target instanceof HTMLElement ? target : undefined;
        const rect = element?.getBoundingClientRect();
        if (rect === undefined)
            return { left: 12, top: 120 };
        return {
            left: Math.max(12, rect.left - 6),
            top: rect.bottom + 8,
            source: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        };
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
    /**
     * 关闭：叉号（模态右上角那一个）。
     *
     * 为什么两个模态都要它：只靠底部的「关闭 / 取消」时，用户想退出得先把视线移到右下角；
     * 右上角 X 是对话框的通用出口，成本只有一枚自绘字形。
     */
    function IconClose(props) {
        return (React.createElement(Glyph, { name: "close", size: props.size },
            React.createElement("path", { d: "M4.4 4.4 11.6 11.6" }),
            React.createElement("path", { d: "M11.6 4.4 4.4 11.6" })));
    }
    /** 打开任务根目录：右上箭头（"甩出去"语义，与官方的外部打开同义）。 */ function IconRightUp(props) {
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
     * 转正：爱心（用户点名要的形状——「给喜欢的工作区转正」）。
     *
     * 坐标是官方那套 24 网格爱心路径按 16/24 等比缩过来的（圆弧半径 5.5→3.67、圆心与端点同比例），
     * 所以小尺寸下不会歪；只描边不填充，与行内其它字形同一规格。
     */
    function IconHeart(props) {
        return (React.createElement(Glyph, { name: "heart", size: props.size },
            React.createElement("path", { d: "M13.89 3.07a3.67 3.67 0 0 0-5.19 0L8 3.78 7.29 3.07a3.67 3.67 0 0 0-5.19 5.19l.71.71L8 14.15l5.19-5.19.71-.71a3.67 3.67 0 0 0 0-5.19z" })));
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
        close: IconClose,
        question: IconQuestion,
        settings: IconSettings,
        heart: IconHeart,
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
        const anchorOf = anchorOfTarget;
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
        /** 打开「转正」面板（爱心按钮）。不带预选：面板自己挑第一个 active 的任务当默认。 */
        const openPromote = (event) => {
            swallow(event);
            tray.set({
                panel: 'promote',
                anchor: anchorOf(event.currentTarget),
                promoteTaskId: undefined,
            });
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
                React.createElement("button", { type: "button", className: "__tt_tiny", title: runtime.t('promote'), "aria-label": runtime.t('promote'), onClick: openPromote },
                    React.createElement(ICONS.heart, { size: 16 })),
                rootAction(props.canOpenPath ?? canOpen) === 'open' ? (React.createElement("button", { type: "button", className: "__tt_tiny", title: runtime.t('openRoot'), "aria-label": runtime.t('openRoot'), onClick: (event) => void openRoot(event) },
                    React.createElement(ICONS.external, { size: 16 }))) : (React.createElement("button", { type: "button", className: `__tt_tiny${copied ? ' __tt_tinyOk' : ''}`, title: copied ? runtime.t('copied') : runtime.t('copyRoot'), "aria-label": runtime.t('copyRoot'), onClick: (event) => void copyRoot(event) }, copied ? React.createElement(ICONS.check, { size: 16 }) : React.createElement(ICONS.copy, { size: 16 }))),
                React.createElement("button", { type: "button", className: "__tt_tiny", title: runtime.t('help'), "aria-label": runtime.t('help'), onClick: openHelp },
                    React.createElement(ICONS.question, { size: 16 })),
                React.createElement("button", { type: "button", className: "__tt_tiny", title: runtime.t('settingsTitle'), "aria-label": runtime.t('settingsTitle'), onClick: openSettings },
                    React.createElement(ICONS.settings, { size: 16 })))) : null));
    }
    function TemptaskTray(props) {
        const { runtime, tray } = props;
        // 配置通道可能由外部注入（离线渲染自测用），否则用 apply 时解析到的那个
        const scope = props.scope;
        const cache = props.cache;
        const [state, setState] = React.useState(() => tray.get());
        const [tasks, setTasks] = React.useState([]);
        const [snapshot, setSnapshot] = React.useState(null);
        React.useEffect(() => tray.subscribe(() => setState(tray.get())), [tray]);
        /**
         * 重读一次状态。打开浮层时（说明要显示数量/根目录，清理与转正要显示列表）以及转正成功后用它。
         * 顺手灌进共享快照：刚转正完的任务应当立刻从会话行菜单里消失，不必等下一次轮询。
         */
        const reload = React.useCallback(async () => {
            const result = await call('/state', 'GET');
            if (!result.ok)
                return;
            const value = result;
            setSnapshot(value);
            setTasks(value.tasks);
            cache?.set(value);
        }, [cache]);
        React.useEffect(() => {
            if (state.panel === 'none')
                return undefined;
            let alive = true;
            void call('/state', 'GET').then((result) => {
                if (!alive || !result.ok)
                    return;
                const value = result;
                setSnapshot(value);
                setTasks(value.tasks);
                cache?.set(value);
            });
            return () => {
                alive = false;
            };
        }, [state.panel, cache]);
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
                    React.createElement("span", { className: "__tt_val" }, snapshot?.rootDir ?? '…')),
                React.createElement("p", { className: "__tt_hint" }, runtime.t('linkHint')),
                halvesDiffer(snapshot?.pluginVersion, CLIENT_VERSION) ? (React.createElement("p", { className: "__tt_error" }, runtime.t('versionMismatch'))) : null,
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
                React.createElement("p", { className: "__tt_hint" }, runtime.t('moreSettings'))));
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
        if (state.panel === 'promote') {
            return (React.createElement(PromotePanel
            // 已经开着面板时又从会话行点了另一条任务：靠 key 重新挂载，预选才会真的换过去。
            , { 
                // 已经开着面板时又从会话行点了另一条任务：靠 key 重新挂载，预选才会真的换过去。
                key: state.promoteTaskId ?? 'default', runtime: runtime, tasks: tasks, home: snapshot?.home, 
                // 客户端已更新、host 还是旧代码（改完没重启 DSH）：/state 会缺新字段，
                // 面板里的默认值（例如目标父目录）就会是空的——这一条把它明说出来，别让人以为是坏输入框。
                staleHost: snapshot !== null && halvesDiffer(snapshot.pluginVersion, CLIENT_VERSION), initialTaskId: state.promoteTaskId, directoryPicker: props.directoryPicker, 
                // 成功后不关面板：先给一张结果卡，同时把列表刷新掉（任务已经不在临时列表里了）。
                onDone: () => void reload(), onClose: close }));
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
                await writeConfigField(scope, 'onDeleteSessions', next);
                setNotice(runtime.t('settingsSaved'));
                props.onSaved();
            }
            catch (cause) {
                setValue(props.policy);
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
        return (React.createElement(ModalShell, { closeLabel: runtime.t('close'), title: runtime.t('cleanTitle'), busy: busy, onClose: props.onClose, dataAttrs: { 'data-tt-dialog': 'clean' }, footer: React.createElement(React.Fragment, null,
                React.createElement("button", { type: "button", className: "__tt_btn", onClick: props.onClose, disabled: busy }, runtime.t('cancel')),
                React.createElement("button", { type: "button", className: "__tt_btn __tt_btnDanger", onClick: () => void run(), disabled: busy || selected.length === 0 }, busy ? runtime.t('cleaning') : `${runtime.t('confirmClean')}（${selected.length}）`)) },
            React.createElement("p", { className: "__tt_hint" }, props.policy === 'archive' ? runtime.t('cleanBodyArchive') : runtime.t('cleanBodyKeep')),
            tasks.length === 0 ? (React.createElement("p", { className: "__tt_hint" }, runtime.t('empty'))) : (React.createElement("div", { className: "__tt_group" },
                React.createElement("div", { className: "__tt_actions" },
                    React.createElement("button", { type: "button", className: "__tt_btn", onClick: () => setSelected(tasks.map((task) => task.id)) }, runtime.t('selectAll')),
                    React.createElement("button", { type: "button", className: "__tt_btn", onClick: () => setSelected([]) }, runtime.t('selectNone'))),
                React.createElement("div", { className: "__tt_list" }, tasks.map((task) => (React.createElement("label", { key: task.id, className: "__tt_item" },
                    React.createElement("input", { type: "checkbox", checked: selected.includes(task.id), onChange: () => toggle(task.id) }),
                    React.createElement("span", { className: "__tt_itemLabel", title: task.path }, labelOf(task)),
                    React.createElement("span", { className: "__tt_itemDir" }, task.dirName),
                    React.createElement("span", { className: "__tt_tag" }, task.status === 'active' ? runtime.t('active') : runtime.t('closed')),
                    task.live ? React.createElement("span", { className: "__tt_tag __tt_tagLive" }, runtime.t('liveTag')) : null,
                    !task.workspacePresent ? (React.createElement("span", { className: "__tt_tag" }, runtime.t('missingNode'))) : null)))))),
            tasks.some((task) => task.live) ? (React.createElement("p", { className: "__tt_hint" }, runtime.t('liveWarning'))) : null,
            error !== null ? React.createElement("p", { className: "__tt_error" },
                "\u274C ",
                error) : null));
    }
    /* ─────────────────────────── 转正（临时任务 → 正式工作区） ─────────────────────────── */
    /**
     * 上一次成功转正用的父目录。
     *
     * 为什么要记：转正的落点几乎总是同一个（"我的项目都放 D:\code"），每次重开面板都要重新选一遍
     * 会很烦。只记这一个字段、只写成功过的值——失败时用户改过的输入不该被"记住"。
     */
    const PROMOTE_DIR_KEY = '__tt_promoteDir';
    function readStoredPromoteDir() {
        try {
            const value = globalThis.localStorage?.getItem(PROMOTE_DIR_KEY);
            return typeof value === 'string' && value.length > 0 ? value : undefined;
        }
        catch {
            // 隐私模式 / 被策略禁用的宿主会直接抛。默认值退化成宿主用户目录即可，不该让面板打不开。
            return undefined;
        }
    }
    function writeStoredPromoteDir(dir) {
        try {
            globalThis.localStorage?.setItem(PROMOTE_DIR_KEY, dir);
        }
        catch {
            // 记不住落点不影响这次转正已经完成，静默跳过。
        }
    }
    function createStateCache() {
        let state = null;
        const listeners = new Set();
        return {
            get: () => state,
            set(value) {
                state = value;
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
    function isStateCache(value) {
        return (typeof value === 'object' &&
            value !== null &&
            typeof value.get === 'function' &&
            typeof value.subscribe === 'function');
    }
    /**
     * 订阅共享快照。
     *
     * `getSnapshot` 在两次 set 之间返回**同一个对象**（缓存自己持有它），这正是 useSyncExternalStore
     * 要求的不变量；第三个参数是 SSR（离线渲染自测）用的，必须给，否则服务端渲染会抛。
     */
    function useStateCache(cache) {
        return React.useSyncExternalStore(cache.subscribe, cache.get, cache.get);
    }
    /**
     * 这条会话属于哪个临时任务。
     *
     * 判据是 `TaskView.sessionIds`（host 把工作区里全部会话 ∪ 记录里最后一条都发过来了），
     * 而不是"最后一条会话"——任务名下的旧会话同样该被认出来。
     *
     * `Array.isArray` 那一层不是多余的：host 半边只在 DSH 启动时加载，而界面刷新一次就换了新代码，
     * 于是"客户端已是新版、host 还是旧版"（本插件自己就在气泡里警告这件事）时 `sessionIds` 会缺席。
     * 那种情况下这里必须只是"认不出来"，**绝不能抛**——这个函数跑在官方的会话行渲染里，
     * 抛出去会把整个侧边栏拖下水。
     */
    function findTaskBySession(state, sessionId) {
        if (state === null || sessionId.length === 0)
            return undefined;
        return state.tasks.find((task) => Array.isArray(task.sessionIds) && task.sessionIds.includes(sessionId));
    }
    /**
     * 默认选哪个任务。
     *
     * 顺序上把"**侧边栏还有节点**"排在前面：用户点爱心时，绝大多数是想把某个**还看得见的**
     * 临时任务转正；只剩文件夹的那些（节点被删过）是少数情况，交给过滤开关。
     */
    function initialPromoteTaskId(tasks, preferred) {
        if (preferred !== undefined && tasks.some((task) => task.id === preferred))
            return preferred;
        const withNode = tasks.filter((task) => task.workspacePresent);
        const pick = withNode.find((task) => task.status === 'active') ??
            withNode[0] ??
            tasks.find((task) => task.status === 'active') ??
            tasks[0];
        return pick?.id ?? '';
    }
    /**
     * 由「认得出来的一段文字」（会话标题 / 首条消息摘要）推一个可用的目录名。
     *
     * 为什么不再直接用时间戳当默认名：时间戳认不出是哪个对话（用户的原话）。标题/摘要里可能带
     * 路径非法字符、成串空白、结尾的点，所以这里按 host 的 `validateName` 那套规则先洗干净；
     * 洗不出东西（或撞上 Windows 保留名）就回落到原来的时间戳目录名——绝不生成一个 host 会拒绝的名字。
     */
    function folderNameFromText(text, fallback) {
        if (text === undefined)
            return fallback;
        const cleaned = text
            .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '-')
            .replace(/\s+/gu, '-')
            .replace(/-{2,}/gu, '-')
            .replace(/^[-.\s]+|[-.\s]+$/gu, '')
            .slice(0, 48)
            .replace(/[-.\s]+$/gu, '');
        if (cleaned.length === 0)
            return fallback;
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu.test(cleaned))
            return `_${cleaned}`;
        return cleaned;
    }
    /**
     * 候选列表的可见集合。
     *
     * 默认只给「侧边栏还有节点」的任务（用户点爱心时绝大多数是这种）；`showAll` 时给全部。
     * **一个带节点的都没有时退回全部**——否则模态看起来空空的，用户只会以为插件坏了。
     */
    function visiblePromoteTasks(tasks, showAll) {
        if (showAll)
            return tasks;
        const withNode = tasks.filter((task) => task.workspacePresent);
        return withNode.length > 0 ? withNode : tasks;
    }
    /**
     * 列表里第二行（小字、次要色）：**聊过的内容**。
     *
     * 优先级：会话标题 → 首条消息摘要 → 没有就没有（此时这一行不渲染，第一行的"工作区名"已经够认）。
     * 这两个值来自 `/candidates`（host 从官方投影与事件流里只读取出）；老 host 上两者都缺席，
     * 于是列表只剩工作区名——和以前一样，只是认不出内容。
     */
    function chatLineOf(task) {
        const candidate = task;
        if (candidate.sessionTitle !== undefined && candidate.sessionTitle.length > 0) {
            return candidate.sessionTitle;
        }
        if (candidate.preview !== undefined && candidate.preview.length > 0)
            return candidate.preview;
        return undefined;
    }
    /**
     * 第三行（可选、更小）：仅在"看名字看不出来"的时候补信息。
     *
     *   - 节点被改过名（工作区标题 ≠ 目录名）时补上目录名——否则时间戳那条线索就丢了；
     *   - 该任务名下有多条会话时补上条数——提醒你列表里显的是"其中一条"的内容。
     * 两者都没有就整行不渲染（常见的"未改名、单条会话"任务就只有两行）。
     */
    function metaLineOf(task, sessionWord) {
        const parts = [];
        if (labelOf(task) !== task.dirName)
            parts.push(task.dirName);
        const count = task.sessionCount;
        if (typeof count === 'number' && count > 1)
            parts.push(`${count} ${sessionWord}`);
        return parts.length === 0 ? undefined : parts.join(' · ');
    }
    /** 整行的 tooltip：路径 + 摘要（列表里放不下的细节都在这里）。 */
    function tooltipOf(task) {
        const candidate = task;
        const lines = [task.path];
        if (candidate.preview !== undefined && candidate.preview.length > 0)
            lines.push(candidate.preview);
        return lines.join('\n');
    }
    /**
     * 新目录名的默认值。
     *
     * 优先级：**会话标题**（DSH 自己总结的，最像"这个项目叫什么"）→ **首条用户消息摘要** →
     * 节点标题（= 时间戳目录名）。前两个来自 `/candidates`；老 host 上没有这条接口时自然落到时间戳。
     */
    function defaultPromoteName(task) {
        if (task === undefined)
            return '';
        const described = task;
        return folderNameFromText(described.sessionTitle ?? described.preview, labelOf(task));
    }
    /**
     * 预览用的路径拼接（**只是给人看的**）。
     *
     * 真正的落点由 host 归一化后决定，客户端不做路径规范化；这里只保证"父目录末尾有没有分隔符"
     * 都不会拼出 `D:\code\/name` 这种怪样子。父目录里用的是哪种分隔符，就跟着用哪种。
     */
    function joinPath(parent, name) {
        if (parent.length === 0)
            return name;
        if (parent.endsWith('/') || parent.endsWith('\\'))
            return `${parent}${name}`;
        return `${parent}${parent.includes('\\') && !parent.includes('/') ? '\\' : '/'}${name}`;
    }
    function buildPromoteBody(input) {
        return {
            id: input.taskId,
            name: input.name,
            parentDir: input.parentDir,
            carry: input.carry,
            open: input.open,
            confirm: true,
        };
    }
    /** 提交转正。抽成独立函数是为了离线自测能直接核对 URL 与请求体。 */
    async function promoteTask(input) {
        return await call('/promote', 'POST', buildPromoteBody(input));
    }
    /** 把各种形态的桥统一成"一个返回路径或 null 的函数"。 */
    function asPickerFn(value) {
        if (typeof value === 'function')
            return () => value();
        if (value !== null && typeof value === 'object') {
            const pick = value.pick;
            if (typeof pick === 'function') {
                return () => pick.call(value);
            }
        }
        return undefined;
    }
    /** 取桌面原生选择器桥（两个名字都不在时 undefined）。 */
    function desktopDirectoryPick() {
        const globals = globalThis;
        return asPickerFn(globals.__DSH_DIRECTORY_PICKER__) ?? asPickerFn(globals.__DSH_DESKTOP_PICK_DIRECTORY__);
    }
    /** 把"路径 / null / 空串"统一成"路径 或 null（取消）"。 */
    function normalizePickedPath(value) {
        return typeof value === 'string' && value.length > 0 ? value : null;
    }
    /**
     * 解析官方目录选择器。
     *
     * 服务名：0.2.0-rc.x 的每个 Remote namespace 就是一个独立服务 `remote.directoryPicker`
     * （官方 api-gateway 的 `remoteServiceKey`），再兜一层 `ctx.get('remote').directoryPicker`。
     */
    function createDirectoryPicker(ctx) {
        const namespaceOf = () => ctx.get('remote.directoryPicker') ??
            ctx.get('remote')?.directoryPicker;
        return {
            available: () => desktopDirectoryPick() !== undefined || typeof namespaceOf()?.pick === 'function',
            pick: async () => {
                // 桌面原生选择器优先：它在 Windows 上是**唯一**能真正弹出系统文件夹对话框的那条路。
                const native = desktopDirectoryPick();
                if (native !== undefined)
                    return normalizePickedPath(await native());
                const namespace = namespaceOf();
                if (namespace === undefined || typeof namespace.pick !== 'function') {
                    // 面板只在 available() 时才放出「浏览…」，正常到不了这里；真到了也只是表单里一行错误。
                    throw new Error('宿主未提供目录选择器');
                }
                const result = await namespace.pick();
                if (result === null || result === undefined)
                    return null;
                if (typeof result === 'string')
                    return normalizePickedPath(result);
                if (result.ok === true)
                    return normalizePickedPath(result.value);
                throw new Error(result.error?.message ?? 'directory picker failed');
            },
        };
    }
    /**
     * 会话行入口点击后的**唯一**动作：把托盘切到 promote 面板，并预选这条会话所属的任务。
     *
     * 抽成纯函数是为了可离线自测（SSR 里点不动）：测试直接调用它就能验证
     * "点一下真的打开了面板、预选的是哪个任务"。
     */
    function openPromoteForTask(deps, taskId, target) {
        deps.tray.set({ panel: 'promote', anchor: anchorOfTarget(target), promoteTaskId: taskId });
    }
    /**
     * 失败提示块。
     *
     * 为什么不做成一句 toast：TARGET_EXISTS / DIR_BUSY 的 hint 是**操作指引**（改个名字 /
     * 关掉占着这个目录的终端再试），飘过去等于没给。它停在表单里、跟着表单一起滚动，
     * 用户照着 hint 改完可以直接再点一次。
     */
    function PromoteErrorNote(props) {
        const { error } = props;
        return (React.createElement("div", { className: "__tt_errorBlock", "data-tt-promote-error": error.code ?? 'ERROR' },
            React.createElement("p", { className: "__tt_error" },
                "\u274C ",
                props.label !== undefined ? `${props.label}：` : '',
                error.message,
                error.code !== undefined ? React.createElement("span", { className: "__tt_code" }, error.code) : null),
            error.hint !== undefined && error.hint.length > 0 ? (React.createElement("p", { className: "__tt_hint" },
                "\uD83D\uDCA1 ",
                error.hint)) : null));
    }
    /**
     * 居中模态外壳 —— 与「清理任务」确认框**完全同一套**（`__tt_overlay` 遮罩 + `__tt_dialog` 居中卡片）。
     *
     * 为什么转正改用这个形态（用户点名的要求）：原来是锚在侧边栏那一行上的 `__tt_pop` 浮层
     * （`position:fixed`、宽 340px、`max-height:min(70vh,520px)`），而转正是插件里**内容最高**的面板
     * （任务列表 + 两组输入 + 两条说明 + 两个选项）。在 1080p / 高缩放的机器上，浮层的高度上限会把
     * 列表这类可压缩子项挤扁、把按钮挤出可视区。居中模态有 `min(520px, 100vw-48px)` 宽、
     * `calc(100vh-96px)` 高，空间足够，形态也和清理框一致——用户不必学两套。
     *
     * **点遮罩不关闭，两个模态都这样**（用户两次实测反馈）：面板里有可选中复制的长路径/标题，
     * 鼠标一拖就出界，一出界就把面板关掉——太容易误关（清理框那还会把勾选全丢掉）。
     * 出口只留两处：底部的「关闭 / 取消」按钮，以及 `Esc`（忙碌时不响应）。
     * 「清理任务」原本是点遮罩关闭，现在也走这一个外壳，行为与转正完全一致。
     */
    function ModalShell(props) {
        const label = typeof props.title === 'string' ? props.title : undefined;
        const { busy, onClose } = props;
        React.useEffect(() => {
            const onKey = (event) => {
                if (event.key !== 'Escape' || busy)
                    return;
                event.preventDefault();
                onClose();
            };
            window.addEventListener('keydown', onKey);
            return () => window.removeEventListener('keydown', onKey);
        }, [busy, onClose]);
        return (React.createElement("div", { className: "__tt_overlay", role: "presentation" },
            React.createElement("div", { className: "__tt_dialog", role: "dialog", "aria-modal": "true", "aria-label": label, ...props.dataAttrs },
                React.createElement("div", { className: "__tt_dialogHead" },
                    React.createElement("h2", { className: "__tt_dialogTitle" }, props.title),
                    React.createElement("button", { type: "button", className: "__tt_iconBtn", "data-tt-dialog-close": "true", "aria-label": props.closeLabel, title: props.closeLabel, onClick: onClose, disabled: busy },
                        React.createElement(ICONS.close, { size: 16 }))),
                props.children,
                React.createElement("div", { className: "__tt_dialogActions" }, props.footer))));
    }
    /**
     * 「转正」面板：一次只转正一个任务（目录会被搬走，没有"批量"的安全语义）。
     *
     * 三步：表单 → 面板内二次确认 → 结果卡。请求固定带 `confirm: true`（确认步骤就在面板里，
     * 不应该再有第二个 `window.confirm`）。
     */
    function PromotePanel(props) {
        const { runtime } = props;
        /**
         * 列表数据源。
         *
         * 先用 `/state` 那份（面板一打开就有内容，不等接口），`/candidates` 回来之后换成**带会话标题
         * 与首条消息摘要**的那份——临时任务的名字是时间戳，没有这两样认不出是哪个对话。
         * 候选接口缺席（老 host）时就一直是 `/state` 那份，功能照旧。
         */
        const [list, setList] = React.useState(() => props.tasks);
        const [readingTitles, setReadingTitles] = React.useState(props.tasks.length > 0);
        /** 默认只显示"侧边栏还有节点"的；点一下看全部（含只剩文件夹的）。 */
        const [showAll, setShowAll] = React.useState(false);
        React.useEffect(() => {
            let alive = true;
            void (async () => {
                const result = await call('/candidates', 'POST', {});
                if (!alive)
                    return;
                setReadingTitles(false);
                if (result.ok)
                    setList(result.tasks);
            })();
            return () => {
                alive = false;
            };
        }, []);
        const withNode = list.filter((task) => task.workspacePresent);
        /** 被过滤掉的数量（按钮上的计数）。 */
        const withoutNode = list.length - withNode.length;
        const showOnlyWithNode = !showAll && withNode.length > 0;
        const visible = visiblePromoteTasks(list, showAll);
        const [taskId, setTaskId] = React.useState(() => initialPromoteTaskId(list, props.initialTaskId));
        const [name, setName] = React.useState(() => defaultPromoteName(list.find((task) => task.id === taskId)));
        const [parentDir, setParentDir] = React.useState(() => readStoredPromoteDir() ?? props.home ?? '');
        const [carry, setCarry] = React.useState(true);
        const [open, setOpen] = React.useState(true);
        const [step, setStep] = React.useState('form');
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState(null);
        const [result, setResult] = React.useState(null);
        /** 「浏览…」出不出现：只有官方目录选择器真的在时才放出来。 */
        const [canBrowse, setCanBrowse] = React.useState(() => props.directoryPicker?.available() === true);
        // 任务列表是打开面板时才拉回来的（异步）：到位后补齐默认预选与默认目录名。
        React.useEffect(() => {
            if (list.length === 0)
                return;
            if (!list.some((task) => task.id === taskId)) {
                setTaskId(initialPromoteTaskId(list, props.initialTaskId));
            }
        }, [list, taskId, props.initialTaskId]);
        // 换任务 = 换默认目录名（用户手动改过的名字会被下一次换任务覆盖，这是预期行为）。
        React.useEffect(() => {
            setName(defaultPromoteName(list.find((task) => task.id === taskId)));
        }, [list, taskId]);
        // 默认父目录的第二顺位：localStorage 没记录时用宿主用户目录（快照可能晚一拍到）。
        React.useEffect(() => {
            if (parentDir.length > 0)
                return;
            if (props.home !== undefined && props.home.length > 0)
                setParentDir(props.home);
        }, [props.home, parentDir]);
        // 官方 Remote 命名空间是挂载期才注册的：面板打开时再探一次，
        // 免得"apply 那一刻还没挂上"就把「浏览…」永久藏起来。
        React.useEffect(() => {
            if (canBrowse)
                return;
            if (props.directoryPicker?.available() === true)
                setCanBrowse(true);
        }, [canBrowse, props.directoryPicker]);
        const selected = list.find((task) => task.id === taskId);
        /** 走官方目录选择器；取消（null）什么都不改，失败则把原因留在表单里。 */
        const browse = async () => {
            const picker = props.directoryPicker;
            if (picker === undefined)
                return;
            setError(null);
            try {
                const picked = await picker.pick();
                if (picked !== null)
                    setParentDir(picked);
            }
            catch (cause) {
                setError({
                    message: runtime.t('promoteBrowseFailed'),
                    hint: String(cause?.message ?? cause),
                });
            }
        };
        /** 表单 → 确认步骤：只做本地校验，一个字节都不发出去。 */
        const review = () => {
            if (selected === undefined)
                return;
            if (name.trim().length === 0) {
                setError({ message: runtime.t('promoteNeedName') });
                return;
            }
            if (parentDir.trim().length === 0) {
                setError({ message: runtime.t('promoteNeedParent') });
                return;
            }
            setError(null);
            setStep('confirm');
        };
        const run = async () => {
            if (selected === undefined || busy)
                return;
            setBusy(true);
            setError(null);
            const response = await promoteTask({
                taskId: selected.id,
                name: name.trim(),
                parentDir: parentDir.trim(),
                carry,
                open,
            });
            setBusy(false);
            if (!response.ok) {
                // host 的 message/hint 已经是给人看的（含"目标已存在，换个名字"这类指引）——原样落进表单。
                setError({ code: response.code, message: response.message, hint: response.hint });
                setStep('form');
                return;
            }
            setResult(response);
            setStep('done');
            writeStoredPromoteDir(parentDir.trim());
            // 新会话由官方 uiWorkspace.openSession 打开（带重试，见 createOpenSession）。
            if (open && response.sessionId !== undefined)
                runtime.openSession(response.sessionId);
            props.onDone?.(response);
        };
        if (step === 'done' && result !== null) {
            return (React.createElement(ModalShell, { closeLabel: runtime.t('close'), dataAttrs: { 'data-tt-promote-state': 'done' }, title: `✅ ${runtime.t('promoteDoneTitle')}`, busy: busy, onClose: props.onClose, footer: React.createElement("button", { type: "button", className: "__tt_btn __tt_btnPrimary", onClick: props.onClose }, runtime.t('ok')) },
                React.createElement("div", { className: "__tt_kv" },
                    React.createElement("span", { className: "__tt_key" }, runtime.t('promoteFrom')),
                    React.createElement("span", { className: "__tt_val" }, result.from),
                    React.createElement("span", { className: "__tt_key" }, runtime.t('promoteTo')),
                    React.createElement("span", { className: "__tt_val" }, result.to),
                    React.createElement("span", { className: "__tt_key" }, runtime.t('promoteWorkspace')),
                    React.createElement("span", { className: "__tt_val" }, result.workspaceId),
                    React.createElement("span", { className: "__tt_key" }, runtime.t('promoteHistory')),
                    React.createElement("span", { className: "__tt_val" },
                        result.historyCarried ? runtime.t('promoteHistoryYes') : runtime.t('promoteHistoryNo'),
                        result.historyReason !== undefined && result.historyReason.length > 0
                            ? `（${result.historyReason}）`
                            : ''),
                    React.createElement("span", { className: "__tt_key" }, runtime.t('promoteArchived')),
                    React.createElement("span", { className: "__tt_val" }, result.sessionsArchived),
                    React.createElement("span", { className: "__tt_key" }, runtime.t('promoteCanceled')),
                    React.createElement("span", { className: "__tt_val" }, result.sessionsCanceled)),
                result.moved === 'copy' ? (React.createElement("p", { className: "__tt_hint" },
                    "\u2139\uFE0F ",
                    runtime.t('promoteCopied'))) : null,
                result.sessionId !== undefined ? (React.createElement("p", { className: "__tt_hint" }, runtime.t('promoteOpenHint'))) : null));
        }
        if (list.length === 0) {
            return (React.createElement(ModalShell, { closeLabel: runtime.t('close'), dataAttrs: { 'data-tt-promote-state': 'empty' }, title: runtime.t('promoteTitle'), busy: busy, onClose: props.onClose, footer: React.createElement("button", { type: "button", className: "__tt_btn", onClick: props.onClose }, runtime.t('close')) },
                React.createElement("p", { className: "__tt_hint" }, runtime.t('promoteIntro')),
                React.createElement("p", { className: "__tt_hint" }, runtime.t('promoteEmpty'))));
        }
        if (step === 'confirm' && selected !== undefined) {
            return (React.createElement(ModalShell, { closeLabel: runtime.t('close'), dataAttrs: { 'data-tt-promote-state': 'confirm' }, title: runtime.t('promoteConfirmTitle'), busy: busy, onClose: props.onClose, footer: React.createElement(React.Fragment, null,
                    React.createElement("button", { type: "button", className: "__tt_btn", onClick: () => setStep('form'), disabled: busy }, runtime.t('promoteBack')),
                    React.createElement("button", { type: "button", className: "__tt_btn __tt_btnPrimary", onClick: () => void run(), disabled: busy, "data-tt-promote-submit": "true" }, busy ? runtime.t('promoteRunning') : runtime.t('promoteConfirm'))) },
                React.createElement("p", { className: "__tt_hint" }, runtime.t('promoteConfirmBody')),
                React.createElement("div", { className: "__tt_kv" },
                    React.createElement("span", { className: "__tt_key" }, runtime.t('promoteFrom')),
                    React.createElement("span", { className: "__tt_val" }, selected.path),
                    React.createElement("span", { className: "__tt_key" }, runtime.t('promoteTo')),
                    React.createElement("span", { className: "__tt_val" }, joinPath(parentDir.trim(), name.trim()))),
                React.createElement("p", { className: "__tt_hint" }, carry ? runtime.t('promoteConfirmCarry') : runtime.t('promoteConfirmNoCarry')),
                selected.live ? React.createElement("p", { className: "__tt_hint" },
                    "\u26A0\uFE0F ",
                    runtime.t('promoteLiveHint')) : null,
                error !== null ? React.createElement(PromoteErrorNote, { error: error, label: runtime.t('promoteFailed') }) : null));
        }
        return (React.createElement(ModalShell, { closeLabel: runtime.t('close'), dataAttrs: { 'data-tt-promote-state': 'form' }, title: runtime.t('promoteTitle'), busy: busy, onClose: props.onClose, footer: React.createElement(React.Fragment, null,
                React.createElement("button", { type: "button", className: "__tt_btn", onClick: props.onClose, disabled: busy }, runtime.t('close')),
                React.createElement("button", { type: "button", className: "__tt_btn __tt_btnPrimary", onClick: review, disabled: busy || selected === undefined, "data-tt-promote-review": "true" }, runtime.t('promoteSubmit'))) },
            React.createElement("p", { className: "__tt_hint" }, runtime.t('promoteIntro')),
            props.staleHost === true ? React.createElement("p", { className: "__tt_error" },
                "\u26A0\uFE0F ",
                runtime.t('promoteStaleHost')) : null,
            React.createElement("div", { className: "__tt_group" },
                React.createElement("div", { className: "__tt_groupHead" },
                    React.createElement("span", { className: "__tt_groupTitle" }, runtime.t('promoteTask')),
                    withoutNode > 0 ? (React.createElement("button", { type: "button", className: "__tt_link", "data-tt-promote-filter": "true", onClick: () => setShowAll((value) => !value) }, showOnlyWithNode
                        ? `${runtime.t('promoteFilterAll')}（${withoutNode}）`
                        : runtime.t('promoteFilterOnlyNode'))) : null),
                readingTitles ? React.createElement("p", { className: "__tt_hint" }, runtime.t('promoteReading')) : null,
                !showOnlyWithNode && withoutNode > 0 ? (React.createElement("p", { className: "__tt_hint" }, runtime.t('promoteNoNodeHint'))) : null,
                React.createElement("div", { className: "__tt_list", role: "listbox", "aria-label": runtime.t('promoteTask') }, visible.map((task) => {
                    /*
                     * 层级（用户点名）：**第一行 = 工作区名（= 节点标题，粗体）**，第二行才是"聊过的内容"
                     * （会话标题 / 首条消息摘要，小一号、次要色）。之前把内容放成了粗体主标题、工作区名
                     * 反而降到小字行——主副颠倒，认人时先看到的应该是"哪个工作区"，再看"聊了什么"。
                     */
                    const workspaceName = labelOf(task);
                    const chatLine = chatLineOf(task);
                    const meta = metaLineOf(task, runtime.t('promoteSessions'));
                    return (React.createElement("div", { key: task.id, role: "option", tabIndex: busy ? -1 : 0, "aria-selected": task.id === taskId, "aria-disabled": busy, className: `__tt_option${task.id === taskId ? ' __tt_optionOn' : ''}`, "data-tt-promote-task": task.id, onClick: () => {
                            if (!busy)
                                setTaskId(task.id);
                        }, onKeyDown: (event) => {
                            if (busy)
                                return;
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                setTaskId(task.id);
                            }
                        } },
                        React.createElement("span", { className: "__tt_optionHead" },
                            React.createElement("span", { className: `__tt_radio${task.id === taskId ? ' __tt_radioOn' : ''}` }),
                            React.createElement("span", { className: "__tt_itemLabel", title: tooltipOf(task) }, workspaceName),
                            task.live ? (React.createElement("span", { className: "__tt_tag __tt_tagLive" }, runtime.t('liveTag'))) : null,
                            !task.workspacePresent ? (React.createElement("span", { className: "__tt_tag" }, runtime.t('promoteNoNodeTag'))) : null),
                        chatLine !== undefined ? React.createElement("span", { className: "__tt_preview" }, chatLine) : null,
                        meta !== undefined ? React.createElement("span", { className: "__tt_itemDir" }, meta) : null));
                }))),
            React.createElement("div", { className: "__tt_group" },
                React.createElement("label", { className: "__tt_field" },
                    React.createElement("span", { className: "__tt_groupTitle" }, runtime.t('promoteName')),
                    React.createElement("input", { className: "__tt_input", "data-tt-promote-name": "true", value: name, spellCheck: false, onChange: (event) => setName(event.target.value) })),
                React.createElement("p", { className: "__tt_hint" }, runtime.t('promoteNameHint'))),
            React.createElement("div", { className: "__tt_group" },
                React.createElement("label", { className: "__tt_field" },
                    React.createElement("span", { className: "__tt_groupTitle" }, runtime.t('promoteParent')),
                    React.createElement("input", { className: "__tt_input", "data-tt-promote-parent": "true", value: parentDir, placeholder: runtime.t('promoteParentPlaceholder'), spellCheck: false, onChange: (event) => setParentDir(event.target.value) })),
                React.createElement("p", { className: "__tt_hint" }, runtime.t('promoteParentHint')),
                canBrowse ? (React.createElement("div", { className: "__tt_actions" },
                    React.createElement("button", { type: "button", className: "__tt_btn", onClick: () => void browse(), disabled: busy, "data-tt-promote-browse": "true" }, runtime.t('promoteBrowse')))) : null),
            React.createElement("div", { className: "__tt_group" },
                React.createElement("label", { className: "__tt_item" },
                    React.createElement("input", { type: "checkbox", "data-tt-promote-carry": "true", checked: carry, onChange: (event) => setCarry(event.target.checked) }),
                    React.createElement("span", { className: "__tt_itemLabel" }, runtime.t('promoteCarry'))),
                React.createElement("p", { className: "__tt_hint" }, runtime.t('promoteCarryHint')),
                React.createElement("label", { className: "__tt_item" },
                    React.createElement("input", { type: "checkbox", "data-tt-promote-open": "true", checked: open, onChange: (event) => setOpen(event.target.checked) }),
                    React.createElement("span", { className: "__tt_itemLabel" }, runtime.t('promoteOpen')))),
            error !== null ? React.createElement(PromoteErrorNote, { error: error, label: runtime.t('promoteFailed') }) : null));
    }
    /**
     * 没有菜单可关时的空 hook。
     *
     * 为什么要给一个常量而不是"有就调、没有就不调"：hooks 必须每次渲染都按同一个顺序调用，
     * 条件调用在宿主换了投影方式时会让 React 直接抛错。这个常量identity 稳定，永远安全。
     */
    const NO_MENU_STATE = () => [false, () => { }];
    /**
     * 会话行 "…" 菜单里的一行：只对"属于某个临时任务"的会话出现。
     *
     * 非任务会话（普通工作区的、未分组的）一律返回 null——这个动作在那里的语义是空的。
     */
    function PromoteSessionMenuItem(props) {
        const { runtime, tray } = props;
        const state = useStateCache(props.cache);
        const [, setMenuOpen] = (props.useMenuOpenState ?? NO_MENU_STATE)();
        const task = findTaskBySession(state, props.sessionId);
        if (task === undefined)
            return null;
        return (React.createElement("button", { type: "button", role: "menuitem", className: "__tt_menuItem", "data-tt-promote-session": task.id, onClick: (event) => {
                // 官方约定：动作先关菜单，再打开自己的浮层（否则菜单还挂在那儿，两层叠着）。
                setMenuOpen(false);
                openPromoteForTask({ tray }, task.id, event.currentTarget);
            } },
            React.createElement(ICONS.heart, { size: 16 }),
            React.createElement("span", { className: "__tt_itemLabel" }, runtime.t('promote'))));
    }
    /**
     * 会话行行尾的悬停按钮：同一个动作的第二个入口（"…" 菜单要两步，悬停按钮一步）。
     *
     * 不在这里 stopPropagation：官方文档明确说行尾按钮条自己会拦住点击
     * （"Clicks inside the strip stay in the strip"），再拦一次可能打断条子自己的处理。
     */
    function PromoteSessionRowAction(props) {
        const state = useStateCache(props.cache);
        const task = findTaskBySession(state, props.sessionId);
        if (task === undefined)
            return null;
        return (React.createElement("button", { type: "button", className: "__tt_tiny", title: props.runtime.t('promote'), "aria-label": props.runtime.t('promote'), "data-tt-promote-session-row": task.id, onClick: (event) => openPromoteForTask({ tray: props.tray }, task.id, event.currentTarget) },
            React.createElement(ICONS.heart, { size: 16 })));
    }
    /* ─────────────────────────── 常驻守护组件 ─────────────────────────── */
    /**
     * 常驻（注册在 shell.overlay，渲染 null）。
     *
     * 消费 host 的 pendingOpen：`/temptask new`、`/temptask open` 以及行上主区的「新建」都只是在 host 侧登记
     * 一个请求，真正把会话切到前台必须由页面来做。会话刚创建时客户端可能还没收到会话列表更新，
     * 所以这里带重试（见 runtime.openSession）。
     *
     * 顺带一提：这条 2.5s 的轮询同时是 `/state` **共享快照**（StateCache）的唯一刷新源——
     * 会话行槽位要反查"这条会话属于哪个任务"，就靠它，不再另起一条轮询。
     */
    function PendingOpenWatcher(props) {
        const { runtime, cache } = props;
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
                        const value = result;
                        cache?.set(value);
                        const pending = value.pendingOpen;
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
        }, [runtime, cache]);
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
        /** 用户改过但还没保存时为 true：期间不让后台拉取覆盖草稿。 */
        const [edited, setEdited] = React.useState(false);
        const pull = React.useCallback(async () => {
            const result = await call('/state', 'GET');
            if (result.ok)
                setState(result);
        }, []);
        React.useEffect(() => {
            // 值的权威来源是 host 的 /state（它给的是「归一化后的生效配置」——空值已经落到平台默认）。
            // 配置桥只负责「别处改了配置就把我们叫醒」：0.2.0 的官方「设置 → 插件」表单与齿轮
            // 写的是同一处，所以订阅它能立刻反映出来。
            if (scope !== undefined && typeof scope.load === 'function')
                void scope.load();
            const unsubscribe = scope !== undefined && typeof scope.subscribe === 'function' ? scope.subscribe(() => void pull()) : null;
            void pull();
            return () => {
                if (unsubscribe !== null)
                    unsubscribe();
            };
        }, [scope, pull]);
        React.useEffect(() => {
            if (state !== null && !edited)
                setDraft(state.config);
        }, [state, edited]);
        const save = async () => {
            setBusy(true);
            setNotice(null);
            setError(null);
            try {
                await writeConfigField(scope, 'rootDir', draft.rootDir);
                await writeConfigField(scope, 'autoCleanDays', Number(draft.autoCleanDays) || 0);
                setEdited(false);
                setNotice(runtime.t('saved'));
                await pull();
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
                    React.createElement("input", { className: "__tt_input", value: draft.rootDir, placeholder: "<DSH_HOME>/dsh-temptask", onChange: (event) => {
                            setEdited(true);
                            setDraft({ ...draft, rootDir: event.target.value });
                        } })),
                React.createElement("label", { className: "__tt_field" },
                    React.createElement("span", { className: "__tt_label" }, runtime.t('autoCleanDays')),
                    React.createElement("input", { className: "__tt_input", type: "number", min: 0, value: String(draft.autoCleanDays), onChange: (event) => {
                            setEdited(true);
                            setDraft({ ...draft, autoCleanDays: Number(event.target.value) || 0 });
                        } })),
                React.createElement("p", { className: "__tt_hint" }, runtime.t('autoCleanHint')),
                React.createElement("p", { className: "__tt_hint" },
                    runtime.t('configSource'),
                    "\uFF1A",
                    configSourceLabel(state?.configSource, runtime),
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
            /** 打开会话（实现见模块级的 createOpenSession）。 */
            const openSession = createOpenSession(ctx);
            const runtime = {
                t,
                openSession: (sessionId) => openSession(sessionId),
                notice: (message) => ctx.logger?.info?.(`[dsh-temptask] ${message}`),
            };
            const tray = createTray();
            /**
             * `/state` 的共享快照：会话行槽位（官方 list slot）只拿得到 `sessionId`，要判断它属于哪个
             * 临时任务就得有一份 `sessionIds` 账本。刷新源复用**既有的那条** 2.5s 轮询
             * （PendingOpenWatcher）以及浮层打开时的一次拉取，不新增轮询。
             */
            const stateCache = createStateCache();
            /** 官方目录选择器（`ctx.remote.directoryPicker`）；`available()` 为假时 promote 面板隐藏「浏览…」。 */
            const directoryPicker = createDirectoryPicker(ctx);
            /**
             * 配置通道（齿轮里的「删除策略」与设置卡片共用它）：
             * 0.2.0-rc.1 是 `configForms`，0.1.x 是 `settingsScope`，都没有就走 `/api/config`。
             */
            const settingsScope = resolveConfigScope(ctx);
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
            // 浮层：说明气泡 / 清理确认框 / 齿轮设置 / 转正面板 / 失败提示 + 消费 pendingOpen 的常驻守护
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
                    // 下面两项同样允许离线渲染自测注入；生产环境用 apply 时解析到的
                    directoryPicker: injected.directoryPicker !== undefined &&
                        typeof injected.directoryPicker.pick === 'function'
                        ? injected.directoryPicker
                        : directoryPicker,
                    cache: isStateCache(injected.cache) ? injected.cache : stateCache,
                });
            }));
            slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', id: `${NS}-pending-open`, order: 210, label: 'ds-temptask pending open' }, 
            // 这条常驻轮询同时把 /state 灌进共享快照（会话行槽位靠它反查会话归属）
            () => React.createElement(PendingOpenWatcher, { runtime, cache: stateCache })));
            /**
             * 官方**会话行**上的两个槽位（都由 `ui-workspace` 声明，所以必须走 `slots.inject` 等它出现）：
             *   - `sidebar.workspaces.session.menu.item`："…" 菜单里的一行（order 500 = 排在官方
             *     pin 100 / rename 200 / fork 300 / archive 400 之后，形成"插件动作"那一组）；
             *   - `sidebar.workspaces.session.row.action`：行尾悬停按钮（order 150 = 夹在 archive 与 pin 之间）。
             *
             * 两者都只渲染"属于某个临时任务的会话"（用共享快照里的 sessionIds 反查），
             * 点了就打开同一个托盘面板并预选那个任务。`id` 用包命名空间，绝不复用官方 id（那会遮蔽它）。
             */
            slots.inject('sidebar.workspaces.session.menu.item', () => slots.register({
                name: 'sidebar.workspaces.session.menu.item',
                id: `${NS}-promote`,
                order: 500,
                label: () => t('promote'),
            }, (raw) => {
                const injected = raw;
                return React.createElement(PromoteSessionMenuItem, {
                    sessionId: typeof injected.sessionId === 'string' ? injected.sessionId : '',
                    runtime: isRuntime(injected.runtime) ? injected.runtime : runtime,
                    tray: isTray(injected.tray) ? injected.tray : tray,
                    cache: isStateCache(injected.cache) ? injected.cache : stateCache,
                    ...(typeof injected.useMenuOpenState === 'function'
                        ? {
                            useMenuOpenState: injected.useMenuOpenState,
                        }
                        : {}),
                });
            }));
            slots.inject('sidebar.workspaces.session.row.action', () => slots.register({
                name: 'sidebar.workspaces.session.row.action',
                id: `${NS}-promote`,
                order: 150,
                label: () => t('promote'),
            }, (raw) => {
                const injected = raw;
                return React.createElement(PromoteSessionRowAction, {
                    sessionId: typeof injected.sessionId === 'string' ? injected.sessionId : '',
                    runtime: isRuntime(injected.runtime) ? injected.runtime : runtime,
                    tray: isTray(injected.tray) ? injected.tray : tray,
                    cache: isStateCache(injected.cache) ? injected.cache : stateCache,
                });
            }));
            // 设置卡片：0.2.0-rc.1 与 0.1.x 都注册。
            // 配置通道（configForms / settingsScope）拿不到时，卡片自己走插件 HTTP 接口——
            // host 端会把写入路由到 profile 补丁或 config.json，所以卡片不会因为宿主版本而消失。
            slots.inject('settings.section', () => slots.register({ name: 'settings.section', id: NS, order: 60, label: () => t('nav'), locale: NS }, () => React.createElement(SettingsSection, {
                scope: settingsScope,
                initial: defaultConfigShape(),
                runtime,
            })));
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
            // 构建期注入的版本：离线自测拿它和 package.json 对账，防止产物是旧版本构建的
            CLIENT_VERSION,
            rootAction,
            TemporaryTaskMark,
            TRAY_AUTO_CLOSE_MS,
            // 宿主接口适配层（离线渲染自测直接打这些函数，不必真的挂进宿主）
            resolveConfigScope,
            adaptConfigForm,
            writeConfigField,
            configSourceLabel,
            createOpenSession,
            // 转正：面板 + 两个官方会话行槽位的组件与它们用到的纯函数
            PromotePanel,
            PromoteErrorNote,
            PromoteSessionMenuItem,
            PromoteSessionRowAction,
            createStateCache,
            isStateCache,
            findTaskBySession,
            initialPromoteTaskId,
            defaultPromoteName,
            folderNameFromText,
            chatLineOf,
            metaLineOf,
            tooltipOf,
            visiblePromoteTasks,
            joinPath,
            buildPromoteBody,
            promoteTask,
            createDirectoryPicker,
            desktopDirectoryPick,
            normalizePickedPath,
            openPromoteForTask,
            anchorOfTarget,
            readStoredPromoteDir,
            writeStoredPromoteDir,
            PROMOTE_DIR_KEY,
            NO_MENU_STATE,
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
