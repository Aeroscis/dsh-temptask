# 设计与实现笔记

> 这份文档是**给维护者**看的：为什么这样实现、逐条核对过哪些官方语义、哪些方案被否掉了、
> 开发与发版怎么做。**使用者请读 [README](../README.md)**——那里只有"怎么装、怎么用、出问题怎么办"。
>
> 章节里凡提到"§N"，指的都是本文自己的编号。

---

## 1. 项目结构与模块职责

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
│   ├── tasks.ts            # 业务核心：建/开/删/清理/自动登记/自动清理/转正入口/候选列表
│   ├── promote.ts          # ★ 转正：搬目录 + 建正式工作区 + 删旧节点 + 归档旧会话
│   ├── seed.ts             # ★ 官方 fork 语义的种子构造（已完成前缀 + session/end-seed）
│   ├── describe.ts         # ★ 只读：从官方投影/事件流取会话标题与首条消息摘要（转正列表认人用）
│   ├── hooks.ts            # session/created、session/disposed、session/event(user|title)
│   ├── commands.ts         # /temptask 命令与参数解析
│   ├── routes.ts           # /dsh-temptask/api/* HTTP 桥（同源围栏 + JSON）
│   ├── client.tsx          # ★ client 侧：侧边栏面板行 + 动作页 + 清理对话框 + 设置卡片
│   ├── index.ts            # 包入口（重导出 host half）
│   └── dsh.d.ts            # DSH 接口的最小环境声明（见 §4）
├── lib/                    # 构建产物：host 运行时（ESM，DSH 加载的就是它）
├── client/client.js        # 构建产物：client 的 ModuleLoader 包
├── scripts/                # build-client / prepare / check-pack / check-registration / smoke / smoke-client
├── README.md               # 用户向：装 / 用 / 排错
├── docs/DESIGN.md          # 本文（维护者向：为什么这样实现 + 证据 + 发版流程）
└── LICENSE
```

## 2. 界面实现细节与官方插槽的约束

**为什么点标签没有页面**：任务列表就是侧边栏里的树，入口只需要一行标签 + 几个按钮。
DSH 的树按「工作区归属」分组，而会话归到某个工作区当且仅当 `session.cwd === workspace.path`
（见 §4 证据），所以把任务目录本身做成工作区，就能白拿官方的整棵树；本插件只在那行里放五个动作，
**不替换任何官方 Slot、不新增任何导航目的地**。

行内图标**全部自绘**，不再 `require` 宿主图标包（`@deepseek-ai/dsh-client-ui-primitives`）。原因是那个包
在 `0.1.7-rc.2` 里把图标导出名从 `<Name>Outline<尺寸>`（`IconTrashOutline16`）改成了
`<Name>OutlineRegular|Medium`：老名字取不到时旧版代码会**静默降级**成 `🧹 📂 ? ⚙` 这类文本/emoji 字形，
于是同一份插件在 `0.1.5` 宿主上是线框图标、在 `0.1.7` 宿主上变成 emoji（官方自己的插件文档也要求
「不要 require 宿主 Client 包」）。自绘的代价只是观感要自己对齐官方规格：`viewBox` 16、
`stroke="currentColor"`、1.4px 线宽。因此清单里也不再需要客户端依赖声明：

```json
"dsh": { "client": { "platform": "web" } }
```

任何时候都不会因为宿主少一个图标或改了图标名而变形、也不会因此挂掉（`data-tt-mark` / `data-tt-icon`
是这些自绘字形的记号，可在开发者工具里直接认出是哪一枚）。

已知边界（来自官方插槽的约束，不是疏忽）：那一行官方是按「导航按钮」渲染的，行内内容落在
`aria-hidden` 的字形槽里——所以主区和五个小按钮对屏幕阅读器不可见（鼠标可用，每个都有 `title` 与
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

## 3. 架构与执行顺序

```
        ┌──────────────── client half (浏览器) ────────────────┐
        │ sidebar.panellist    → 「临时任务」那一行 + 动作按钮   │
        │ sidebar.workspaces.session.menu.item                 │
        │                      → 会话行上的「转正此任务」        │
        │ shell.overlay        → 说明 / 清理框 / **转正模态** / 齿轮 │
        │ settings.section     → 配置卡片 + 清理入口             │
        │ （任务列表本身由官方 WorkspaceBrowser 按工作区分组渲染）│
        └───────────────┬──────────────────────────────────────┘
                        │  fetch("/dsh-temptask/api/*")   ← 同源 + 回环围栏
        ┌───────────────▼──────────── host half (Node) ────────┐
        │ index/host.ts 导出 Config（官方设置表单）+ apply 装配   │
        │ routes.ts     状态 / 新建 / 打开 / 删除 / 清理 / 转正 / ack / 配置 │
        │ tasks.ts      目录 + 工作区 + 会话 + 登记 + 清理 + 转正入口 │
        │ promote.ts    转正编排：搬目录 → 建节点 → 复刻对话 → 收尾 │
        │ seed.ts       fork 种子（已完成前缀 + session/end-seed）│
│ describe.ts   只读取会话标题/摘要（转正列表认人用）    │
        │ workspaces.ts 工作区建/查/删（侧边栏节点就是它）        │
        │ store.ts      tasks.json（原子写 + 串行锁 + 写前重读） │
        │ hooks.ts      session/created · disposed · event       │
        │ commands.ts   /temptask                                    │
        │ sessions.ts   sessionController.create({ cwd }) / agents.create({ seed }) │
        └───────────────────────────────────────────────────────┘
```

**配置写入的三条路**（按宿主能力选，见 §4）：`configEditor.edit`（0.2.0-rc.1）→
0.1.x 的 settings 命名空间 → `<dataDir>/config.json`；官方设置表单与插件自己的齿轮面板
最终都落到同一处。

**创建一个任务时的顺序（不能改）**：

1. `mkdir <rootDir>/<时间戳>` —— `workspaceRegistry.create` 要求目录已存在；
2. `workspaceRegistry.create(dir)` → 拿到 **realpath 归一化后**的路径；
3. `sessionController.create({ cwd: <归一化路径> })` —— 只传 cwd，不传 workspaceId；
4. `workspace.attachSession(sessionId)` —— DSH 会硬校验 cwd === workspace.path；
5. 写入 `tasks.json`。

第 2 步回传的路径必须在第 3 步使用：如果自己拼路径（含 Junction/符号链接时与 realpath 不同），
第 4 步会直接抛错。冒烟测试的桩**复刻了这条校验**，所以顺序写反会被测出来。

**转正一个任务时的顺序（九个步骤，失败语义逐条明确）**：

1. **校验源**：记录里的 `path` 必须仍等于「根目录 + 目录名」（与删除任务同一套三重校验）；
2. **校验落点**：名字合法、目标父目录**已存在**（不替你造目录——"少写一层"是最常见的手误，
   静默补建正好把它藏起来；要新位置就用「浏览…」里带的新建文件夹）、
   **目标不存在**（绝不覆盖）、**不落在任务根目录内部**（否则下一轮会被 `adoptSession`
   当成临时任务重新登记）；
3. **中止**该任务名下活着的会话当轮（best-effort，同删除路径）；
4. **搬目录**：`rename`（跨卷 `EXDEV` 时退化成「复制 + 删除」）。这是**唯一的破坏性动作，且它最早**；
5. 在**新路径**建工作区记录（节点标题默认 = 新目录名，这就是 DSH 语义里的「显式 rename」）；
   这一步失败会把目录**搬回去**，不留「目录走了、节点没了」的半状态；
6. **复刻对话**（尽力而为，见 §4）；探测不到任何可用路径时降级为「在新家开一条空会话」；
7. 按 `onDeleteSessions` 策略处理旧会话（默认逐条归档）；
8. 删旧工作区记录；
9. 删本插件的任务记录（此后它不再是临时任务，也不会被自动清理）。

与「创建」相反的地方：创建是「目录 → 节点 → 会话 → 记录」，转正是**先搬目录、再建节点、
最后才动记录**——因为记录是管理视角的账本，节点是用户的界面，两者都要等目录真正就位才改。

**为什么"转正"不能只改一个路径字段**（结论与证据）：

- DSH 的工作区记录**没有** `setPath`/`move`：注册表只有 `create/get/list/delete/resolveByPath/insertBefore`，
  实体只有 `setTitle/attachSession/insertSessionBefore/detachSession`；唯一性以 **realpath 字符串相等**为准
  （`@deepseek-ai/dsh-workspace` 的 `src/paths.ts`）。所以「移动」在官方 API 层面不存在；
- 会话的 cwd **落盘且不可改**：全库没有任何 `setCwd`/`updateHeader`；JSONL 会话存储的契约是
  「仅追加、已提交帧绝不重写」，header 是**带校验和的 Zstandard 帧**，连日志所在的项目目录名
  都编码了 cwd（`--<normalized-cwd>--/`）。硬改盘上字节 = 赌整段对话还是不是"可读"；
- `attachSession` 硬校验 `header.cwd` 的 realpath === `workspace.path`，官方 `fork` 又把子会话的 cwd
  固定成来源会话的 cwd——所以「把已有会话原地移动」在官方语义下**无法表达**；
- 但官方 fork 的机制（「已完成前缀 + `session/end-seed`」当种子 + 新 cwd 重建一条会话）恰好能表达
  「把对话搬到新家」：`src/seed.ts` 就是这条机制里与本插件相关的那 9 行，逐条对齐官方
  `buildForkSeed`（差别只有一处：cwd 用新家而不用 `source.header.cwd`）。
  官方的 `openTurnClosers` 在我们的场景里恒为空数组——因为我们的边界**就是一个收尾过的时间点**
  （官方源码里那句注释也是这么写的：`Balanced log (no open tail turn): nothing to close`）。

- **不注册任何全局服务**，host 与 client 之间只走插件自己的 HTTP 路由（社区插件 dshmarket 的既有做法）
- 所有副作用都挂在 Cordis fiber 上（`ctx.effect` / 注入子上下文），插件停用或替换时自动回收
- 所有服务都按**可选**读取（`ctx.get` + 缺失即降级），任一服务缺失都不会让插件加载失败

## 4. 设计取舍（含被否掉的方案）

早期设计里假定的部分 API 在真实 DSH 中并不存在；另外有两条设计目标在 DSH 的数据模型下互相冲突。
本插件按「能真正在侧边栏长成树」的形状实现，逐条说明：

| 早期设计 | 实际实现 | 说明 |
| --- | --- | --- |
| `session.create({ cwd })` | `ctx.sessionController.create({ cwd })` | DSH 没有公开的 `session` 服务；`sessionController` 就是 `ctx.remote.session` 的 host 实现，其 `create` 明确接受「只给 `cwd`」。降级：`ctx.agents.create({ sessionId, meta: { cwd } })` |
| `session.created` / `closed` / `focused` | `session/created` / `session/disposed` / `session/event` 的 `user/message` | 真实事件名用斜杠；没有 focused 事件，用户发消息等价于「正在用这个任务」 |
| 任务不进工作区列表 | **任务 = 一个临时工作区**，会出现在侧边栏的工作区列表里（都在 `<DSH_HOME>/dsh-temptask` 下，可整体清理） | DSH 的树按工作区归属分组：`WorkspaceEntity.attachSession` 要求会话 cwd 与工作区路径一致（否则抛 `cannot attach session '…': its cwd resolves to '…'`），且工作区的 `sessionIds` 按 `sessionPath(id) === path` 过滤——即**会话归到某工作区当且仅当 `session.cwd === workspace.path`**。所以「一个叫『任务』的容器 + 每个子会话各带自己的临时目录」在 DSH 里**无法表达**；把任务目录本身做成工作区，才能直接获得「任务节点 → 子会话」这棵树与全套原生操作 |
| 侧边栏新增「任务」分组，与项目同级 | 任务以**工作区节点**的形态出现在官方树里 + 侧边栏一行「临时任务」标签与 ＋/🧹/♥/⧉/?/⚙ 五个小按钮（位置在「新建会话」与工作区列表之间） | 侧边栏**没有**给「同级第二个浏览分组」留增量插槽：`sidebar.workspaces` 是 `single` 且标记 `shadows-shipped-ui`，占用它会遮蔽官方工作区浏览器，并让它的子插槽 `sidebar.workspaces.directoryFlow` 失效——该洞由官方 `WorkspacePickFlow` 在「添加工作区」流程里渲染（`flowAvailable = useDirectoryFlow(occupied => occupied)`），占了它反而会弄坏官方的按目录添加工作区；而官方浏览器组件只导出 `apply`/`inject`，无法复用。那一行的点击语义是 `selectPanel(id)`（键盘激活同样只走它），所以本插件同时注册同名 `main` 面板作为**空兜底**（渲染 null + 立刻回会话），保证不出现任何页面 |
| 任务名称（输入框、`nameTemplate`、重命名显示名） | **整条删除** | 工作区标题默认取目录 basename，DSH 只在显式 `rename` 时才改它 —— 会话标题属于**会话行**，不属于节点。所以本插件**不碰**工作区标题（早期版本曾把 DSH 总结的会话标题写回节点，结果每轮对话都可能给节点改名、还会覆盖手工改的名字，已删除，并留了一条回归用例）。要改名就在节点上右键重命名（官方能力） |
| 任务根目录放在用户自选路径 | `<DSH_HOME>/dsh-temptask` | 放在 DSH 自己的目录下，不掺进用户的工作目录；目录名 = 时间戳，一个任务一个目录，天然不重名、可排序 |
| 命令解析支持参数带空格 | `/temptask open "2026-09-27"` | 支持单/双引号包裹（目录名是时间戳） |
| 右键菜单里的「复制任务路径」 | 那一行改为 **打开任务根目录**（官方 `sessionController.openWorkspacePath`，它接受任意路径）；宿主不能打开文件夹时自动退回"复制"。**复制始终留在齿轮里**（次要动作不跟主按钮抢位置） | 「打开」是目的地动作，「复制」是它的权宜替代——但粘进终端/编辑器仍有用，所以两者都留，只是分层：能用就用打开，不能用才复制 |
| 「把工作区移动到别的目录」（改 `path`） | **不存在这个能力**：改成「搬目录 → 删旧节点记录 → 在新路径建记录」三步编排（`promote.ts`） | 注册表只有 `create/get/list/delete/resolveByPath/insertBefore`，实体只有 `setTitle/attachSession/...`；记录的键就是 realpath 归一化后的路径字符串，**没有 setPath/move**。所以"移动工作区"只能表现为"换一个目录重新登记"，旧记录必须显式删掉，否则侧边栏会留一个指向空路径的死节点 |
| 「强制改写会话的 cwd，把对话直接移动过去」 | **明确不做**：改用官方 fork 的种子机制，在**新 cwd 下重建一条会话**（历史完整、id 是新的），旧会话按现有策略归档 | 全库没有 `setCwd`/`updateHeader`；JSONL 存储是**仅追加**的，header 是带校验和的 Zstandard 帧，日志所在项目目录名还编码了 cwd（`--<normalized-cwd>--/`）。硬改盘上字节的失败模式是**整段对话被判为损坏、读不出来**——拿用户的历史去赌一个"看起来更干净"的实现，不划算。种子路径则是官方 `sessionController.fork()` 自己走的那条路（`agents.create({ seed, inheritedEventCount, meta })`），只是把 `meta.cwd` 指向新家 |
| 删除的二次确认 | UI 弹确认对话框 + 命令必须 `--yes` + 服务端强制 `confirm: true` | 三层都拦，绕过 UI 也删不掉 |
| 插件数据目录 | `<DSH_HOME>/plugin-data/dsh-temptask` | 可用 `dataDir` 覆盖（重启生效） |
| TypeScript 严格模式 | `src/` 全部 strict 编译通过 | `lib/`、`client/` 是构建产物（DSH 加载的是 JS）。官方 `@deepseek-ai/dsh-*` 包**不带 `.d.ts`**，所以 `src/dsh.d.ts` 用逐条抄自 live Inspect 目录与官方源码的最小声明固定了本插件真正用到的契约 |
| 兼容 `dsh-side-session` | 不冲突 + 设置卡片提示区别 | 不强制禁用任何一方 |

其他实现选择（需求未指定但影响体验）：

- **打开任务的语义**：会话还活着就复用；已关闭或进程重启过，就在同一目录里新建一条会话
  （同一任务因此可以有多次会话，节点下会列出它们的历史——与官方工作区行为一致）
- **转正是"搬家"，不是"升级那条会话"**：新家得到的是**一条新会话**（新 id、完整历史），
  它的 `parentSession` 指回旧会话，侧边栏因此能看到血缘；旧会话原样留在磁盘上（默认归档）。
  这是"历史不可变"的必然结果——DSH 里没有"把会话改个归属"这种操作
- **转正只对"已完成的一轮"做边界**：种子取最后一个 `turn/end` 所界定的已完成前缀
  （逐字对齐官方 `latestCompletedPrefixBoundary`）；没有这样的边界时**如实降级**为
  「不带历史的新会话」，并在结果里给出原因，绝不假装搬了历史
- **失败即回滚**：目录刚建好但工作区/会话没建成时，目录会被删掉、记录不留，界面给出原因
- **根目录不可用**：不再自动换目录（默认值就在 DSH_HOME 内），而是如实报错并提示去改设置

### 配置形态为什么在 0.2.0-rc.1 换了

**为什么 0.2.0-rc.1 换了形态**：新宿主的 `ctx.settings`（`SettingsForms`）不再提供
`register(namespace, schema)`，那个被 `settingsNamespace` 品牌化的命名空间注册表已经删掉了；
取而代之的是「插件用自己 Config 里的 volatile 字段声明设置」，读取时字段是**活引用**
（`config.rootDir.get()`），写入统一走 `ctx.configEditor.edit(entry, …)`。本插件因此：

- 导出 `Config`（schemastery `z.object`，`rootDir` / `autoCleanDays` / `onDeleteSessions` / `dataDir` 全部 `.volatile()`），
  官方「设置 → 插件」表单据此渲染；
- `apply(ctx, config)` 里读字段时兼容两种形态（引用取 `.get()`，普通值直接用）；
- 写入优先走 `configEditor`（与官方表单同一处），其次是 0.1.x 的 settings 命名空间，
  最后才退回 `config.json`；
- 监听加载器的 `loader/volatile-update` 事件：官方表单改完配置，插件当场重读引用、
  必要时重新载入清单（改 `rootDir` 立即生效，不用重启 DSH）。

**注意**：`@deepseek-ai/schemastery` 3.18.4 才有 `.volatile()`；0.1.x 宿主附带的是 3.18.2，
那里会自动退化成普通字段（配置仍可用，只是表单少了热更新语义）。

**降级通道**：宿主既没有 `configEditor`、也没有 settings 服务、或取不到 schemastery 时，
插件不会加载失败，而是改用 `<dataDir>/config.json`（设置卡片会显示「配置来源」）。

## 5. 官方语义核对与证据

### 5.1 支持的 DSH 版本与核对结论

### 支持的 DSH 版本

- **声明**：`engines.dsh` 与 `peerDependencies` 里的 `@deepseek-ai/dsh` 都是
  `^0.1.5-rc.2 || ^0.2.0-rc.1`。市场的兼容性判定读的就是这些字段（`@deepseek-ai/schemastery`
  另有版本线，不参与 DSH 版本判定），**它判的是"范围是否满足"，不是"版本是否相等"**——
  插件的版本号是它自己的迭代序号，与 DSH 版本无关。
- **硬门槛**：DSH 0.2.0-rc.1 起，宿主在挂载前会先核对插件的 `@deepseek-ai/dsh*` peer 范围，
  不满足就**整条 bundle 直接跳过**（日志：`skipping profile bundle`，界面上那一行直接消失）。
  本插件声明了双范围，两条线都能过这道门；`0.2.0-rc.2` 上另用宿主**自己那个判定函数**
  `evaluatePluginCompatibility`（runtime `0.2.0-rc.2`）实测，返回 `undefined`（= 兼容）。
- **开发与验证环境**（Windows 上实测，Linux 由 GitHub Actions 复跑全部检查）：
  - `0.1.5-rc.2`（三方桌面 App DSH Desktop 2.0.13 内置的那条线）：settings 命名空间 + `sessions.open`；
  - `0.1.7-rc.2`（官方 DeepSeek Harness 早期桌面版）：同上，界面差异由本插件自行吸收
    （图标自绘、`order` 取负值）；
  - `0.2.0-rc.1`（0.2.x 线的起点，核心包与桌面版同号）：**插件自身的 Config schema +
    `configEditor`** + `uiWorkspace.openSession`（新形态，见 §4）；
  - `0.2.0-rc.2`（官方桌面版 2026-10 初那条线，2026-10-09 核对）：**与本插件所用接口零差异**——
    逐包比对 81 个 `@deepseek-ai/*` 运行时包（逐文件哈希），`dsh-app-boot` / `dsh-settings` /
    `dsh-base` / `dsh-web-app` / `dsh-plugin-manager` 的 lib **逐字节相同**；客户端目录只有新增
    （新插槽 `sidebar.right.tab.files.actions`、新会话节点类型 `question-reply`、
    会话头动作改名 `OpenInAppAction` → `SessionOpenInAppAction`），
    没动本插件占用的插槽与服务，所以**本次没有代码改动**（见 CHANGELOG 0.4.2）。
    rc.2 对插件侧唯一可感知的变化是**安装路径**：Desktop 自带的命令运行时可管理
    desktop profile 的插件，npm CLI 仍然拒绝。
  - `0.2.1-rc.2`（官方桌面版 2026-10-18 那条线，**本次适配**）：宿主换成
    `@deepseek-ai/dsh-desktop-runtime@0.2.1-rc.2`，**运行时整个打包进 `app.asar`**
    （普通 `ripgrep`/Node 读不到里面的文件，校验脚本要用 `DSH_APP_ROOT` 指向解包出来的树，
    见 §5）。实测结论：
    - **版本门槛不用改**：宿主自己的 `evaluatePluginCompatibility`（`dsh-app-boot`）用的是
      `semver.satisfies(runtime, range, { includePrerelease: true })`，所以
      `^0.2.0-rc.1` **覆盖 `0.2.1-rc.2`**（实测返回 `undefined` = 兼容；`0.3.0-rc.1` 才被拒）；
    - 逐项核对本插件用到的接口，**只有一处真的变了**：桌面注入的原生目录选择器桥
      从 `__DSH_DESKTOP_PICK_DIRECTORY__`（0.2.0 只在 win32 发布）改成
      `__DSH_DIRECTORY_PICKER__`（preload **全平台**无条件发布，形态是 `{ pick }`）；
      同时 `dsh-host-directory-picker-auto` 的平台判定改成 `darwin || win32 → native`，
      所以 win32 上 `remote.directoryPicker.pick()` 这条官方路**现在也通了**。
      本插件的「浏览…」按**新名 → 旧名 → remote** 三级取（两个名字都读，见 §2）；
    - 其余接口逐条核对**未变**：`workspaceRegistry` 的
      `create/get/list/delete/resolveByPath/insertBefore/archiveSession` 与实体的
      `setTitle/attachSession`（`attachSession` 仍按 realpath 硬校验 cwd，仍然**没有** `setPath`）、
      `sessionController` 的 `create/cancel/canOpenWorkspacePath/openWorkspacePath`
      （`ApiSessionCwdConflict` 与 fork 继承 cwd 的行为都没变）、
      `agents.create` 的 `CreateAgentOptions`（`seed`/`inheritedEventCount`/`meta`/`setup`/
      `agentOptions`）、`sessionQuery.observeSession`（默认投影仍给
      `projections.values.agentPreset`）、`agentPresets.resolve/mount`、
      `agentDefaultModel.currentSelection`、`configEditor.edit`、`webServer.register`
      （`kind: 'exact' | 'prefix'`）、`commands.register`；
      客户端插槽 `sidebar.panellist` / `main` / `shell.overlay` / `settings.section` /
      `sidebar.workspaces.session.menu.item` / `sidebar.workspaces.session.row.action`
      **六个都还在**（会话行那两个是本版本新用上的，见 §2）；
    - **种子语义仍逐字节一致**：`check:seed-parity` 对着 `dsh-session@0.2.1-rc.2` 的真实
      `buildForkSeed` 跑 10 项全过（含从 `dsh-api-session-controller` 里切出边界函数现场编译比对）。
- **依赖的宿主能力**（缺失时逐项降级，**任何一种缺失都不会让插件加载失败**）：
  `sessionController`（`create` / `cancel` / `openWorkspacePath`）、`workspaceRegistry`、`commands`、
  `webServer`；配置侧在 0.1.x 用 `settings` 命名空间、在 0.2.0-rc.1 起用 `configEditor`
  （两者都没有时退回 `<dataDir>/config.json`）；客户端用 `configForms`（0.2.0-rc.1）或
  `settingsScope`（0.1.x），插槽 `sidebar.panellist` / `main` / `shell.overlay` / `settings.section`
  两条线同名。这些服务全部按可选读取。**界面侧不依赖任何宿主 Client 包**（行内图标自绘，见 §2）。
- **怎么自查**：`?` 气泡只讲用法，**版本在「设置 → 插件 → 临时任务」卡片页脚**（`插件后端 v…　·　插件界面 v…`）——
  这两个数是**插件自己的**，不要拿去和 DSH 版本比较；DSH 自身版本在 DSH 的关于页或市场里看。

升级 DSH 之后如果出现异常，先看设置卡片页脚里的插件版本，再用 `engines.dsh` 对照本插件的发布说明。

### 5.2 多个 profile 并发写同一份记录

### 并发：同一个 DSH_HOME 下多个 profile 同时运行

`tasks.json`、配置、`rootDir` 都在 DSH_HOME 级，所以**多个 profile 同时运行**（例如桌面版与 `dsh web`）时共用一份记录。
两个进程同时写时的处理：

- **写入前在锁内重读磁盘**，以磁盘内容为基准做变更（按 id 增删改），不拿本进程的内存副本整份覆盖；
- **幂等写**：变更前后内容一致就不落盘（例如 `session/disposed` 落在非任务会话上）；
- 界面与命令读到的都是磁盘现状：`GET /state` 与 `/temptask list` 会先重读一次；
- 「是否已登记」这类判断也放在锁内做，避免两个进程把同一目录登记成两条记录。

**残留窗口**：没有跨进程文件锁，理论上仍有「读盘 → 变更 → rename」这段亚毫秒级窗口内的互相覆盖。
彻底消除需要 OS 级文件锁或每任务一个文件；对人工点按钮的频率不值得，故明确记录而不是假装没有。

## 6. 开发与测试

```powershell
pnpm install
pnpm typecheck     # host + client 两套 tsconfig，strict
pnpm build         # src/ → lib/ + client/client.js
pnpm check:pack    # 发布形态自检 6 项（入口/源码/脚本是否都被 files 覆盖）
pnpm smoke         # 端到端/渲染冒烟测试（72 host + 58 client，不需要 DSH 进程）
pnpm check:registration  # 用宿主真实的 dsh-client-modules 校验 ModuleLoader 注册契约（需要 DSH 桌面应用）
pnpm check:seed-parity   # 用宿主真实的 buildForkSeed 逐字节校验种子构造（需要 DSH 桌面应用）
pnpm check         # typecheck + build + check:pack + smoke + check:registration + check:seed-parity
```

`check:pack` 也挂在 `prepack` 上，所以 `npm pack` / `npm publish` 之前会自动跑一遍：
`files` 少写一条（例如漏了 `src`）在源码目录里跑测试是发现不了的，只有装包的人才会撞上。

`scripts/smoke.mjs`（**72 项**）用桩 Cordis 上下文挂载 `lib/index.js` 直打 HTTP 路由。
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
两个 host 进程并发、服务全缺失时优雅降级；
以及 **0.2.0-rc.1 的配置模型**：行配置是 volatile 引用时取到引用里的当前值、
配置来源标为 `plugin-config`、`/api/config` 走 `configEditor.edit`（且不落 `config.json`、
未改动字段原样保留）、改完根目录立刻生效、`loader/volatile-update` 后重读引用、
没有 `configEditor` 的宿主仍写 `config.json`、以及
**`Config` schema 契约**（4 个字段；schemastery 3.18.4 上标 volatile，3.18.2 上不标）；
最后是**转正**：`seed` 纯函数 4 项（空日志 / 只有半轮 → 没有边界；一整轮 → 前缀 +
`session/end-seed`（seq、时间戳、`data.inherited`）；边界之后只吞「不开新回合」的事件，
三种开新回合的事件各自截断；`seq` 与下标不一致时拒绝造种子），
以及端到端 11 项（缺 `confirm` → `CONFIRM_REQUIRED`；校验矩阵：非法名字 / 目标已存在 /
父目录是文件 / 落在任务根目录内 / 父目录为空，且**任一失败都不许动原目录**；
成功路径断言**目录真的搬走**（原路径消失、新路径存在、`moved: 'rename'`）、
**旧节点被删、新节点标题 = 新目录名**、**种子会话的确切形状**（`meta.cwd` = 新家、
`parentSession` = 旧会话、`isSeeded`、`agentPreset` 跟着来源会话、`agentOptions` 来自
`agentDefaultModel`、预设真的 `mount` 过、`seed` 末条是 `session/end-seed`）、
旧会话归档 + 记录移除 + `pendingOpen` 指向新会话；
`carry=false` 走官方 `sessionController`（不碰种子）；两条降级链（读不到事件流 / 没有已完成回合）
都必须**如实说明原因**且转正照常完成；命令通道先预览后执行、预览阶段目录不动）。

`scripts/smoke-client.mjs`（**58 项**）按 DSH 的方式装载 `client/client.js`
（`window.__ModuleLoader__`），断言工厂**只** `require("react")`（任何对宿主包的 require 都会让这条桩
直接失败）、注册了「那一行 + 兜底空面板 + 浮层×2 + 设置卡片 + **会话行菜单项 + 会话行悬停按钮**」、
**面板行的 `order` 取负值**（排到官方「插件」面板行 `order: 0` 之前，紧贴「新建会话」）、
**行的 `label` 是 i18n thunk：切换语言后再取必须得到另一种语言**（官方 `PanelRow` 每次投影都会重读它）、
宽栏那行自己的标签文字只出现一次、**六个**自绘字形（断言 `data-tt-icon` / `data-tt-mark`，
且产物里不再出现宿主图标包的 require、不再出现 emoji 兜底字形、没有外链资源）、
构建产物里带着限定作用域的隐藏规则、窄栏只留图标、
**按钮按宿主能力在"打开根目录 / 复制根目录"之间切换**（含能力未知时按复制渲染）、
**兜底面板渲染 null（点那一行不会出现任何页面）**、浮层各态渲染正确
（help / notice / clean / **齿轮设置的两档策略与选中态**）、
**清理确认框按策略如实描述并标出「运行中」**、`settingsScope` 与 `locale` 缺失时各自降级，
并把各组件真渲染一遍（`react-dom/server`）。

**转正的客户端覆盖**（19 项）：面板默认值（`新目录名` = **会话标题洗成合法目录名** → 摘要 →
时间戳、`目标父目录` = localStorage 优先、其次 `/state` 的 `home`、成功后写回）、
**认人**（`describeTask` 三级回落、`visiblePromoteTasks` 的"默认只给有节点的 / 全都没有时退回全部"、
`folderNameFromText` 按 host 的 `validateName` 规则洗非法字符·空白·结尾点·Windows 保留名·超长，
以及面板里真的渲染出标题、摘要、`N 条会话`、「无节点」标记与「显示全部（N）」开关）、
预选（tray 带过来的 taskId / 无效 taskId 回落）、空列表空态、表单 → 确认 → 结果卡三步、
提交体固定带 `confirm: true` 且字段正确、
失败时 `message` 与 `hint` **都**渲染进表单（`TARGET_EXISTS` / `DIR_BUSY` 判据来自 `data-tt-promote-error`）、
**会话行菜单项对「非任务会话」返回 null、对「任务会话」能打开面板并预选**、悬停按钮同款判据、
两个槽位的注册 `id` / `order`、目录选择器的四种形态（桌面全局 / `remote.directoryPicker` /
都没有 → 隐藏「浏览…」，以及取消与失败）、爱心按钮在宽栏出现、窄栏不出现。

**候选列表的 host 覆盖**（4 项）：`/candidates` 带上标题（读官方 `title` 投影）与首条消息摘要
（跳过只有附件的空消息、压平空白、超长截断）、`sessionCount`、读满上限后如实报告 `skipped`、
以及宿主没有 `sessionQuery` 时 `describeSessions: false` 且列表照常给（只显示时间戳）。

`scripts/check-seed-parity.mjs`（**10 项**，没有 DSH 的机器上自动跳过）把"我们照抄了官方语义"
这句话变成可执行的判据：它从宿主包里解析出 `@deepseek-ai/dsh-session/fork`，**真的调用**
官方 `buildForkSeed`，与我们 `src/seed.js` 的输出在 8 组事件流上逐字节比对 `JSON.stringify`；
边界函数 `latestCompletedPrefixBoundary` 则是从 `dsh-api-session-controller` 的产物里按花括号配平
**切出源码现场编译**再比对返回值（这一条专门防止"拿我们自己的边界去比我们自己的种子"这种自证）。
任何一条不等，说明宿主改了 fork 语义而 `src/seed.ts` 没跟上——这正是这条校验存在的意义。

`scripts/check-registration.mjs`（**3 项**）补上前面那些桩测不到的一环：它加载**宿主真实的**
`@deepseek-ai/dsh-client-modules`，按浏览器的顺序装好 `window.__ModuleLoader__` 队列门面，
然后走一遍宿主那条判据（`loadBundle(url)` → `factories.has(row.id)`）。这条判据要求
**ModuleLoader 的注册 id 必须等于包名**（`row.id` 就是加载器条目名），所以注册 id 由
`scripts/build-client.mjs` 从 `package.json` 的 `name` 现读，不再手写。

宿主代码的位置按版本换过地方，脚本按顺序找：`DSH_APP_ROOT` 环境变量 →
`C:\Program Files\DSH Desktop\resources\app\node_modules\…`（0.1.x 三方桌面版）→ 本包依赖。
**0.2.x 起官方桌面版把 dsh 运行时打包进了 `app.asar`**（0.2.1-rc.2 的安装位置变成
`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar`），普通 Node / ripgrep 都读不到
asar 内部的文件，所以要在新宿主上跑这两项得先解包，再指过去：

```powershell
# 本地脚手架（下划线开头的目录已被 .gitignore 忽略，不入库）：
# 从 app.asar 里按需解出需要的包（内置最小 asar 读取器，不依赖任何 asar 工具）
node _asar/extract.mjs "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app.asar" _asar/dsh `
  dsh-session dsh-api-session-controller dsh-client-modules dsh-workspace dsh-client-ui-workspace `
  dsh-cordis-client-runner dsh-agent-loop dsh-app-boot dsh-brand dsh-util-values dsh-config-editor `
  dsh-session-query dsh-agent-preset-registry dsh-agent-default-model dsh-commands dsh-host-webserver `
  dsh-session-projection dsh-api-workspace-controller semver

$env:DSH_APP_ROOT = "$PWD\_asar\dsh"   # 指向解出来的树（脚本找 <root>/node_modules/@deepseek-ai/...）
npm run check:registration
npm run check:seed-parity
```

同一个 `_asar/` 里还有两个一次性探针，本次适配就是靠它们得出"只有选择器桥改名"这个结论的：
`probe-compat.mjs`（拿宿主自己的 `evaluatePluginCompatibility` 判版本门槛；顺手证明
`^0.2.0-rc.1` 覆盖 `0.2.1-rc.2`）与 `find-bytes.mjs`（在 asar 的字节里搜字符串，
用来确认 `__DSH_DESKTOP_PICK_DIRECTORY__` 已被 `__DSH_DIRECTORY_PICKER__` 取代）。

脚本会自动适配两代 `makeRequire` 签名（0.1.x 是 `(edges)`，0.2.x 是 `(ownerId, edges)`），
本机没有 DSH 时该项自动跳过（打印原因并以 0 退出），不影响 `npm run check`。

## 7. 发布前检查清单

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
9. **设置表单（0.2.0 起）**：「设置 → 插件 → 临时任务」里能改根目录 / 自动清理天数，
   改完**不重启**就该生效（改 `rootDir` 后新建任务落到新目录）；设置卡片里的「配置来源」应显示
   「DSH 插件配置」，profile 的 `cordis.patch.yml` 里本插件那一行应该长出 `config:` 段。
10. **两半版本**：0.2.x（`rc.1` / `rc.2` 实测）上重启后设置卡片页脚的两半都应显示**同一个版本号**（就是
    `package.json` 的 `version`，两边现在都从它取，不再手写；后端是 Node 侧的编译产物，
    改完必须重启 DSH 才会换）。
11. **转正（0.5.0 起最该先试的一条）**：挑一个**真的聊过几轮**的临时任务 →
    点爱心 → 填新名与父目录 → 转正。要看四件事：
    (a) 新目录里文件齐全、旧目录已消失；
    (b) 新节点标题是**新目录名**、旧节点不见了；
    (c) 新家那条会话打开后**能看到完整旧对话**、并且还能接着聊（工具/终端都在新目录里工作）；
    (d) 旧会话从侧边栏消失（归档）。另外故意在**会话还开着并且正在跑**的时候转正一次，
    应当得到 `DIR_BUSY` 的提示而不是半个状态。
    自动化里这条链路的桩已覆盖（含 `seed` 的字节级形状），但**真实的 agents 工厂 + 真实的
    Windows 文件占用**只有真机能证伪。

### 发布前需要人工确认

- `package.json` 的 `repository` / `homepage` / `bugs` / `author` 与仓库一致；
- **真安装形态**：开发时用 `link:` 安装即可，发布形态是 tarball —— 建议 `npm pack` 后在**临时 profile** 里
  `dsh plugin --profile <profile> add ./aeroscis-dsh-temptask-<版本>.tgz` 启动验证一次；
- **卸载**：`dsh plugin --profile <profile> remove @aeroscis/dsh-temptask` 之后 profile 仍能正常启动
  （语义是保留任务目录与 `tasks.json`）。

### 已知限制

- **不支持真正删除会话**：只能归档（DSH 未提供删除 API，见 README 的《数据在哪》）；
- **跨进程并发**只保证「写前重读 + 按 id 合并」，仍存在亚毫秒级残留窗口（自动化用例是同进程双实例模拟）；
- **无障碍**：那一行内部控件位于官方 `aria-hidden` 字形槽内，屏幕阅读器无法读取；
  等价动作在「设置 → 插件 → 临时任务」与 `/temptask` 命令里都可键盘到达。
- **转正搬目录会被"占用"挡住**（Windows 上最常遇到）：活着的会话、正在跑的回合，或者侧边栏终端
  仍握着那个 cwd 时，`rename` 会失败。本插件把它翻译成 `DIR_BUSY` 并提示「先关掉该任务的会话/终端
  再重试」——**此时不会有任何东西被改动**（搬目录是第一步，失败即整体中止）。
- **转正后旧对话不会"跟着"旧节点**：旧会话按现有策略归档（日志仍在磁盘，DSH 没有反归档入口），
  新家得到的是复刻出来的新会话。想保留旧会话就改设置 `onDeleteSessions: keep`（它会落到"未分组"）。
- **转正只复刻"已完成的一轮"**：最后一次 `turn/end` 之后还没收尾的内容不会被继承（那部分本来
  就没有可信的结束状态）；没有已完成回合时会退化成空会话。
- **转正的目标不能落在任务根目录内部**：那会被自动登记逻辑当成新的临时任务，等于原地打转。
