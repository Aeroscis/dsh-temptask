# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循[语义化版本](https://semver.org/lang/zh-CN/)。

发布渠道：npm [`@aeroscis/dsh-temptask`](https://www.npmjs.com/package/@aeroscis/dsh-temptask) · 源码 <https://github.com/Aeroscis/dsh-temptask>

## [0.6.0] — 2026-11-06

### 兼容性：适配 DSH 0.2.2-rc.1（桌面版 DSH NEXT 2.0.22-next 内置的运行时）

- **版本门槛不用改**：宿主自己的 `evaluatePluginCompatibility`（`dsh-app-boot`）用
  `semver.satisfies(runtime, range, { includePrerelease: true })` 判定，`^0.2.0-rc.1`
  覆盖 `0.2.1-rc.2` / `0.2.1-rc.3` / `0.2.2-rc.1` / `0.2.2`，`0.3.0-rc.1` 才被拒。
  `engines.dsh` 与 peer 范围**保持原样**。实测用的是宿主自己那个函数（见 `docs/DESIGN.md` §6）。
- **修掉一处一直存在的资源占用**：`sessionQuery.observeSession()` 返回的其实是**租约**，
  不是普通快照——`dsh-session-query` 的 `preparedLease()` 会先 `refs += 1`，冷会话因此被
  钉在 `SessionCorpus` 的 LRU 缓存里，只有调用 `[Symbol.dispose]()` 才会 `refs -= 1` 并按容量淘汰。
  本插件此前读完不释放：「转正」逐条试候选会话、`/candidates` 逐条读标题与摘要，读过的日志
  会一直挂在观察缓存里。现在两条读路径都走 `sessions.ts` 的 `observeSessionSnapshot()`，
  读完立刻释放（有 `[Symbol.dispose]` 就调它，没有就当普通快照，0.1.x 起都兼容）。
  `scripts/smoke.mjs` 新增 2 项把「读一条还一条」变成判据。
  这条不是 0.2.2 才出现的问题：`dsh-session-query@0.1.5-rc.2` 的 `preparedLease` 已经是这个形状。
- **逐条核对未变**的接口：`workspaceRegistry`（`create/get/list/delete/resolveByPath` 与实体的
  `setTitle/attachSession/insertSessionBefore`，仍**没有** `setPath`，`attachSession` 仍按 realpath
  硬校验 cwd）、`sessionController`（`create/cancel/canOpenWorkspacePath/openWorkspacePath/fork`）、
  `agents.create` 的 `CreateAgentOptions`（`seed`/`inheritedEventCount`/`meta`/`setup`/`agentOptions`）、
  `sessionQuery.observeSession/listSessions` 的默认投影与返回值、
  `agentPresets.resolve/mount`、`agentDefaultModel.currentSelection`、`configEditor.edit`、
  `webServer.register`（`kind: 'exact' | 'prefix'`）、`commands.register`、
  `remote.directoryPicker.pick`，以及本插件占用的客户端插槽
  （`sidebar.panellist` / `main` / `shell.overlay` ×2 / `settings.section` /
  `sidebar.workspaces.session.menu.item` / `sidebar.workspaces.session.row.action`，
  本轮起再加 `settings.section.icon`）。
  主机的服务名（`sessionController` / `sessions` / `agents` / `sessionQuery` / `workspaceRegistry` /
  `agentPresets` / `agentDefaultModel` / `configEditor` / `webServer` / `commands` / `settings`）
  逐个在 0.2.2 的产物里确认过。
- **fork 种子的构造仍逐字节一致**：`check:seed-parity` 对着 `dsh-session@0.2.2-rc.1` 的真实
  `buildForkSeed` 跑 10 项全过。
- **`check:registration` 多验了一件事**（3 项 → 4 项）：除了 ModuleLoader 的注册 id，
  现在还拿宿主**真实的 `SlotCore`** 确认本插件注册的每个槽位都在宿主的声明表里。
  `slots.register` 遇到未声明的槽位会当场抛错，而这类错误此前只能靠人工看界面发现——
  槽位名写错时插件不报错，只是那一块界面静默消失。声明从宿主产物里现读，不是脚本里抄的表。
- **用上 0.2.2 新增的一处界面能力**：设置页左侧导航从这一版起给每个 `settings.section` 行
  渲染一枚图标（`settings.section.icon`，按 id 与 section 对齐；不注册就用通用齿轮）。
  本插件现在注册了它，图标与侧边栏那一行是同一枚自绘标记。老宿主没有这个槽位，
  `slots.inject` 不触发，行为与之前一致。
- **桌面版的新行为不影响本插件**：`DSH NEXT` 给宿主 HTTP 加了「渲染进程令牌」访问控制
  （`x-dsh-desktop-renderer` 头 + 403 `Browser access is disabled`）。桌面窗口里的请求由
  Electron 主进程自动补这个头，插件自己的 `/dsh-temptask/api/*` 因此照旧可达；浏览器直接访问
  那个端口本来就会被拦，与插件无关。

### 修正：关于「取消归档」与「删除会话」的说法

- **更正一处错误说法**：此前 README、设置项文案与清理确认框都写着「DSH 没有反归档入口」，这不成立。
  官方 `workspaceRegistry` 从 `0.1.7-rc.2` 起就有 `unarchiveSession`，0.2.x 还提供远程命令
  `workspace/unarchiveSession`；侧栏「视图选项 → 全部对话（显示已归档）」里即可取消归档，
  会话回到原位（工作区已删的落到「未分组」）。只有 `0.1.5-rc.2` 那版是"只有归档、没有放回"。
- **把「不能真正删除会话」改准确**：事实是 **DSH 不提供删除接口**——会话日志仅追加，
  `dsh-session-persistence` 明写 "No deletion or retention API — pruning stored sessions is
  out-of-band backend maintenance"。插件因此只归档、不碰日志文件；要彻底抹掉得在 DSH 关闭时
  自己删磁盘上的会话（带外维护）。
- **新增《想连痕迹一起清掉》**（README §3）：把「归档 / 删除工作区 / 删会话日志」三层拆开，列清删除工作区后
  仍留在磁盘上的四处（会话日志、投影缓存、`workspace.json` 的归档登记、运行日志）、`sessions` 目录名的编码规则、
  以及手工清理的顺序与前提；并说明 DSH 之外（NTFS USN、卷影副本、备份软件、同步盘）不在可控范围内。
- 只改文案与文档，**行为没有变化**。

## [0.5.0] — 2026-10-20

### 兼容性：适配 DSH 0.2.1-rc.2（桌面版 2026-10 中旬那条线）

- **版本门槛不用改**：新宿主的 `evaluatePluginCompatibility`（`dsh-app-boot`）用
  `semver.satisfies(runtime, range, { includePrerelease: true })` 判定，所以 `^0.2.0-rc.1`
  **覆盖 `0.2.1-rc.2`**——用宿主自己那个函数实测返回 `undefined`（兼容），`0.3.0-rc.1` 才被拒。
  `engines.dsh` 与 peer 范围**保持原样**。
- **代码只改了一处**：桌面注入的原生目录选择器桥改了名字。0.2.0 时代是
  `__DSH_DESKTOP_PICK_DIRECTORY__`（只在 win32 发布），0.2.1 起 preload **全平台**无条件发布
  `__DSH_DIRECTORY_PICKER__ = { pick }`，旧名字在 asar 里按字节搜已经不存在
  （官方 `dsh-client-ui-directory-picker-native` 读的也是新名）。「浏览…」现在按
  **新名 → 旧名 → `remote.directoryPicker`** 三级取：老桌面仍能用，新桌面直连系统对话框；
  顺带一个小改善——`dsh-host-directory-picker-auto` 的平台判定改成 `darwin || win32 → native`，
  所以 win32 上官方 remote 那条路**现在也通了**（0.2.0 时它被挡在 `browse` 后端上）。
- **逐条核对未变**的接口：`workspaceRegistry`（仍**没有** `setPath`，`attachSession` 仍按 realpath
  硬校验 cwd）、`sessionController.create/cancel/openWorkspacePath`、`agents.create` 的
  `CreateAgentOptions`（`seed`/`inheritedEventCount`/`meta`/`setup`）、
  `sessionQuery.observeSession`（默认投影仍给 `projections.values.agentPreset`）、
  `agentPresets.resolve/mount`、`agentDefaultModel.currentSelection`、`configEditor.edit`、
  `webServer.register`、`commands.register`，以及本插件占用的**六个客户端插槽**。
- **校验方式**（见 `docs/DESIGN.md` §6）：0.2.1 把运行时打包进 `app.asar`，普通工具读不到，所以用
  `_asar/extract.mjs`（本地脚手架，内置最小 asar 读取器）解出需要的包，再让
  `check:seed-parity` / `check:registration` 指向它——当前对着 `dsh-session@0.2.1-rc.2`
  的真实 `buildForkSeed` 仍是 10 项逐字节一致。

### 新增：转正（临时任务 → 正式工作区）

把某个临时任务**改名、搬到你要的目录、变成正式工作区**，并且**把这段对话一起带过去**。

- 三个入口：侧边栏那一行新增的**爱心按钮**（排在清理按钮后面，打开转正模态）；**会话行右键菜单**里的
  「转正此任务」（官方插槽 `sidebar.workspaces.session.menu.item`，只对临时任务的会话出现）；
  `/temptask promote <任务> --dir <父目录> [--name <新名>] [--yes]`。
- 转正界面是**居中模态**（与「清理任务」确认框同一套 `__tt_overlay` + `__tt_dialog` 外壳）：
  任务单选列表 → 三个决策 → 二次确认 → 结果卡。为什么不用贴边浮层：浮层是锚在那一行上的 340px 窄框、
  高度受 `min(70vh,520px)` 限制，而转正是本插件内容最高的面板，在 1080p/高缩放的机器上会被压扁
  （顺带修了一条通病：`. __tt_pop > *{flex:0 0 auto}`——浮层该自己滚动，不该把可压缩子项挤成一条空盒子）。
- 模态里只填三件事：**新目录名**、**目标父目录**（带官方目录选择器「浏览…」，取不到就手输）、
  **要不要把对话带过去**（默认带）。
- **对话确实跟着走**：用官方 fork 的种子机制在新 cwd 下重建一条**完整历史**的会话
  （`agents.create({ seed, inheritedEventCount, meta: { cwd: 新家, parentSession: 旧会话, isSeeded: true } })`），
  并照官方 `composeAgent` 那样把 Agent 预设 `mount` 上；旧会话按现有策略归档。
- 转正后该任务从 `tasks.json` 移除，因此**不再被自动清理**；新节点标题 = 新目录名
  （这正是 DSH 语义里的「显式 rename」，所以本插件依然**不调用** `setTitle`）。

### 可用性：转正列表「认得出是哪个对话」

- **每行的层级是"工作区名在上、聊过的内容在下"**：第一行粗体显示**工作区名**（= 节点标题，
  未改名时就是时间戳目录名），第二行小一号、次要色显示**聊过的内容**（会话标题 → 首条消息摘要），
  第三行只在"节点改过名"或"名下有多条会话"时补目录名 / 条数。早先版本把内容放成了粗体主标题、
  工作区名降级成小字，主副颠倒（用户实测指出）。
- **会话标题 + 首条消息摘要的来源**：标题读官方 `title` 投影
  （`dsh-session-title` 折叠出的 `session/title`，用户手动改名也走这里），摘要是事件流里第一条
  **非空** `user/message`（只有附件的消息跳过）。新增 `POST /api/candidates`：**不进 `/state`**
  那条 2.5 秒轮询的热路径，只在模态打开时调一次，host 侧按会话缓存 60 秒、最多读 30 条；
  读不到就退回时间戳，**绝不影响转正本身**。
- **一个任务名下挑"有内容的那条"会话**（实测修正）：本插件每次 `/temptask open` 都会在同一个
  任务目录里新开一条会话，于是**记录里的最后一条常常是空会话**（只有 permission/preset、
  sandbox/mode 几条事件），真对话躺在更早的那条里。现在按「第一条有标题 → 否则第一条有摘要」
  扫该任务名下最近 3 条会话（用户实测的那两个任务正是 4 行空会话 vs 179 行真对话）。
- **`新目录名` 的默认值跟着标题走**（洗成合法目录名：「修复登录页的 500 错误」→
  `修复登录页的-500-错误`），标题与摘要都没有才回落时间戳。
- **默认只列"侧边栏还有节点"的任务**，右上角「显示全部（N）」才把只剩文件夹的也列出来
  （**删工作区不会删文件夹，这是 DSH 的官方语义**）；一个带节点的都没有时自动退回全部并说明原因。
- 转正界面从"贴边浮层"改成**居中模态**（与「清理任务」同一套 `__tt_overlay` + `__tt_dialog` 外壳）：
  浮层的 `max-height` 会把任务列表挤扁、把按钮挤出可视区。
- **两个居中模态都点周围不再关闭**（实测反馈：选中标题/路径时鼠标一拖出界就把面板关了；
  清理框那还会把勾选全丢掉）。出口改为三处：**右上角 X**、底部按钮、`Esc`（忙碌时不响应）。
- **底部按钮顺序统一为「取消在左、主操作在最右」**：清理框是 `取消 / 确认清理`，转正表单原来是
  反的（`转正 / 关闭`），现在与确认步骤一致（`返回修改 / 确认转正`）。右上角 X 是自绘字形
  （`data-tt-icon="close"`），不依赖宿主图标包。
- 转正与「清理任务」**共用同一个 `ModalShell`**（清理框带 `data-tt-dialog="clean"` 标记）——
  同一插件里两个居中模态行为不同本身就是缺陷，收敛到一处就不会再各自漂移（冒烟测试也盯着
  按钮顺序与 X）。
- **转正模态按功能区排版**（用户实测反馈"各节颜色/字号差不多、没有视觉重心"）：每个功能区
  一个**描边卡片**（`__tt_group`：1px 边框 + 12px 圆角 + 内边距），卡内是
  **13px/600/主色的区标题**（要转正的任务 / 新目录名 / 目标父目录）+ 控件 + 12px/三级灰说明，
  过滤开关贴在区标题右侧。先试过"顶部一条 1px 分隔线"，反馈不够明显——改成**围一圈**才分得开。
  「清理任务」确认框也套同一套卡片（全选/全不选 + 勾选列表算一块），两个模态观感一致；卡片里
  那层任务列表因此去掉了自己的边框，避免"框中框"。
- **修掉样式注入的"新 DOM + 旧 CSS"**：`injectStyles()` 曾经在样式标签已存在时直接 `return`，
  而该模块可能被热替换 / 重复执行（`<style>` 不会跟着重生成），于是出现"X 已经渲染出来、
  但 `__tt_dialogHead` / `__tt_iconBtn` 的规则还没生效"——看起来就是 X 掉到标题底下、按钮没圆角
  （用户实测截图确认过）。现在会就地比对并更新 `textContent`。

### 面向用户的表面（只留用户需要的）

- **`?` 气泡瘦身**：删掉「记录文件 / 配置来源 / 版本（插件后端 + 插件界面）/ 与 dsh-side-session 的区别」
  这些实现细节与开发期信息——用户只需知道「有几个任务、根目录在哪、会话在哪儿、设置去哪改」。
  **版本只在两半真的不一致时**以一句「重启 DSH」的形式出现（那时它是可执行的动作，不是常驻噪音）。
- **设置面板删掉「与 dsh-side-session 的区别」整块**：插件之间的比较属于 README 的历史，不占界面。
- **转正模态改成描边卡片分区**（要转正的任务 / 新目录名 / 目标父目录 / 两个勾选），
  区标题 13px/600/主色、说明 12px 三级灰——早先各节同色同字号，整面板糊成一片。
- **文档拆分**：README 只留「装 / 用 / 数据在哪 / 排错 / 限制」（661 行 → 208 行）；
  架构、设计取舍、官方语义核对、开发与发版清单搬到 `docs/DESIGN.md`；README 末尾那张
  「dsh-temptask vs dsh-side-session」对比表**删除**（没人需要它，也不该出现在用户的第一屏）。

### 修复

- **转正丢对话（用户实测复现）**：转正只拿任务记录里的**最后一条**会话造种子，而本插件每次
  `/temptask open` 都会在同一个任务目录里新开一条会话——"最后一条是空会话"的任务就会
  **转正成功但历史没带过去**（`dsh-docs-official` 就是这样：最后一条 0KB、真对话在更早那条
  146KB 的会话里）。现在按"新→旧"逐条试候选会话，用**第一条能造出「已完成前缀」的**，
  并把跳过了几条、实际用了哪条写进日志与结果（`sourceSessionId`）。
- **新增排错级工具 `/temptask repair <工作区路径> [来源会话ID]`**（不是主线功能）：把某条
  **孤儿会话**（`cwd` 在任务根目录下、但目录已不存在）的历史，通过官方 fork 种子机制**复刻**成
  目标工作区下的一条新会话；**只读**旧日志，不删不改任何已存会话。它解决两件取消归档解决不了的
  事：① 转正时没带历史、事后想补；② 临时目录被删/清理后，原会话的 `cwd` 失效（取消归档只能让它
  回到「未分组」，工具与终端都用不了）。定位见 README《排错》。

### 为什么不是"改一下工作区路径"

`workspaceRegistry` 没有 `setPath`/`move`、会话 cwd 也没有任何官方改写入口，所以「搬家」只能编排成
搬目录 + 换一条会话。完整的证据链与被否掉的方案见 `docs/DESIGN.md` §4。

### 安全边界（都在冒烟测试里钉住）

- 目标已存在 → `TARGET_EXISTS`，**绝不覆盖**；目标落在任务根目录内部 → `BAD_REQUEST`
  （否则会被自动登记逻辑当成新的临时任务）；
- 搬目录被占用（Windows 上活着的会话/终端握着 cwd）→ `DIR_BUSY` + 「先关掉那个任务的会话/终端」，
  **此时一个字节都没动**（搬目录是唯一破坏性动作，且它最早）；
- 建新节点失败 → 目录**搬回原位**，不留「目录走了、节点没了」的半状态；
- 带历史是**尽力而为**：读不到事件流、没有已完成回合、或种子会话建不出来时，一律降级成
  「在新家开一条空会话」，并在结果里如实说明原因（`historyCarried` / `historyReason`）。

### 变更

- `TaskView` 新增 `sessionIds`（该任务名下全部会话），`/api/state` 新增 `home`（转正表单的默认父目录起点）；
- 新错误码 `TARGET_EXISTS`、`DIR_BUSY`；新路由 `POST /dsh-temptask/api/promote`（要求 `confirm: true`）；
- 新增 `src/seed.ts`、`src/promote.ts`；
- 测试：host 冒烟 50 → **65 项**（seed 纯函数 4 项 + 转正端到端 11 项）、client 冒烟 27 → **50 项**
  （转正 13 项），并新增 `scripts/check-seed-parity.mjs`（**10 项**）——它拿**宿主真实的**
  `buildForkSeed` 在同一批事件流上逐字节比对 `src/seed.js` 的输出，边界函数则从
  `dsh-api-session-controller` 的产物里按花括号配平切出源码现场编译后一起比对
  （防止"拿我们自己的边界比我们自己的种子"这种自证）。没有 DSH 的机器上自动跳过。
  现在的 `npm run check` = 发布形态 7 + host 65 + client 50 + 注册契约 3 + 种子一致性 10。

## [0.4.2] — 2026-10-09

### 兼容性（**无需升级也能用**：0.4.1 在 DSH 0.2.0-rc.2 上实测兼容）

- **DSH 0.2.0-rc.2 不需要任何代码适配**。逐包比对 0.2.0-rc.1 与 0.2.0-rc.2 的
  `@deepseek-ai/*` 运行时（81 个包，逐文件 SHA-1）：其中 75 个**只改了 `package.json`
  里的版本号**；12 个有代码改动的包里没有一个属于本插件依赖的宿主接口——
  `dsh-app-boot` / `dsh-settings` / `dsh-base` / `dsh-web-app` / `dsh-plugin-manager` /
  `dsh-session-projection` 的 lib **逐字节相同**；客户端目录（`dsh-cordis-client-runner`）
  只有新增（新插槽 `sidebar.right.tab.files.actions`、新会话节点类型 `question-reply`、
  会话头动作改名 `OpenInAppAction` → `SessionOpenInAppAction`），
  **没有删除或改名**本插件占用的 `sidebar.panellist` / `main` / `shell.overlay` / `settings.section`。
- **门槛实测，不是推演**：用 rc.2 的 `@deepseek-ai/dsh-app-boot` 里宿主自己那个判定函数
  `evaluatePluginCompatibility`（runtime = `0.2.0-rc.2`）跑本插件的 `package.json`，
  返回 `undefined`（= 兼容，不会出现 `skipping profile bundle`）。声明范围 `^0.2.0-rc.1`
  在严格口径与 `includePrerelease` 口径下都覆盖 `0.2.0-rc.2`，
  因此 **`engines.dsh` 与 peer 范围本次不作改动**。
- 对照（说明本插件为什么不受客户端版本线影响）：同机 `dsh-dream-skin@8.30.1` 因为声明了
  `@deepseek-ai/dsh-client-locale: ^0.1.0-rc.6` 这类 **client 包** peer，
  在 0.2.0-rc.1 与 rc.2 上都被宿主拒绝加载。本插件不声明任何客户端包 peer，
  客户端半边也不 import 宿主 client 包，所以躲开了这条线。

### 变更

- **文档**（本次唯一的改动）：
  - README《支持的 DSH 版本》把 `0.2.0-rc.2` 列入已实测行，并补上「门槛用宿主自己的判定函数实测」
    的做法与结论；
  - README《安装与卸载》与《排错》写明：**rc.2 起 Desktop 自带的命令运行时可以管理 desktop profile 的插件，
    而 npm CLI 仍然拒绝**（`desktop` 是 Electron 保留名，启动与配置 dump 同样拒绝）。

### 验证

- `npm run check` 全绿：typecheck（host + client 双 tsconfig，strict）+ build +
  发布形态自检 7 项 + host 冒烟 50 项 + client 冒烟 35 项 + 加载器注册契约 3 项。
- 注册契约那一项这次是对着**真实的 `@deepseek-ai/dsh-client-modules@0.2.0-rc.2`**
  跑的（`DSH_APP_ROOT` 指向解出的宿主机运行时）：`arrive()` 后宿主查得到工厂、
  短名对照查不到、宿主 `require("<包名>")` 拿到带 `inject`/`apply` 的插件对象，三条都过。

## [0.4.1] — 2026-10-01

### 修复

- **「两半版本不一致」是假告警**：0.4.0 只更新了 host 的版本常量，客户端半边的
  `CLIENT_VERSION` 还停在 `0.3.3`，于是设置卡片与 `?` 气泡一直显示
  `插件后端 v0.4.0 · 插件界面 v0.3.3 ⚠️`，并提示"重启 DSH 可让两半同时更新"——
  重启不会好转，因为发布产物里就是那个旧版本号（npm 上 0.4.0 的 `gitHead`
  正是含 `CLIENT_VERSION = '0.3.3'` 的那次提交）。
  **功能不受影响**：两半本来就是同一代构建，`halvesDiffer` 只驱动这一行显示，
  没有任何代码拿它当门槛；但这是一条用户可见的错误信息。

### 变更（防复发）

- **版本号不再手写**：`src/host.ts` 改为运行时从 `package.json` 现读
  （`lib/host.js` 与 `src/host.ts` 的 `../package.json` 都落在包根）；
  `src/client.tsx` 改为占位符 `__DSH_PLUGIN_VERSION__`，由 `scripts/build-client.mjs`
  在包装 ModuleLoader 包时注入 `package.json` 的 `version`——找不到占位符，
  或注入后产物里仍不含该版本号，都直接构建失败。
- **新增两道防漂移检查**：`check:pack` 断言已提交的 `client/client.js` 里的
  `CLIENT_VERSION` 等于 `package.json` 的版本（挂在 `prepack` 上，拦住旧产物被发布）；
  `smoke:client` 断言两半同版本时**不**告警、异版本时**必须**告警（带反向对照）。

### 验证

- `npm run check` 全绿：typecheck（host + client 双 tsconfig，strict）+ build +
  发布形态自检 7 项 + host 冒烟 50 项 + client 冒烟 35 项 + 加载器注册契约。
- 产物核对：`client/client.js` 里的 `CLIENT_VERSION` 与 host 现读的 `package.json`
  版本同为 `0.4.1`，两半从此不可能对不上。

## [0.4.0] — 2026-09-28

### 兼容性（**必须升级**：0.3.3 在 DSH 0.2.0-rc.1 上完全不加载）

- **DSH 0.2.0-rc.1 上插件被整条跳过**：新宿主在挂载任何 bundle 之前先核对插件的
  `@deepseek-ai/dsh*` peer 范围（`dsh-app-boot` 的 `evaluatePluginCompatibility`），
  不满足就**整条 bundle 跳过**（日志 `skipping profile bundle "@aeroscis/dsh-temptask"`），
  界面上「临时任务」那一行直接消失。0.3.3 声明的是 `@deepseek-ai/dsh-settings: ^0.1.5-rc.2`，
  而 `^0.1.5-rc.2` 的上界是 `<0.2.0-0`，装不下 `0.2.0-rc.1`。
  声明改为双范围 `^0.1.5-rc.2 || ^0.2.0-rc.1`（`engines.dsh`、`@deepseek-ai/dsh`、
  `@deepseek-ai/dsh-settings` 三处一致），两条线都能过门。
- **`@deepseek-ai/schemastery` 从"可选"变成"必需"**：本插件现在要导出 `Config`，
  只能真拿到 schemastery 才建得出 schema（旧宿主附带的是 3.18.2）。运行时仍然用动态 import，
  取不到时 `Config` 为 undefined、插件照常加载并退回配置文件通道。

### 变更

- **设置表单迁移到插件自己的 `Config` schema**：DSH 0.2.0-rc.1 删掉了
  `settingsNamespace()` 与 `ctx.settings.register(namespace, schema)` 那套命名空间注册表，
  改成「插件声明 Config，宿主按 volatile 字段投影表单」。于是：
  - `lib/index.js` 导出 `Config`（`rootDir` / `autoCleanDays` / `onDeleteSessions` / `dataDir`
    四个字段全部 `.volatile()`，带中文说明），官方「设置 → 插件 → 临时任务」表单据此渲染；
  - `apply(ctx, config)` 读字段时兼容两种形态：0.2.0 是**活引用**（`config.rootDir.get()`），
    0.1.x 是普通值；
  - 配置写入优先走 `ctx.configEditor.edit(entry, …)`（官方的 profile 补丁，与设置表单同一处），
    其次是 0.1.x 的 settings 命名空间，最后才是 `<dataDir>/config.json`；
  - 监听 `loader/volatile-update`：官方表单改完配置后重新读引用，必要时重新载入清单
    （改 `rootDir` 立即生效）；
  - 配置来源新增 `plugin-config`（设置卡片与 `?` 气泡按来源给出对应的说明文字）。
  - **旧宿主不受影响**：`ctx.settings.register` 仍然按可选探测，探测得到就照旧走命名空间。
- **打开会话改用 `uiWorkspace.openSession`**：0.2.0-rc.1 的客户端 `ctx.sessions` 换成了
  retain/binding/scope/fork 那套底层面，`sessions.open(id)` 已不存在；打开会话统一走
  `ctx.uiWorkspace.openSession(target)`（它一次做完"选中会话 + 切到对话面板"）。
  旧宿主上自动退回 `sessions.open` + `layout.selectPanel`。
- **客户端配置通道改用 `configForms`**：0.2.0-rc.1 的 `ctx.configForms.get(entryId)` 取代了
  `ctx.settingsScope.bind({ namespace })`（`entryId` 就是 profile 里那一行的 id，
  本插件为 `dsh-temptask`）。设置卡片不再依赖任一通道存在——拿不到就走插件自己的 HTTP 接口，
  因此**卡片在任何宿主上都会出现**（之前没有 `settingsScope` 就整块不注册）。
- 版本号提升到 `0.4.0`（配置所有权换了一代，且旧版在新宿主上不可用）。

### 测试

- `scripts/smoke.mjs`（40 → **50 项**）：新增 0.2.0 配置模型的用例——行配置为 volatile 引用时
  取值正确、来源标为 `plugin-config`、`/api/config` 走 `configEditor.edit`（断言不落
  `config.json` 且未改动字段原样保留）、改完根目录立刻生效、`loader/volatile-update` 后重读引用、
  没有 `configEditor` 时仍写 `config.json`，以及 `Config` schema 的 volatile 契约
  （3.18.4 标 4 次、3.18.2 一次都不标）与包入口确实导出 `Config`。
- `scripts/smoke-client.mjs`（27 → **34 项**）：新增「配置通道优先用 `configForms`、
  没有时才 `bind` settingsScope」「`ConfigForm.set` 返回 false 必须抛错并回退 `/api/config`」
  「`uiWorkspace.openSession` 优先、旧宿主退回 `sessions.open`」「配置来源标签」等用例；
  原「缺 `settingsScope` 就少注册一个插槽」改为「五条插槽恒在」。
- `scripts/check-registration.mjs`：适配两代 `makeRequire` 签名（0.1.x `(edges)` /
  0.2.x `(ownerId, edges)`），并说明 0.2.x 的运行时在 `app.asar` 里、需要
  `DSH_APP_ROOT=<解包目录>`；已在 **0.1.5-rc.2 与 0.2.0-rc.1 两份真实宿主实现**上各跑通一次。

### 验证

- 在一台真实的 DSH `0.2.0-rc.1` 宿主（官方桌面版随附的运行时）上装 0.4.0 实测：
  插件正常挂载（不再被跳过）、`/state` 报 `configSource: plugin-config`、
  `/create` `/delete` 全流程正常、`/api/config` 写入落进 profile 的 `cordis.patch.yml`
  并当场生效（重启后仍在）、`--dump-config-schema` 里四个字段都带 `x-cordis.volatile: true`。

## [0.3.3] — 2026-09-27

### 修复

- **同一个插件在不同 DSH 宿主上图标不一致**：行内图标改为**全部自绘 SVG**，不再
  `require('@deepseek-ai/dsh-client-ui-primitives')`。该包的图标导出名在 `0.1.7-rc.2` 里从
  `<Name>Outline<尺寸>`（`IconTrashOutline16`）改成了 `<Name>OutlineRegular|Medium`，
  旧名字取不到时 0.3.2 会**静默降级**成 `🧹 📂 ? ⚙` 这类文本/emoji 字形——于是同一份插件在
  `0.1.5-rc.2` 宿主（三方桌面 DSH Desktop 2.0.13）上是线框图标，在 `0.1.7-rc.2` 宿主
  （官方 DeepSeek Harness 桌面版）上变成 emoji。自绘之后宿主怎么改名都不影响本插件，
  字形规格对齐官方（`viewBox` 16、`currentColor`、1.4px 线宽），并带 `data-tt-icon` 记号便于排查。
  清单里随之去掉 `dsh.client.inject`（该条目只用于「先加载哪个 client 包」的排序，本包已不再需要，
  留着反而会在宿主移除该包时拖垮加载）；官方自己的插件文档同样要求不要 require 宿主 Client 包。
- **那一行贴不到「新建会话」正下方**：`sidebar.panellist` 注册的 `order` 从 `10` 改为 `-100`。
  `0.1.7-rc.2` 起官方 Web 端自己注册了一个「插件」面板行（`id: "plugins"`、`order: 0`、
  图标 `IconPluginPinwheelOutlineRegular`），而面板列表按 `order` **升序**渲染——`order: 10` 时那行
  「插件」永远压在本行上面（`0.1.5-rc.2` 宿主没有这行，所以只有官方端看起来"被挤开"）。
  取负值即可排到它前面；不用 `0`，并列名次只能靠 `sort` 稳定性决定先后。

### 测试

- `scripts/smoke-client.mjs`（25 → **27 项**）：工厂的 require 桩收紧为**只允许 `react`**、
  新增「`order` 必须为负」与「产物里不再出现宿主图标包 require」两条回归，
  图标断言改认自绘记号（`data-tt-icon` / `data-tt-mark`），去掉「官方图标集缺席时退回文本字形」那条
  （前提已不存在）；`scripts/check-pack.mjs` 同步改为断言清单里**没有** `dsh.client.inject`。

## [0.3.2] — 2026-09-27

> **npm 上没有这一版**：当时只把构建产物手工同步进了本机 profile，没有执行 `npm publish`
> （registry 上从 `0.3.1` 直接到 `0.3.3`）。升级请直接用 `0.3.3`。

### 修复

- **客户端半边加载失败**：ModuleLoader 注册 id 从短名 `dsh-temptask` 改为**包名 `@aeroscis/dsh-temptask`**。
  宿主 `dsh-client-modules` 用加载器条目名（= 包名）当模块图行 id，脚本装载后按这个 id 查工厂；
  id 对不上时整批 combo 脚本一起失败，界面报
  `bundle /plugins/… loaded without registering "@aeroscis/dsh-temptask" via __ModuleLoader__.load`
  （`0.3.0` / `0.3.1` 均受影响，插件在这一版之前根本无法挂载 UI）。
- 注册 id 不再手写：`scripts/build-client.mjs` 从 `package.json` 的 `name` 现读，构建后自检产物头部；
  `scripts/smoke-client.mjs` 的断言也改为与包名比对（回归用例：产物里必须恰好注册一次、且 id 等于包名，
  同时不得再出现短名）。短名仍然保留在设置命名空间与数据目录上（`NS` / `<DSH_HOME>/dsh-temptask`），
  它们与模块 id 无关，升级后既有任务目录与配置**不受影响**。

## [0.3.1] — 2026-09-27

### 兼容性

- 新增 `engines.dsh = ^0.1.5-rc.2` 声明（市场的兼容性判定读这个字段，或读对 `@deepseek-ai/dsh-*`
  核心包的 `peerDependencies`）；`peerDependencies` 里 DSH 核心包的版本也从 `*` 收紧为实际验证过的范围
  ——`*` 会被判定为「对任何 DSH 都兼容」；
- README 新增「支持的 DSH 版本」一节：声明范围、开发与验证环境、依赖的宿主能力与逐项降级行为。

### 文档

- 安装与卸载示例改用 `<profile>` 占位符，不再假设读者的 profile 名或本地路径；
- 第 8 节重写为「设计取舍」，逐条给出技术原因（为什么任务要做成工作区、为什么目录名即时间戳、
  为什么入口做成侧边栏一行）；
- 第 11 节拆分为「需要人工验收 / 发布前需要人工确认 / 已知限制」，限制条目直述不支持的能力；
- `?` 气泡里的版本标签由「主程序 / 界面」改为「插件后端 / 插件界面」，避免被误读成 DSH 自身的版本；
- 源码注释与用例标题统一为陈述事实的语气。

## [0.3.0] — 2026-09-27 · 首个公开版本

### 新增

- **临时任务模式**：一键在 `<DSH_HOME>/dsh-temptask/<年-月-日-时-分-秒>/` 创建隔离目录并开会话，不绑定任何长期工作空间。
  任务目录本身就是一个临时工作区，因此侧边栏白拿「任务节点 → 子会话」这棵树与全部原生操作
  （展开/收起、重命名、归档、删除、拖拽排序、搜索）——本插件一行树 UI 都不写。
- **侧边栏入口**：工作区列表上方一行 `标记 + 临时任务 │ 🗑 ⧉ ? ⚙`。主区**整块可点 = 新建**；右侧四个 28×28 次要动作；
  **不新增任何独立页面**（点主区只会新建，不会导航）。窄栏（折叠侧边栏）收成 36×36，只剩自绘的「临时任务」标记。
- **齿轮设置**：删除任务时如何处理它的会话 —— `archive`（默认：归档，从侧边栏消失）/ `keep`（留在官方「未分组」）。
  同一份配置也出现在「设置 → 插件 → 临时任务」，走官方 settings 命名空间，立即生效。
- **打开任务根目录**：走官方 `sessionController.openWorkspacePath`；宿主桌面不支持打开文件夹时，该按钮自动退回「复制根目录」。
  复制功能始终保留在齿轮面板里。
- **命令**：`/temptask list | new | open <ID|目录名|标题> | clean [--all] [--yes] | help`
  （刻意不占用通用词 `/task`；官方命令是 `compact` / `feedback` / `goal` 这种单词形式）。
- **说明气泡**（`?`）：悬浮详情，鼠标移开后 450ms 自动收起，无手动关闭按钮；内含任务数量、根目录、记录文件、
  配置来源、主程序/界面两半版本与已知边界。
- **自动清理**：`autoCleanDays > 0` 时，启动清理「已关闭且最后使用超过 N 天」的任务（与手动删除走同一条处置路径）。

### 数据与安全

- 任务清单 `tasks.json` 原子写入（临时文件 + rename）；**写入前在锁内重读磁盘**、按 id 合并、幂等，
  两个 profile 同时运行不会互相覆盖。
- 记录损坏 → 备份为 `tasks.json.bak` 并重建空清单，在设置卡片给出告警。
- 启动对账：目录已不存在的记录会被丢弃并告警；侧边栏节点被手工删除时，再次「打开」会按路径把工作区建回来（自愈）。
- 删除统一走 `disposeTask`：**先读工作区会话账目**（`WorkspaceEntity.sessionIds`，工作区一删账目就没了）→
  中止仍在运行的那一轮 → 删目录/节点/记录 → 按策略归档会话。
- **任务根目录里未被登记的内容永不被触碰**：`clean --all` 与自动清理都只处理记录在案的任务目录
  （有专门用例在真实文件系统上守护这一点）。
- 路径穿越防护：伪造 `dirName=../` 的记录会被拒绝，根目录外的文件不受影响。

### 已知边界

- 会话**无法真正删除**，只能归档：`sessionPersistence` 只提供 `create/open/flush/stat/list`，
  且文档明确日志是 append-only、永不重写——没有删除 API。绕过去直接删 `$DSH_HOME/sessions/**`
  会跳过 session-query 的内存缓存与 `session_projcache` 的 sqlite，本插件不做。
- 跨进程并发只保证「写前重读 + 按 id 合并」，仍存在亚毫秒级残留窗口（自动化测试是同进程双实例模拟）。
- 那一行内部的控件位于官方 `aria-hidden` 的字形槽内，屏幕阅读器读不到；同样的动作在
  「设置 → 插件 → 临时任务」与 `/temptask` 命令里都可键盘到达。

### 质量门槛

- `npm run check` = typecheck（host + client 双 tsconfig，strict）+ build + 发布形态自检 6 项 +
  冒烟测试 70 项（host 40 / client 24），**全部离线**。
- GitHub Actions 在每次 push / PR 运行同一套检查；已在 Windows 与 Linux 上通过。

### 公开前的内部迭代

`0.1.0` → `0.2.7` 为未公开发布的迭代版本。其间把入口从独立面板改为侧边栏原生一行，
把任务标识从「需要命名」改为「目录名即时间戳」，并修正了工作区节点标题被会话标题覆盖的问题。
