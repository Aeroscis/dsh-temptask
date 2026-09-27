# dsh-temptask — DSH 临时任务模式

给 DeepSeek Harness 增加「**临时任务**」：一键在 DSH 自己的目录下开一个隔离的临时工作目录，
并在里面开会话。实验、临时调试、一次性会话——即开即用、用完即弃。

- **任务目录就是工作区**：`<DSH_HOME>/dsh-temptask/<年-月-日-时-分-秒>/`，会话 cwd 就是它
- 因此侧边栏长成 DSH 原生的树：**任务节点 → 它的会话**，展开 / 归档 / 重命名 / 搜索 / 拖拽全部是官方能力
- **不用起名**：节点名就是时间戳目录名（DSH 对工作区的默认行为，本插件**不改写**它）；会话标题由 DSH 自动总结，显示在它下面的会话行上
- `/temptask list | new | open | clean | help` 命令（补充入口，日常点侧边栏即可）
- 清理有二次确认，删除前做路径穿越校验，**只删任务根目录下的子目录**；节点与记录一起清理

---

## 1. 安装

```powershell
# 默认 profile
dsh plugin add @aeroscis/dsh-temptask

# 指定 profile
dsh plugin --profile <profile> add @aeroscis/dsh-temptask

# 从本地源码目录安装（尚未发布到 registry 时）
dsh plugin --profile <profile> add /path/to/dsh-temptask
```

然后**重启 DSH**。重启后侧边栏顶部（「新建会话」按钮下方、工作区列表**上方**）多出一行
「**＋ 临时任务** │ 🗑 ⧉ ? ⚙」——**主区整块可点 = 新建临时任务**（不是一个小图标了），
右侧竖线分隔出四个次要动作：清理 / 打开（或复制）根目录 / 说明 / 设置；
**点标签不出任何页面**；窄栏时官方把这一行收成 36×36，只剩主区那个 ＋ ：

1. 点 `＋`（或 `/temptask new`）→ 目录 `<DSH_HOME>/dsh-temptask/<时间戳>/` 被创建，并在其中打开一条会话；
2. 侧边栏出现对应的**任务节点**，展开就是它的会话；给它发第一条消息后会生成会话标题（显示在会话行上），
   而**节点名始终保持那个时间戳目录名**——想换个名字就在节点上右键重命名（那是 DSH 自己的能力）；
3. `⚙` 里选「删除任务时怎么处理它的会话」，`?` 里是这份说明。

卸载：`dsh plugin --profile <profile> remove @aeroscis/dsh-temptask`。
任务目录与 `tasks.json` 不会被卸载流程删除，用菜单里的「清理临时任务」或手工删除。

### 支持的 DSH 版本

- **声明**：`package.json` 的 `engines.dsh` = `^0.1.5-rc.2`。市场的兼容性判定读的就是它，
  或读对 `@deepseek-ai/dsh-*` 核心包的 `peerDependencies`（`@deepseek-ai/schemastery` 另有版本线，
  不参与 DSH 版本判定）。**它判的是"范围是否满足"，不是"版本是否相等"**——插件的版本号是它自己的迭代序号，
  与 DSH 版本无关。
- **开发与验证环境**：DSH 运行时核心包 `0.1.5-rc.2`（桌面 App 自身显示 2.0.13，属另一条版本线）；
  Windows 与 Linux（GitHub Actions）各跑一遍全部检查。
- **依赖的宿主能力**（缺失时逐项降级，**任何一种缺失都不会让插件加载失败**）：
  `sessionController`（`create` / `cancel` / `openWorkspacePath`）、`workspaceRegistry`、`commands`、
  `webServer`、`settings`，以及插槽 `sidebar.panellist` / `main` / `shell.overlay` / `settings.section`
  与界面侧的 `@deepseek-ai/dsh-client-ui-primitives`。这些服务全部按可选读取。
- **怎么自查**：`?` 气泡底部显示本插件的两半版本（`插件后端 v…　·　插件界面 v…`）——
  这两个数是**插件自己的**，不要拿去和 DSH 版本比较；DSH 自身版本在 DSH 的关于页或市场里看。

升级 DSH 之后如果出现异常，先看 `?` 气泡里的插件版本，再用 `engines.dsh` 对照本插件的发布说明。

## 2. 项目结构

```
dsh-temptask/
├── package.json            # 插件元数据 + dsh 清单 + 构建/测试脚本
├── cordis.patch.yml        # 补丁层：把本插件行插入 profile 的组合
├── tsconfig.json           # host + 共享代码（strict，NodeNext）
├── tsconfig.client.json    # client（strict，DOM + JSX）
├── src/                    # ★ 类型化源码（唯一事实来源）
│   ├── host.ts             # Cordis 插件入口：name / inject / apply，装配全部部件
│   ├── types.ts            # host/client 共享类型（零运行时依赖）
│   ├── config.ts           # 配置归一化、settings schema、原子写 JSON
│   ├── paths.ts            # 路径/时间戳目录名/唯一化/路径穿越校验
│   ├── store.ts            # tasks.json 持久化（原子写 + 串行锁 + 跨进程重读 + 损坏备份重建）
│   ├── workspaces.ts       # ★ 临时工作区：建/查（**不改写标题**）/删 + 归档会话
│   ├── sessions.ts         # 会话创建（sessionController 主路径 + agents 降级）与挂载
│   ├── tasks.ts            # 业务核心：建/开/删/清理/自动登记/自动清理
│   ├── hooks.ts            # session/created、session/disposed、session/event(user|title)
│   ├── commands.ts         # /temptask 命令与参数解析
│   ├── routes.ts           # /dsh-temptask/api/* HTTP 桥（同源围栏 + JSON）
│   ├── client.tsx          # ★ client 侧：侧边栏面板行 + 动作页 + 清理对话框 + 设置卡片
│   ├── index.ts            # 包入口（重导出 host half）
│   └── dsh.d.ts            # DSH 接口的最小环境声明（见 §8）
├── lib/                    # 构建产物：host 运行时（ESM，DSH 加载的就是它）
├── client/client.js        # 构建产物：client 的 ModuleLoader 包
├── scripts/                # build-client / prepare / smoke / smoke-client
├── README.md
└── LICENSE
```

## 3. 界面（几乎全是原生能力）

| 位置 | 谁提供 | 内容 |
| --- | --- | --- |
| 侧边栏任务节点 + 展开后的会话 | **DSH 官方 WorkspaceBrowser** | 展开/收起、归档、重命名、搜索、拖拽排序、删除——本插件一行 UI 都不写 |
| 侧边栏**那一行**（`sidebar.panellist`） | 本插件 | 位置在「新建会话」按钮与工作区列表之间，一个 **`.5px border-l3 + button-elevated-fill + r12`** 的框（取值抄自官方 `.newSession`）：左边是**主区「标记 + 临时任务」，整块可点 = 新建**（`role="button"` + Enter/Space，hover 用 `button-floating-hover`）；中间 1px 分隔线；右边四个 28×28 次要图标（清理 / 打开或复制 / 说明 / 设置），**清理 hover 转危险色**。主区图标是**自绘**的「临时任务」标记（文件夹轮廓 + 右下角时钟徽标），四个次要图标复用官方图标集（`IconTrashOutline16`、`IconRightUpOutline16` / `IconCopyOutline16`、`IconQuestionOutline14`、`IconSettingsOutline16`），创建中显示官方 loading 图标 + 旋转动画。**点主区不出任何页面**；窄栏时官方把行收成 36×36，只剩那个标记 |
| 齿轮 → 精简设置（浮层） | 本插件 | 只放一个策略：**删除任务时如何处理它的会话** —— `归档会话（推荐）` / `留在未分组`。写入走 `settingsScope`（有 settings 服务时）或 `/api/config`（降级），与设置卡片同一个命名空间 |
| 说明气泡 / 清理确认框（`shell.overlay`） | 本插件 | `?` = 锚在该行下方的小气泡（任务数量 / 根目录 / 配置来源 / 记录文件 / **版本（插件后端 + 插件界面）** / 会话在哪 / 与 dsh-side-session 的区别 / 更多设置入口）。版本那一行会说清两半的区别：**插件后端**（Node 侧，只在 DSH 启动时加载 → 改插件要重启 DSH）与**插件界面**（按页面加载 → 刷新页面即更新）；两半不一致时会直接提示"重启 DSH"。它是**悬浮详情**：鼠标在气泡上就不动，离开约 0.6s 后自动收起——**没有手动关闭按钮**（再点一次 `?` 也会收起）；`🧹` = 居中确认框（勾选列表 + 二次确认）；`⚙` = 操作面板（**不会**自动收起）；另有创建失败时的小提示。都渲染在浮层里——不会被侧边栏裁掉，也不会嵌套进官方那个 `<button>` |
| 兜底空面板（`main`，key=`dsh-temptask`） | 本插件 | **渲染 null 并立刻切回 conversation**。那一行在官方源码里是导航按钮（`onClick: selectPanel(id)`，键盘 Enter/Space 也只走它）——有这个兜底，误触只会闪一下，绝不会出现空白页或新页面 |
| 清理对话框 | 本插件 | 任务勾选列表（默认勾选已关闭的）、全选/全不选、二次确认 |
| 设置 → 插件 → 临时任务 | 本插件（`settings.section`） | 根目录、自动清理天数、**删除策略**、配置来源、清理入口、与 dsh-side-session 的区别 |
| 常驻守护（`shell.overlay`，渲染 null） | 本插件 | 轮询 host 的 `pendingOpen`：`/temptask new`、`/temptask open` 之后自动把会话切到前台 |

**为什么点标签没有页面**：任务列表就是侧边栏里的树，入口只需要一行标签 + 几个按钮。
DSH 的树按「工作区归属」分组，而会话归到某个工作区当且仅当 `session.cwd === workspace.path`
（见 §8 证据），所以把任务目录本身做成工作区，就能白拿官方的整棵树；本插件只在那行里放四个动作，
**不替换任何官方 Slot、不新增任何导航目的地**。

行内图标复用官方 primitives（`@deepseek-ai/dsh-client-ui-primitives`）——文本符号（`＋ ⧉ ?`）的笔画
比官方图标细得多，塞进 28px 按钮里明显不搭。因此 `package.json` 声明了客户端依赖，让浏览器模块加载器
把该包排在本包之前（`require` 时它一定已就绪）：

```json
"dsh": { "client": { "inject": ["@deepseek-ai/dsh-client-ui-primitives"], "platform": "web" } }
```

取不到该包时（老宿主 / 图里没有这一行）自动退回文本字形（＋ / 🧹 / ⧉ / ?），UI 不会因此挂掉。

已知边界（来自官方插槽的约束，不是疏忽）：那一行官方是按「导航按钮」渲染的，行内内容落在
`aria-hidden` 的字形槽里——所以主区和四个小按钮对屏幕阅读器不可见（鼠标可用，每个都有 `title` 与
`aria-label`；主区用 `role="button"` + `tabIndex` 接键盘，因为官方那一行本身已是 `<button>`，
再嵌一个是真的非法 HTML）；同样的动作在「设置 → 插件 → 临时任务」与 `/temptask new | clean` 命令里
都可键盘到达。

另一个细节：官方 `PanelRow` 除了渲染字形槽，还会用注册的 `label` **再渲染一次标题**
（`{wide && <span className="panelTitle">{label}</span>}`），而这一行的可见文字由本插件自己渲染
（因为要「标签在左、按钮在右」）。两者叠加会出现两遍「临时任务」，所以本插件注入了一条**限定作用域**的样式：

```css
[class*="panelRow"]:has(.__tt_row) [class*="panelTitle"] { display: none }
```

只隐藏本行那一个重复标题，其它面板行不受影响；`label` 仍保持非空——官方用它做 tooltip 与无障碍名。

## 4. 命令

```text
/temptask list                       列出全部任务（ID / 目录 / 节点 / 状态 / 时间）
/temptask new                        新建任务并打开会话（目录名=时间戳，节点名就是它）
/temptask open <ID|目录名|标题>      打开任务；支持片段匹配，多个匹配会列出候选
/temptask clean <ID|目录名|标题>     删除任务目录与节点（**先预览**，加 --yes 才执行）
/temptask clean --all --yes          删除全部任务
/temptask help                       帮助
```

- 标题含空格用引号：`/temptask open "修复登录 bug"`、`/temptask clean "修复登录 bug" --yes`
- `clean` 的二次确认语义：第一次执行只打印**将要删除**的任务，必须追加 `--yes` 才真删
- `/temptask new`、`/temptask open` 登记 `pendingOpen`，前端在 2.5s 内自动切到该会话

## 5. 配置

主通道是 DSH 官方 settings 命名空间 `dsh-temptask`（「设置 → 插件 → 临时任务」可改，立即生效）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `rootDir` | `<DSH_HOME>/dsh-temptask` | 任务根目录（Windows 即 `C:\Users\<你>\.dsh\dsh-temptask`）。留空 = 默认 |
| `autoCleanDays` | `0` | `>0` 时，启动清理「已关闭且最后打开超过 N 天」的任务（会话按下面的策略处理） |
| `onDeleteSessions` | `archive` | 删除任务（含自动清理）时如何处理它的会话：`archive` = 归档（从侧边栏消失，日志保留）/ `keep` = 留在「未分组」。见 §6 |
| `dataDir` | `<DSH_HOME>/plugin-data/dsh-temptask` | 插件数据目录（改它需要重启 DSH 才切换记录文件） |

也可以在 `cordis.patch.yml` 的插件行里给初始值（优先级低于设置页）：

```yaml
- insert:
    - id: dsh-temptask
      name: '@aeroscis/dsh-temptask'
      config:
        autoCleanDays: 7
```

**降级通道**：宿主没有 settings 服务、或缺 `@deepseek-ai/dsh-settings`/`schemastery` 时，
插件不会加载失败，而是改用 `<dataDir>/config.json`（设置卡片会显示「配置来源」）。

## 6. 数据与文件布局

```
<DSH_HOME>/dsh-temptask/             ← 任务根目录（启动时自动重建；删除操作永不碰它本身）
├── 2026-09-27-14-30-00/             ← 一个任务 = 一个目录 = 一个临时工作区
│   └── …（会话在这里读写文件）
├── 2026-09-27-14-31-12/
└── …

<DSH_HOME>/plugin-data/dsh-temptask/
├── tasks.json                       ← 任务记录（原子写：先写 .tmp 再 rename）
├── tasks.json.bak                   ← 仅当记录损坏时生成
└── config.json                      ← 仅在没有 settings 服务时使用
```

- 目录名 = 本地时间戳 `YYYY-MM-DD-HH-mm-ss`；同一秒内重复创建会自动追加 `-2`，**绝不覆盖**
- 任务目录被手工删除 → **启动对账**会丢弃对应记录并告警（目录是任务的实体）
- 记录损坏 → 备份为 `tasks.json.bak`，重建空清单并在设置卡片显示告警
- 节点被手工删除 → 再次「打开」该任务时会**按路径把工作区建回来**（自愈）
- 删除任务 = 目录 + 侧边栏节点 + 记录；命名/删除策略的处理见下一节

### 删除任务时，它的对话去哪了（`onDeleteSessions`）

一个任务先后可能开过**好几条**会话（会话结束后再打开，会在同一目录新建一条）。删除任务时：

1. **先读会话账目** —— `WorkspaceEntity.sessionIds`（按 `sessionPath(id) === path` 过滤，
   正好等于「cwd == 该任务目录」的全部会话）。工作区记录一删这份账目就没了，所以必须在删除前读；
   只记着"最后一条 sessionId"是不够的；
2. **运行中的会话先中止当轮** —— `sessionController.cancel`（UI 上「停止」按钮的同一个入口），
   免得 agent 继续往一个即将消失的目录里写。插件**无法**销毁会话对象（那归创建它的 agent 工厂），
   所以确认框会给这类任务打上「运行中」标记；
3. **删目录 → 删节点 → 删记录**；
4. **按策略处理会话**：

| 策略 | 行为 | 代价 |
| --- | --- | --- |
| `archive`（默认） | 逐条 `workspaceRegistry.archiveSession()` —— 就是官方右键「归档会话」的同一个 API。官方浏览器会把已归档会话排除在列表外，所以它们**从侧边栏消失** | 日志仍在 `$DSH_HOME/sessions` 里占空间；**DSH 没有反归档 API、也没有"已归档"列表**，所以从 UI 上找不回来 |
| `keep` | 什么都不做 → 会话落进官方的「未分组」桶（DSH 删工作区的原生行为） | 聊天记录会留在侧边栏，需要你自己收拾 |

为什么不能"真删"：`sessionPersistence` 只暴露 `create / open / flush / stat / list`，文档明写会话日志是
append-only、"never rewritten"——**没有删除 API**。绕过去直接删 `~/.dsh/sessions/**` 会跳过
session-query 的内存缓存与 `session_projcache` 的 sqlite，属于碰私有存储，本插件不做。

策略在**齿轮 → 精简设置**或**设置 → 插件 → 临时任务**里改；手动删除与自动清理（`autoCleanDays`）
走**同一条** `disposeTask` 路径，所以不会出现"自动清理归档、手动删除不归档"这种不一致。

### 并发：同一个 DSH_HOME 下多个 profile 同时运行

`tasks.json`、配置、`rootDir` 都在 DSH_HOME 级，所以**多个 profile 同时运行**（例如桌面版与 `dsh web`）时共用一份记录。
两个进程同时写时的处理：

- **写入前在锁内重读磁盘**，以磁盘内容为基准做变更（按 id 增删改），不拿本进程的内存副本整份覆盖；
- **幂等写**：变更前后内容一致就不落盘（例如 `session/disposed` 落在非任务会话上）；
- 界面与命令读到的都是磁盘现状：`GET /state` 与 `/temptask list` 会先重读一次；
- 「是否已登记」这类判断也放在锁内做，避免两个进程把同一目录登记成两条记录。

**残留窗口**：没有跨进程文件锁，理论上仍有「读盘 → 变更 → rename」这段亚毫秒级窗口内的互相覆盖。
彻底消除需要 OS 级文件锁或每任务一个文件；对人工点按钮的频率不值得，故明确记录而不是假装没有。

## 7. 架构

```
        ┌──────────────── client half (浏览器) ────────────────┐
        │ sidebar.footer.action → 「＋ 新建临时任务」菜单         │
        │ shell.overlay        → 常驻守护（消费 pendingOpen）    │
        │ settings.section     → 配置卡片 + 清理入口             │
        │ （任务列表本身由官方 WorkspaceBrowser 按工作区分组渲染）│
        └───────────────┬──────────────────────────────────────┘
                        │  fetch("/dsh-temptask/api/*")   ← 同源 + 回环围栏
        ┌───────────────▼──────────── host half (Node) ────────┐
        │ routes.ts     状态 / 新建 / 打开 / 删除 / 清理 / ack / 配置 │
        │ tasks.ts      目录 + 工作区 + 会话 + 登记 + 清理          │
        │ workspaces.ts 工作区建/查/改名/删（侧边栏节点就是它）  │
        │ store.ts      tasks.json（原子写 + 串行锁 + 写前重读） │
        │ hooks.ts      session/created · disposed · event       │
        │ commands.ts   /temptask                                    │
        │ sessions.ts   sessionController.create({ cwd })        │
        └───────────────────────────────────────────────────────┘
```

**创建一个任务时的顺序（不能改）**：

1. `mkdir <rootDir>/<时间戳>` —— `workspaceRegistry.create` 要求目录已存在；
2. `workspaceRegistry.create(dir)` → 拿到 **realpath 归一化后**的路径；
3. `sessionController.create({ cwd: <归一化路径> })` —— 只传 cwd，不传 workspaceId；
4. `workspace.attachSession(sessionId)` —— DSH 会硬校验 cwd === workspace.path；
5. 写入 `tasks.json`。

第 2 步回传的路径必须在第 3 步使用：如果自己拼路径（含 Junction/符号链接时与 realpath 不同），
第 4 步会直接抛错。冒烟测试的桩**复刻了这条校验**，所以顺序写反会被测出来。

- **不注册任何全局服务**，host 与 client 之间只走插件自己的 HTTP 路由（社区插件 dshmarket 的既有做法）
- 所有副作用都挂在 Cordis fiber 上（`ctx.effect` / 注入子上下文），插件停用或替换时自动回收
- 所有服务都按**可选**读取（`ctx.get` + 缺失即降级），任一服务缺失都不会让插件加载失败

## 8. 设计取舍（以及为什么）

早期设计里假定的部分 API 在真实 DSH 中并不存在；另外有两条设计目标在 DSH 的数据模型下互相冲突。
本插件按「能真正在侧边栏长成树」的形状实现，逐条说明：

| 早期设计 | 实际实现 | 说明 |
| --- | --- | --- |
| `session.create({ cwd })` | `ctx.sessionController.create({ cwd })` | DSH 没有公开的 `session` 服务；`sessionController` 就是 `ctx.remote.session` 的 host 实现，其 `create` 明确接受「只给 `cwd`」。降级：`ctx.agents.create({ sessionId, meta: { cwd } })` |
| `session.created` / `closed` / `focused` | `session/created` / `session/disposed` / `session/event` 的 `user/message` | 真实事件名用斜杠；没有 focused 事件，用户发消息等价于「正在用这个任务」 |
| 任务不进工作区列表 | **任务 = 一个临时工作区**，会出现在侧边栏的工作区列表里（都在 `<DSH_HOME>/dsh-temptask` 下，可整体清理） | DSH 的树按工作区归属分组：`WorkspaceEntity.attachSession` 要求会话 cwd 与工作区路径一致（否则抛 `cannot attach session '…': its cwd resolves to '…'`），且工作区的 `sessionIds` 按 `sessionPath(id) === path` 过滤——即**会话归到某工作区当且仅当 `session.cwd === workspace.path`**。所以「一个叫『任务』的容器 + 每个子会话各带自己的临时目录」在 DSH 里**无法表达**；把任务目录本身做成工作区，才能直接获得「任务节点 → 子会话」这棵树与全套原生操作 |
| 侧边栏新增「任务」分组，与项目同级 | 任务以**工作区节点**的形态出现在官方树里 + 侧边栏一行「临时任务」标签与 ＋/🧹/⧉/? 四个小按钮（位置在「新建会话」与工作区列表之间） | 侧边栏**没有**给「同级第二个浏览分组」留增量插槽：`sidebar.workspaces` 是 `single` 且标记 `shadows-shipped-ui`，占用它会遮蔽官方工作区浏览器，并让它的子插槽 `sidebar.workspaces.directoryFlow` 失效——该洞由官方 `WorkspacePickFlow` 在「添加工作区」流程里渲染（`flowAvailable = useDirectoryFlow(occupied => occupied)`），占了它反而会弄坏官方的按目录添加工作区；而官方浏览器组件只导出 `apply`/`inject`，无法复用。那一行的点击语义是 `selectPanel(id)`（键盘激活同样只走它），所以本插件同时注册同名 `main` 面板作为**空兜底**（渲染 null + 立刻回会话），保证不出现任何页面 |
| 任务名称（输入框、`nameTemplate`、重命名显示名） | **整条删除** | 工作区标题默认取目录 basename，DSH 只在显式 `rename` 时才改它 —— 会话标题属于**会话行**，不属于节点。所以本插件**不碰**工作区标题（早期版本曾把 DSH 总结的会话标题写回节点，结果每轮对话都可能给节点改名、还会覆盖手工改的名字，已删除，并留了一条回归用例）。要改名就在节点上右键重命名（官方能力） |
| 任务根目录放在用户自选路径 | `<DSH_HOME>/dsh-temptask` | 放在 DSH 自己的目录下，不掺进用户的工作目录；目录名 = 时间戳，一个任务一个目录，天然不重名、可排序 |
| 命令解析支持参数带空格 | `/temptask open "2026-09-27"` | 支持单/双引号包裹（目录名是时间戳） |
| 右键菜单里的「复制任务路径」 | 那一行改为 **打开任务根目录**（官方 `sessionController.openWorkspacePath`，它接受任意路径）；宿主不能打开文件夹时自动退回"复制"。**复制始终留在齿轮里**（次要动作不跟主按钮抢位置） | 「打开」是目的地动作，「复制」是它的权宜替代——但粘进终端/编辑器仍有用，所以两者都留，只是分层：能用就用打开，不能用才复制 |
| 删除的二次确认 | UI 弹确认对话框 + 命令必须 `--yes` + 服务端强制 `confirm: true` | 三层都拦，绕过 UI 也删不掉 |
| 插件数据目录 | `<DSH_HOME>/plugin-data/dsh-temptask` | 可用 `dataDir` 覆盖（重启生效） |
| TypeScript 严格模式 | `src/` 全部 strict 编译通过 | `lib/`、`client/` 是构建产物（DSH 加载的是 JS）。官方 `@deepseek-ai/dsh-*` 包**不带 `.d.ts`**，所以 `src/dsh.d.ts` 用逐条抄自 live Inspect 目录与官方源码的最小声明固定了本插件真正用到的契约 |
| 兼容 `dsh-side-session` | 不冲突 + 设置卡片提示区别 | 不强制禁用任何一方 |

其他实现选择（需求未指定但影响体验）：

- **打开任务的语义**：会话还活着就复用；已关闭或进程重启过，就在同一目录里新建一条会话
  （同一任务因此可以有多次会话，节点下会列出它们的历史——与官方工作区行为一致）
- **失败即回滚**：目录刚建好但工作区/会话没建成时，目录会被删掉、记录不留，界面给出原因
- **根目录不可用**：不再自动换目录（默认值就在 DSH_HOME 内），而是如实报错并提示去改设置

## 9. 开发

```powershell
pnpm install
pnpm typecheck     # host + client 两套 tsconfig，strict
pnpm build         # src/ → lib/ + client/client.js
pnpm check:pack    # 发布形态自检 6 项（入口/源码/脚本是否都被 files 覆盖）
pnpm smoke         # 64 项端到端/渲染冒烟测试（40 host + 24 client，不需要 DSH 进程）
pnpm check         # typecheck + build + check:pack + smoke
```

`check:pack` 也挂在 `prepack` 上，所以 `npm pack` / `npm publish` 之前会自动跑一遍：
`files` 少写一条（例如漏了 `src`）在源码目录里跑测试是发现不了的，只有装包的人才会撞上。

`scripts/smoke.mjs`（**40 项**）用桩 Cordis 上下文挂载 `lib/index.js` 直打 HTTP 路由。
桩里的 `workspaceRegistry` **刻意复刻 DSH 的语义**（`create` 走真实 `realpath`、`attachSession`
硬校验 `cwd === workspace.path`），覆盖：时间戳目录、任务=工作区、会话只传 `cwd`、挂载、
**会话标题变化不改动节点名**（回归用例：发 `session/title` 事件后节点标题仍是目录名、且一次
`workspace.setTitle()` 都没调用）、命名接口确实已移除、`MISSING_DIR`、`CONFIRM_REQUIRED`、
**删除策略 archive：连旧会话一起归档（断言归档 2 条，而不是只归档最后一条）**、
**删除策略 keep：一条会话都不归档**、**删除运行中的任务前先 cancel 当轮**、
"目录/节点/记录三样同步清"、命令预览语义、`session/disposed → closed`、外部会话自动登记、
同名消歧、路径穿越防护（伪造 `dirName=../` 的记录必须被拒绝且根目录外文件毫发无损）、
记录损坏备份重建、启动对账丢弃幽灵记录、`autoCleanDays` 清理+归档会话、
**缺 workspaceRegistry 时拒绝建任务并回滚目录**、**`/open-root` 走官方 `openWorkspacePath` 打开任务
根目录**、**宿主不能打开文件夹时能力位为 false 且接口如实返回原因**、
**数据安全：在任务根目录里放未登记的目录/文件，`clean --all` 与 `autoCleanDays` 都不能碰它们**、
两个 host 进程并发、服务全缺失时优雅降级。

`scripts/smoke-client.mjs`（**24 项**）按 DSH 的方式装载 `client/client.js`
（`window.__ModuleLoader__`），断言工厂只 `require("react")` + 官方图标集、注册了
「那一行 + 兜底空面板 + 浮层×2 + 设置卡片」、**行的 `label` 是 i18n thunk：切换语言后再取必须
得到另一种语言**（官方 `PanelRow` 每次投影都会重读它）、宽栏那行自己的标签文字只出现一次、
**五个**小按钮且用的都是官方图标（断言出现 `IconNewChatOutline16` / `IconSettingsOutline16` 等，
且不再出现细笔画文本加号）、构建产物里带着限定作用域的隐藏规则、`package.json` 声明了客户端依赖
（保证图标集先于本包到达）、**官方图标集缺席时退回文本字形不崩**、窄栏只留图标、
**第三号按钮按宿主能力在"打开根目录 / 复制根目录"之间切换**（含能力未知时按复制渲染）、
**兜底面板渲染 null（点那一行不会出现任何页面）**、浮层各态渲染正确
（help / notice / clean / **齿轮设置的两档策略与选中态**）、
**清理确认框按策略如实描述并标出「运行中」**、`settingsScope` 与 `locale` 缺失时各自降级，
并把各组件真渲染一遍（`react-dom/server`）。

## 10. 排错

| 现象 | 处理 |
| --- | --- |
| 侧边栏没有「临时任务」这一行 | 确认 profile 名对不对、插件是否装上；看 DSH 日志里有没有 `[dsh-temptask]`；窄栏（折叠）时它只剩图标，悬停有提示 |
| 改了插件代码，行为却还是旧的 | **插件后端（Node 侧）只在 DSH 启动时加载**——必须重启 DSH；插件界面（页面）刷新即更新。点 `?` 看「版本」那一行：`插件后端 v…　·　插件界面 v…`，两半不一致时会直接提示「重启 DSH」。启动日志里也有 `[dsh-temptask] v<版本> 已就绪…`。三处版本号都应与 `package.json` 一致 |
| 点了「新建」但没看到节点 | 节点是工作区，刷新/展开侧边栏；设置卡片里若提示「未提供 workspaceRegistry」，说明该宿主无法建节点（任务目录仍会创建） |
| 节点名一直是时间戳 | **这是预期行为**：节点名 = 目录名（DSH 默认语义），本插件不改写它；DSH 总结的会话标题显示在该节点下的会话行上。想改节点名就在节点上右键重命名 |
| 建任务报「无法创建任务根目录」 | 改设置里的 `rootDir`，或检查 `<DSH_HOME>` 的写权限 |
| 设置卡片出现「记录损坏…已备份重建」 | 看 `<dataDir>/tasks.json.bak` 找回旧记录 |
| `/temptask open` 说「任务目录不存在」 | 目录被手工删了：用清理移除记录后重新新建 |
| 打开了任务但页面没跳 | 前端每 2.5s 轮询 `pendingOpen`；直接点侧边栏对应节点即可 |
| 删了任务，对话却出现在「未分组」 | 默认策略会把它**归档**（从侧边栏消失）而不是留下；若你把策略切成了 `keep`，那就是预期行为。见 §6 |
| 两个 profile 同时开着，列表对不上 | 界面每次都会先重读磁盘，正常 1 个刷新周期内一致；长期不一致见 §6「并发」的残留窗口 |

## 11. 发布前检查清单

**自动化覆盖边界**：host 测试全部跑在**桩 Cordis 上下文**上，client 测试全部是 `react-dom/server` 的
**静态渲染**。也就是说：业务逻辑与各条降级路径已覆盖，**真实 DSH 与真实 DOM 下的表现需要人工验收一遍**。

### 需要人工验收（按出错后果排序）

1. **数据安全（唯一"一错就丢数据"的地方）**：在 `~/.dsh/dsh-temptask/` 里手动放一个**没被登记**的
   目录 + 文件，再跑 `/temptask clean --all --yes`，并让 `autoCleanDays` 清一次 → 那个目录必须毫发无损。
   （自动化里已有等价的桩用例，但真文件系统上值得再确认一次。）
2. **那一行的真实外观**：页面上「临时任务」是否只出现一次、边框是否只有一圈、hover 颜色是否正确、
   `＋ 临时任务 │ 🗑 ⧉ ? ⚙` 在侧边栏宽度里是否挤。这两处 CSS 是按读到的官方类名做的 `:has()` 手术，
   只有真 DOM 能证伪。
3. **不导航**：鼠标点主区 = 新建；键盘 Tab 到那一行按 Enter = 闪一下回到会话，**中心列不能变空**。
4. **打开根目录**：点下去资源管理器应弹出；若宿主不支持，应给提示而不是静默。
5. **重启 DSH**：任务节点/会话/`tasks.json` 都还在，`?` 里 `插件后端 v… · 插件界面 v…` 一致。
6. **切语言**：英文界面下那一行 tooltip、`?` 气泡、齿轮文案要跟着变。
7. **`?` 悬浮收起**：鼠标进出气泡；以及"点完 `?` 不碰它、直接移开鼠标"也要关。
8. **窄栏**：侧边栏折叠后只剩 ＋，点它应能新建。

### 发布前需要人工确认

- `package.json` 的 `repository` / `homepage` / `bugs` / `author` 与仓库一致；
- **真安装形态**：开发时用 `link:` 安装即可，发布形态是 tarball —— 建议 `npm pack` 后在**临时 profile** 里
  `dsh plugin --profile <profile> add ./aeroscis-dsh-temptask-<版本>.tgz` 启动验证一次；
- **卸载**：`dsh plugin --profile <profile> remove @aeroscis/dsh-temptask` 之后 profile 仍能正常启动
  （语义是保留任务目录与 `tasks.json`）。

### 已知限制

- **不支持真正删除会话**：只能归档（DSH 未提供删除 API，见 §6）；
- **跨进程并发**只保证「写前重读 + 按 id 合并」，仍存在亚毫秒级残留窗口（自动化用例是同进程双实例模拟）；
- **无障碍**：那一行内部控件位于官方 `aria-hidden` 字形槽内，屏幕阅读器无法读取；
  等价动作在「设置 → 插件 → 临时任务」与 `/temptask` 命令里都可键盘到达。

## 12. 兼容性说明：dsh-temptask vs dsh-side-session

| | dsh-temptask（本插件） | dsh-side-session（EAC 桌面版自带） |
| --- | --- | --- |
| 管理对象 | 「临时任务」：`<DSH_HOME>/dsh-temptask/<时间戳>` 目录 + 它的临时工作区 | 侧边/并行会话 |
| 在侧边栏的形态 | 官方工作区节点（原生展开/归档/搜索/拖拽） | 依附既有工作区/会话体系 |
| 生命周期 | 可整体列出、清理、自动过期清理 | 跟随其宿主会话 |
| 是否冲突 | 不冲突：两者使用不同的插槽与服务，可同时启用 | — |

## License

MIT
