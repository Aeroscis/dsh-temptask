# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循[语义化版本](https://semver.org/lang/zh-CN/)。

发布渠道：npm [`@aeroscis/dsh-temptask`](https://www.npmjs.com/package/@aeroscis/dsh-temptask) · 源码 <https://github.com/Aeroscis/dsh-temptask>

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
