/**
 * dsh-temptask — client half 离线冒烟测试。
 *
 * 验证的不是「逻辑」而是「包能不能被 DSH 的浏览器端接起来」：
 *   1. client/client.js 以 ModuleLoader 形式注册了 id/factory；
 *   2. 工厂只依赖平台 seed 模块 react（require 其它模块即为契约漂移，直接失败）——
 *      图标是自绘 SVG，宿主图标包（0.1.7 起改过导出名）不再是本包的依赖；
 *   3. 导出带 inject/apply，apply 注册：侧边栏那一行（sidebar.panellist，order 取负值
 *      以排在官方「插件」面板行之前）、同名的**空**面板（main，兜底，绝不出页面）、
 *      浮层（shell.overlay ×2：气泡 + 守护）、设置卡片（settings.section）；
 *   4. 那一行按确认过的 UI 渲染：「临时任务」+ 清理/打开/说明/设置四个小按钮，每个字形
 *      都带 `data-tt-icon` 标记（自绘，因此不随宿主图标改名而变形）；窄栏只留图标；
 *   5. 行的 label 是 i18n thunk：切换语言后再取必须得到另一种语言；
 *   6. 浮层：关闭时渲染 null，help 显示说明，notice 显示错误；
 *   7. settingsScope / locale 缺失时各自降级。
 *
 * 运行：node scripts/smoke-client.mjs（需要 devDependencies 里的 react / react-dom）
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}
async function checkAsync(label, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

/* ── 1. 以浏览器的方式装载包 ── */
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

let registration;
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      registration = value;
    },
  },
};

await import('../client/client.js');

check('client.js 通过 window.__ModuleLoader__.load 以**包名**注册', () => {
  assert.ok(registration !== undefined, 'bundle 没有注册工厂');
  // 宿主 dsh-client-modules 用加载器条目名（= package.json 的 name）当图行 id，
  // 装载后按这个 id 查 factories。写成短名（dsh-temptask）会让整批 combo 脚本失败：
  // "bundle … loaded without registering \"@aeroscis/dsh-temptask\""。
  assert.equal(
    registration.id,
    packageJson.name,
    `注册 id 必须等于包名（宿主按包名找工厂）`,
  );
  assert.equal(typeof registration.factory, 'function');
});

const requiredModules = new Set();

/**
 * 工厂的 require：平台只 seed 了 react。
 *
 * 这里**故意**对其它模块抛错——本包在 0.3.3 起不再 require 宿主的图标包
 * （`@deepseek-ai/dsh-client-ui-primitives`，其图标导出名在 0.1.7 里从 `…Outline16`
 * 改成 `…OutlineRegular|Medium`，老名字取不到会静默降级成 emoji）。若哪天产物里又冒出
 * 对宿主包的 require，这条桩会立刻把构建打回原形。
 */
function factoryRequire(spec) {
  requiredModules.add(spec);
  if (spec === 'react') return React;
  throw new Error(`require("${spec}") 不在平台 seed 表中（本包只允许 require react）`);
}

const mod = registration.factory(factoryRequire);

check('工厂只 require react（图标已自绘，不再依赖宿主图标包）', () => {
  assert.deepEqual(
    [...requiredModules],
    ['react'],
    `实际 require：${[...requiredModules].join(', ')}`,
  );
});

// 工厂返回的就是 module.exports：既可能是插件对象本身，也可能是 { default: 插件 }（ESM 互操作）。
const plugin = typeof mod?.apply === 'function' ? mod : mod?.default;
check('模块导出带 inject/apply', () => {
  assert.ok(plugin !== undefined, '缺少插件导出（apply）');
  assert.equal(typeof plugin.apply, 'function');
  assert.deepEqual(plugin.inject, ['slots', 'locale']);
});

/* ── 2. 桩客户端上下文 ── */

/**
 * 桩 settingsScope（0.1.x 的客户端配置通道）。
 */
const scopeStub = {
  getSnapshot: () => ({
    status: 'ready',
    writable: true,
    value: { rootDir: 'C:\\Users\\me\\.dsh\\dsh-temptask', autoCleanDays: 7, dataDir: '' },
  }),
  load: async () => {},
  subscribe: () => () => {},
  set: async () => {},
  unset: async () => {},
  dispose: () => {},
};

/** 桩 locale：bind 出来的翻译函数按**当前**语言解析（复刻真实 locale 服务的行为）。 */
const LOCALES = {
  zh: { nav: '临时任务' },
  en: { nav: 'Temporary tasks' },
};
let activeLocale = 'zh';

function createClientStub({
  withSettings = true,
  withLocale = true,
  withConfigForms = true,
  withUiWorkspace = true,
  configFormAccepts = true,
} = {}) {
  const registrations = [];
  const opened = [];
  const legacyBinds = [];
  const configFormRequests = [];
  const configFormWrites = [];
  const slots = {
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
    inject(_key, callback) {
      callback();
      return () => {};
    },
  };
  const locale = {
    register: () => () => {},
    bind: () => (key) => (LOCALES[activeLocale] ?? {})[key] ?? key,
    getLocale: () => ({ id: activeLocale }),
  };
  /** 桩 configForms（0.2.0 的客户端配置表单）：`set` 用布尔回答「宿主收没收」。 */
  const configForm = {
    getSnapshot: () => ({
      status: 'ready',
      writable: true,
      value: { rootDir: 'C:\\Users\\me\\.dsh\\dsh-temptask', autoCleanDays: 7 },
    }),
    subscribe: () => () => {},
    set: async (field, value) => {
      configFormWrites.push([field, value]);
      return configFormAccepts;
    },
    unset: async (field) => {
      configFormWrites.push([field, undefined]);
      return configFormAccepts;
    },
  };
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get(name) {
      if (name === 'slots') return slots;
      if (name === 'locale') return withLocale ? locale : undefined;
      if (name === 'configForms' && withConfigForms) {
        return {
          get: (entryId) => {
            configFormRequests.push(entryId);
            return configForm;
          },
        };
      }
      if (name === 'uiWorkspace' && withUiWorkspace) return { openSession: (id) => opened.push(id) };
      if (name === 'sessions') return { open: (id) => opened.push(id) };
      if (name === 'layout') return { selectPanel: () => {} };
      if (name === 'settingsScope' && withSettings) {
        return {
          bind: ({ namespace }) => {
            legacyBinds.push(namespace);
            return scopeStub;
          },
        };
      }
      return undefined;
    },
    effect(fn) {
      const disposer = fn();
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
  };
  return {
    ctx,
    registrations,
    opened,
    legacyBinds,
    configFormRequests,
    configFormWrites,
    configForm,
  };
}

const { ctx, registrations } = createClientStub();
plugin.apply(ctx);

function entriesOf(name) {
  return registrations.filter((item) => item.options.name === name);
}
function entryOf(name) {
  const list = entriesOf(name);
  assert.equal(list.length, 1, `${name} 应恰好注册一次，实际 ${list.length}`);
  return list[0];
}
function overlayOf(id) {
  const entry = registrations.find(
    (item) => item.options.name === 'shell.overlay' && item.options.id === id,
  );
  assert.ok(entry !== undefined, `未注册浮层 ${id}`);
  return entry;
}

check('apply 注册：侧边栏那一行 / 兜底空面板 / 浮层 ×2 / 设置卡片', () => {
  assert.deepEqual(
    registrations.map((item) => item.options.name),
    ['sidebar.panellist', 'main', 'shell.overlay', 'shell.overlay', 'settings.section'],
  );
  assert.equal(entryOf('sidebar.panellist').options.id, 'dsh-temptask');
  assert.equal(entryOf('main').options.key, 'dsh-temptask', '面板行的 id 必须与 main 的 key 同名');
  assert.ok(overlayOf('dsh-temptask-tray') !== undefined);
  assert.ok(overlayOf('dsh-temptask-pending-open') !== undefined);
});

check('面板行的 order 取负值：排到官方「插件」面板行（order 0）前面，紧贴「新建会话」', () => {
  const order = entryOf('sidebar.panellist').options.order;
  assert.equal(typeof order, 'number', 'order 必须显式给出：官方按它升序渲染面板列表');
  assert.ok(
    order < 0,
    `order 必须 < 0：0.1.7 起官方自己注册了「插件」面板行（id "plugins"、order 0），` +
      `取正数就会被它压在上面，本行贴不到「新建会话」正下方（当前 ${order}）`,
  );
});

check('那一行的 label 是 i18n thunk：切换语言后再取必须跟着变', () => {
  const label = entryOf('sidebar.panellist').options.label;
  assert.equal(typeof label, 'function', 'label 必须是 thunk');
  assert.equal(entryOf('sidebar.panellist').options.locale, 'dsh-temptask');
  assert.equal(label(), '临时任务');
  activeLocale = 'en';
  assert.equal(label(), 'Temporary tasks');
  activeLocale = 'zh';
  assert.equal(label(), '临时任务');
});

/* ── 3. 渲染测试 ── */

const internals = plugin.__internals;
check('__internals 暴露内部件与词典供离线渲染', () => {
  assert.ok(internals !== undefined);
  for (const key of [
    'ZH',
    'EN',
    'TaskIcon',
    'TemptaskRow',
    'TemptaskTray',
    'CleanDialog',
    'PendingOpenWatcher',
    'SettingsSection',
    'createTray',
  ]) {
    assert.ok(internals[key] !== undefined, `缺少 ${key}`);
  }
  assert.equal(internals.ZH.nav, '临时任务');
  assert.equal(internals.EN.nav, 'Temporary tasks');
});

function render(component, props) {
  return renderToStaticMarkup(React.createElement(component, props));
}

const runtime = {
  t: (key) => internals.ZH[key] ?? key,
  openSession: () => {},
  notice: () => {},
};

check('宽栏那一行：主区整块可点=新建 + 右侧四个次要按钮，字形全部自绘', () => {
  const row = entryOf('sidebar.panellist').component;
  const markup = render(row, { size: 16, active: false });

  // 本行自己画标签文字；官方 PanelRow 会把注册的 label 再渲染一次标题，那一次发生在官方
  // 组件内部，本测试看不到——所以它由下一条检查（CSS 作用域规则 + __tt_row 钩子）兜住。
  assert.equal(
    (markup.match(/>临时任务</gu) ?? []).length,
    1,
    `本行自己的标签文字节点应只有一个\n${markup}`,
  );
  assert.ok(
    markup.includes('class="__tt_row'),
    '必须保留 __tt_row 钩子类：隐藏官方重复标题的规则靠 :has(.__tt_row) 限定作用域',
  );
  assert.ok(markup.includes('__tt_rowWide'), '宽栏这一行要带"官方新建会话按钮"那套边框样式');

  // 主区：整块可点 = 新建（用 role="button" 而不是嵌套 <button>）
  assert.ok(markup.includes('role="button"'), '主区应是可点区域');
  assert.ok(markup.includes('tabindex="0"'), '主区应可键盘聚焦');
  assert.ok(markup.includes('aria-label="新建临时任务"'), markup);
  assert.ok(markup.includes('__tt_primary'), '主区应有独立样式钩子');
  assert.ok(markup.includes('__tt_divider'), '主区与次要动作之间应有分隔线');

  // 次要动作：四个真按钮（清理 / 打开或复制 / 说明 / 设置）
  for (const label of ['清理临时任务', '说明', '临时任务设置']) {
    assert.ok(markup.includes(`aria-label="${label}"`), `缺少按钮：${label}\n${markup}`);
  }
  assert.equal((markup.match(/<button/gu) ?? []).length, 4, '次要动作应恰好四个按钮');

  // 主区图标：自绘「临时任务」标记（文件夹 + 时钟），不再用细笔画 ＋ 或官方加号
  assert.ok(
    markup.includes('data-tt-mark="temporary"'),
    '主区应使用自绘的「临时任务」标记（＋ 辨识度低，且窄栏下与官方新建会话分不清）',
  );
  // 行内字形一律自绘：`data-tt-icon` 是它们的记号。宿主图标包改名（0.1.7 把 …Outline16
  // 改成 …OutlineRegular|Medium）不该再影响这里，所以断言只认自己的记号。
  for (const name of ['trash', 'copy', 'help', 'settings']) {
    assert.ok(markup.includes(`data-tt-icon="${name}"`), `应使用自绘字形 ${name}\n${markup}`);
  }
  assert.equal(markup.includes('data-official='), false, '不该再引用宿主图标包的图标');
  assert.equal(markup.includes('＋'), false, '不应再出现细笔画的文本加号');
  assert.equal(markup.includes('🧹'), false, '不应再出现 🧹 这类当兜底的 emoji 字形');
});

const bundleSource = await readFile(new URL('../client/client.js', import.meta.url), 'utf8');

check('构建产物只注册一次，且 id 就是包名（回归：短名会让整批插件加载失败）', () => {
  const loads = bundleSource.match(/__ModuleLoader__\.load\(/gu) ?? [];
  assert.equal(loads.length, 1, `bundle 应恰好调用一次 __ModuleLoader__.load，实际 ${loads.length} 次`);
  const header = `__ModuleLoader__.load({`;
  const head = bundleSource.slice(bundleSource.indexOf(header), bundleSource.indexOf(header) + 200);
  assert.ok(
    head.includes(`id: ${JSON.stringify(packageJson.name)}`),
    `构建产物里的注册 id 必须等于 package.json 的 name（${packageJson.name}），实际头部：${head}`,
  );
  assert.equal(
    head.includes(`id: "dsh-temptask"`),
    false,
    '不该再出现短名 dsh-temptask 作为注册 id（那是设置命名空间/目录名，不是模块 id）',
  );
});

check('构建产物里带着「只在本行隐藏官方 title」的样式（防重复标签）', () => {
  assert.ok(
    bundleSource.includes(':has(.__tt_row)'),
    '隐藏规则必须用 :has(.__tt_row) 限定作用域，否则会波及其它面板行的标题',
  );
  assert.ok(bundleSource.includes('panelTitle'), '应指向官方渲染的标题节点');
  assert.ok(
    bundleSource.includes('__tt_rowWide') &&
      bundleSource.includes('button-elevated-fill') &&
      bundleSource.includes('border-l3'),
    '这一行的边框应沿用官方 .newSession 的 token（border-l3 + button-elevated-fill），而不是自己编颜色',
  );
  assert.ok(
    bundleSource.includes('panelGlyph') && bundleSource.includes('flex:1 1 auto'),
    '必须把官方 .panelGlyph 改成可伸展：它默认 flex:none，会让整行不随侧边栏宽度缩放',
  );
  assert.ok(
    entryOf('sidebar.panellist').options.label().length > 0,
    'label 必须非空：官方用它做 tooltip 与无障碍名（可见文字由本行自己渲染）',
  );
});

check('package.json 不再声明宿主图标包依赖（图标自绘，client 只需要 platform: web）', () => {
  assert.equal(packageJson.dsh.client.platform, 'web');
  assert.equal(
    packageJson.dsh.client.inject,
    undefined,
    'inject 只用于「先加载哪个 client 包」的排序；图标自绘后本包不再需要它，' +
      '留着一个用不到的条目反而会在宿主移除该包时拖垮加载（computer-user 就是只写 platform 的先例）',
  );
});

check('宿主图标包改名的回归：产物里不再 require 它', () => {
  // 注释里提到包名是允许的（说明"为什么不再用它"），这里卡的是**真的调用**。
  const calls = bundleSource.match(/require\(\s*["'][^"']+["']\s*\)/gu) ?? [];
  assert.deepEqual(
    [...new Set(calls)].sort(),
    ['require("react")'],
    `产物的 require 只允许 react（图标自绘后宿主图标包不再是依赖），实际：${calls.join(', ')}`,
  );
});

check('自绘字形不依赖任何外部资源：每个按钮都渲染出内联 svg', () => {
  const row = entryOf('sidebar.panellist').component;
  const markup = render(row, { size: 16, active: false });
  // 主区 1 枚 + 次要动作 4 枚 = 5 枚自绘 svg（图标是 data-tt-icon / data-tt-mark 标记的）
  const glyphs = (markup.match(/data-tt-(?:icon|mark)=/gu) ?? []).length;
  assert.equal(glyphs, 5, `应有 5 枚自绘字形（主区 + 四个按钮），实际 ${glyphs}\n${markup}`);
  assert.equal(markup.includes('<img'), false, '不该有外链图片');
  assert.equal(markup.includes('http'), false, '不该有外链 URL');
});

check('窄栏那一行：只留主区图标（无文字、无次要按钮）', () => {
  const row = entryOf('sidebar.panellist').component;
  const markup = render(row, { size: 18, active: true });
  assert.ok(markup.includes('<svg'), markup);
  assert.ok(markup.includes('__tt_primary'), '窄栏要保留主区——36×36 的那块就是"新建"');
  assert.ok(
    markup.includes('__tt_primaryRail'),
    '窄栏主区要居中（否则图标会贴在左上角）',
  );
  assert.ok(
    markup.includes('data-tt-mark="temporary"'),
    '窄栏只剩这一个图标，它必须自己能表示"临时任务"',
  );
  assert.equal(
    markup.includes('__tt_primaryLabel'),
    false,
    '窄栏不该有可见标签（注意不能拿"临时任务"子串判断：无障碍名里也含这三个字）',
  );
  assert.equal(markup.includes('<button'), false, '窄栏不该有次要按钮');
  assert.equal(markup.includes('__tt_divider'), false, '窄栏没有分隔线');
});

check('兜底面板渲染 null —— 点那一行不会出现任何页面', () => {
  assert.equal(render(entryOf('main').component, {}), '');
});

check('常驻守护组件渲染 null（不产生任何可见 DOM）', () => {
  assert.equal(render(overlayOf('dsh-temptask-pending-open').component, {}), '');
});

check('浮层：关闭时不渲染；help 显示说明；notice 显示失败原因', () => {
  const tray = internals.createTray();
  const layer = overlayOf('dsh-temptask-tray').component;

  assert.equal(render(layer, { runtime, tray }), '', '未打开任何浮层时应渲染 null');

  tray.set({ panel: 'help', anchor: { left: 12, top: 96 } });
  const help = render(layer, { runtime, tray });
  assert.ok(help.includes('任务数量'), help);
  assert.ok(help.includes('任务根目录'), help);
  assert.ok(help.includes('记录文件'), help);
  assert.ok(help.includes('会话在哪'), help);
  assert.ok(help.includes('dsh-side-session'), help);
  assert.ok(help.includes('更多设置'), help);
  assert.ok(help.includes('版本'), '说明气泡里应能看到版本，用来确认"跑的是哪一版"');
  assert.ok(
    help.includes('插件后端 v') && help.includes('插件界面 v'),
    '版本要标明是「插件后端 / 插件界面」——不能让人误以为那是 DSH 的版本',
  );
  assert.ok(help.includes('重启 DSH'), '要直接说清"插件后端要重启才更新"');
  assert.equal(
    (help.match(/<button/gu) ?? []).length,
    0,
    '详情气泡不该再有任何按钮——它是悬浮详情，靠"鼠标移开自动收起"',
  );
  assert.ok(help.includes('自动关闭'), '应提示它会自动收起');
  assert.ok(help.includes('left:12px') || help.includes('left: 12px'), '应贴在锚点位置');

  tray.set({ panel: 'notice', anchor: null, message: '创建失败：宿主未提供 workspaceRegistry' });
  const notice = render(layer, { runtime, tray });
  assert.ok(notice.includes('创建失败：宿主未提供 workspaceRegistry'), notice);
  assert.ok(notice.includes('left:12px'), '提示气泡也要有定位（没有锚点时用兜底坐标）');

  tray.set({ panel: 'clean', anchor: null });
  const clean = render(layer, { runtime, tray });
  assert.ok(clean.includes('清理临时任务'), clean);
  assert.ok(clean.includes('确认清理'), clean);

  // 回归：设置浮层曾经没接收锚点坐标，position:fixed 又没 left/top，于是贴到了视口左上角。
  tray.set({ panel: 'settings', anchor: { left: 180, top: 140 } });
  const gear = render(layer, { runtime, tray });
  assert.ok(
    gear.includes('left:180px') && gear.includes('top:140px'),
    `设置浮层必须贴在齿轮按钮旁边，而不是左上角\n${gear}`,
  );
});

check('清理确认框渲染任务行 / 状态 / 二次确认按钮', () => {
  const tasks = [
    {
      id: 'a',
      dirName: '2026-09-27-14-30-00',
      path: 'C:\\Users\\me\\.dsh\\dsh-temptask\\2026-09-27-14-30-00',
      createdAt: Date.now(),
      status: 'closed',
      title: '修复登录 bug',
      workspacePresent: true,
    },
    {
      id: 'b',
      dirName: '2026-09-27-14-31-00',
      path: 'C:\\Users\\me\\.dsh\\dsh-temptask\\2026-09-27-14-31-00',
      createdAt: Date.now(),
      status: 'active',
      workspacePresent: false,
    },
  ];
  const markup = render(internals.CleanDialog, { runtime, tasks, onClose: () => {}, onDone: () => {} });
  assert.ok(markup.includes('修复登录 bug'), markup);
  assert.ok(markup.includes('2026-09-27-14-31-00'), '没有标题时回落到时间戳目录名');
  assert.ok(markup.includes('全选') && markup.includes('全不选'), markup);
  assert.ok(markup.includes('使用中') && markup.includes('已关闭'), markup);
  assert.ok(markup.includes('节点已不存在'), '工作区缺失要有标记');
  assert.ok(markup.includes('checked'), '默认应勾选 closed 的任务');
});

check('清理确认框在无任务时渲染空状态', () => {
  const markup = render(internals.CleanDialog, {
    runtime,
    tasks: [],
    onClose: () => {},
    onDone: () => {},
  });
  assert.ok(markup.includes('暂无临时任务'), markup);
});

check('齿轮设置面板：两档删除策略，当前档位被标为选中；没有 settingsScope 也能用', () => {
  const panel = internals.TaskSettingsPanel;
  const archive = render(panel, {
    runtime,
    policy: 'archive',
    pluginVersion: '0.2.0',
    scope: scopeStub,
    onSaved: () => {},
    onClose: () => {},
  });
  assert.ok(archive.includes('归档会话（推荐）'), archive);
  assert.ok(archive.includes('留在未分组'), archive);
  assert.ok(archive.includes('删除任务时'), archive);
  assert.ok(archive.includes('v0.2.0'), '页脚应显示 host 版本，便于确认跑的是哪一版');
  assert.ok(
    (archive.match(/<button/gu) ?? []).length > 0,
    '齿轮是"操作面板"，不能像详情那样自动收起，必须保留按钮',
  );
  assert.ok(
    archive.indexOf('__tt_optionOn') !== -1 &&
      archive.indexOf('__tt_optionOn') < archive.indexOf('留在未分组'),
    '策略为 archive 时，选中的应是第一项',
  );

  const keep = render(panel, {
    runtime,
    policy: 'keep',
    scope: scopeStub,
    onSaved: () => {},
    onClose: () => {},
  });
  assert.ok(
    keep.indexOf('__tt_optionOn') > keep.indexOf('归档会话（推荐）'),
    '策略为 keep 时，选中的应是第二项',
  );

  const noScope = render(panel, { runtime, policy: 'archive', onSaved: () => {}, onClose: () => {} });
  assert.ok(noScope.includes('归档会话（推荐）'), '没有 settingsScope 时齿轮仍要可用（走 /api/config）');
});

check('清理确认框按策略如实描述会话去向，并标出正在运行的任务', () => {
  const tasks = [
    {
      id: 'a',
      dirName: '2026-09-27-14-30-00',
      path: 'C:\\Users\\me\\.dsh\\dsh-temptask\\2026-09-27-14-30-00',
      createdAt: Date.now(),
      status: 'active',
      workspacePresent: true,
      live: true,
    },
  ];
  const archive = render(internals.CleanDialog, {
    runtime,
    tasks,
    policy: 'archive',
    onClose: () => {},
    onDone: () => {},
  });
  assert.ok(archive.includes('归档'), archive);
  assert.ok(archive.includes('运行中'), archive);
  assert.ok(archive.includes('会先中止'), archive);

  const keep = render(internals.CleanDialog, {
    runtime,
    tasks,
    policy: 'keep',
    onClose: () => {},
    onDone: () => {},
  });
  assert.ok(keep.includes('留在「未分组」'), keep);
});

check('第三号按钮：能打开文件夹就「打开根目录」，否则退回「复制根目录」', () => {
  const decide = internals.rootAction;
  assert.equal(typeof decide, 'function', '缺少 rootAction');
  assert.equal(decide(true), 'open');
  assert.equal(decide(false), 'copy');
  assert.equal(decide(undefined), 'copy', '能力未知时按复制渲染（SSR / 老宿主都安全）');

  const row = entryOf('sidebar.panellist').component;
  const openable = render(row, { size: 16, active: false, canOpenPath: true });
  assert.ok(openable.includes('aria-label="打开任务根目录"'), openable);
  assert.ok(openable.includes('data-tt-icon="open"'), '打开用自绘的"外部打开"箭头');
  assert.equal(openable.includes('aria-label="复制任务根目录"'), false, '能打开时不再占一个复制按钮');

  const notOpenable = render(row, { size: 16, active: false, canOpenPath: false });
  assert.ok(notOpenable.includes('aria-label="复制任务根目录"'), notOpenable);
  assert.ok(notOpenable.includes('data-tt-icon="copy"'), notOpenable);
});

check('悬浮详情自动收起的延迟是 450ms（600ms 偏慢）', () => {
  assert.equal(internals.TRAY_AUTO_CLOSE_MS, 450);
});

check('两半版本不一致能被判出来（说明"界面已更新但后端还是旧的"）', () => {
  const differ = internals.halvesDiffer;
  assert.equal(typeof differ, 'function', '缺少 halvesDiffer');
  assert.equal(differ('0.2.0', '0.2.3'), true, '一旧一新应判为不一致');
  assert.equal(differ('0.2.3', '0.2.3'), false, '一致时不提示');
  assert.equal(differ(undefined, '0.2.3'), false, '拿不到后端版本时不做任何断言');
});

check('设置卡片渲染根目录 / 自动清理 / 与 dsh-side-session 的区别', () => {
  const markup = render(entryOf('settings.section').component, {});
  assert.ok(markup.includes('任务根目录'), markup);
  assert.ok(markup.includes('自动清理天数'), markup);
  assert.ok(markup.includes('dsh-side-session'), markup);
  assert.ok(markup.includes('保存'), markup);
});

check('配置通道缺失时也注册 5 个插槽：设置卡片改走插件自己的 HTTP 接口', () => {
  const bare = createClientStub({
    withSettings: false,
    withConfigForms: false,
    withUiWorkspace: false,
  });
  plugin.apply(bare.ctx);
  assert.deepEqual(
    bare.registrations.map((item) => item.options.name),
    ['sidebar.panellist', 'main', 'shell.overlay', 'shell.overlay', 'settings.section'],
  );
});

check('0.2.0：配置通道优先用 configForms.get(profile 行 id)，不再去 bind settingsScope', () => {
  const bare = createClientStub({ withSettings: true, withConfigForms: true });
  plugin.apply(bare.ctx);
  assert.deepEqual(
    bare.configFormRequests,
    ['dsh-temptask'],
    'configForms 按 profile 条目 id（本插件那一行 = dsh-temptask）寻址',
  );
  assert.deepEqual(bare.legacyBinds, [], '有新通道时不该再退回 settingsScope');
});

check('0.1.x：没有 configForms 时退回 settingsScope.bind({ namespace })', () => {
  const bare = createClientStub({ withSettings: true, withConfigForms: false });
  plugin.apply(bare.ctx);
  assert.deepEqual(bare.configFormRequests, []);
  assert.deepEqual(bare.legacyBinds, ['dsh-temptask']);
});

check('配置来源标签覆盖 0.2.0 的新来源，未知来源原样显示', () => {
  const label = internals.configSourceLabel;
  assert.equal(typeof label, 'function', '缺少 configSourceLabel');
  assert.equal(label('plugin-config', runtime), 'DSH 插件配置（设置 → 插件 → 临时任务）');
  assert.equal(label('settings', runtime), 'DSH 设置（设置 → 插件 → 临时任务）');
  assert.equal(label('config-file', runtime), '插件数据目录下的 config.json');
  assert.equal(label('cordis-row', runtime), '插件行配置（只读）');
  assert.equal(label('defaults', runtime), '内置默认值');
  assert.equal(label('something-new', runtime), 'something-new', '未知来源不猜，原样显示');
});

check('0.2.0：打开会话走 uiWorkspace.openSession（不再依赖 sessions.open）', () => {
  const bare = createClientStub({ withUiWorkspace: true });
  internals.createOpenSession(bare.ctx)('session-1');
  assert.deepEqual(bare.opened, ['session-1']);
});

check('0.1.x：没有 uiWorkspace 时退回 sessions.open + layout.selectPanel', () => {
  const bare = createClientStub({ withUiWorkspace: false });
  internals.createOpenSession(bare.ctx)('session-2');
  assert.deepEqual(bare.opened, ['session-2']);
});

await checkAsync('ConfigForm.set 被宿主接受（true）时直接成功，不再打插件自己的接口', async () => {
  const scope = internals.adaptConfigForm({
    getSnapshot: () => ({ status: 'ready' }),
    subscribe: () => () => {},
    set: async () => true,
    unset: async () => true,
  });
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched += 1;
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await internals.writeConfigField(scope, 'rootDir', 'C:\\x');
  assert.equal(fetched, 0, '桥成功时不该再走 HTTP');
});

await checkAsync('ConfigForm 被拒（false）时抛错，并回退到插件自己的 /api/config', async () => {
  const scope = internals.adaptConfigForm({
    getSnapshot: () => ({ status: 'ready' }),
    subscribe: () => () => {},
    set: async () => false,
    unset: async () => false,
  });
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await internals.writeConfigField(scope, 'onDeleteSessions', 'keep');
  assert.deepEqual(body, { onDeleteSessions: 'keep' }, '被拒后应把同一份改动交给 host 自己的接口');

  // 两条路都不通：必须抛错（组件据此显示失败，而不是假装保存成功）。
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: false, message: '宿主拒绝' }) });
  await assert.rejects(
    () => internals.writeConfigField(scope, 'onDeleteSessions', 'keep'),
    /宿主拒绝/,
  );
});

check('locale 服务缺失时那一行仍给中文（回落到自带词典，不 500）', () => {
  const bare = createClientStub({ withLocale: false });
  plugin.apply(bare.ctx);
  const entry = bare.registrations.find((item) => item.options.name === 'sidebar.panellist');
  assert.ok(entry !== undefined);
  assert.equal(entry.options.label(), '临时任务');
});

console.log(`\n✅ client 全部 ${passed} 项通过`);
