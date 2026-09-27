/**
 * dsh-temptask — client half 离线冒烟测试。
 *
 * 验证的不是「逻辑」而是「包能不能被 DSH 的浏览器端接起来」：
 *   1. client/client.js 以 ModuleLoader 形式注册了 id/factory；
 *   2. 工厂只依赖平台 seed 模块 react（require 其它模块即为契约漂移，直接失败）；
 *   3. 导出带 inject/apply，apply 注册：侧边栏那一行（sidebar.panellist）、
 *      同名的**空**面板（main，兜底，绝不出页面）、浮层（shell.overlay ×2：气泡 + 守护）、
 *      设置卡片（settings.section）；
 *   4. 那一行按确认过的 UI 渲染：「临时任务」+ ＋/🧹/⧉/? 四个小按钮；窄栏只留图标；
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

/* ── 1. 以浏览器的方式装载包 ── */
let registration;
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      registration = value;
    },
  },
};

await import('../client/client.js');

check('client.js 通过 window.__ModuleLoader__.load 注册', () => {
  assert.ok(registration !== undefined, 'bundle 没有注册工厂');
  assert.equal(registration.id, 'dsh-temptask');
  assert.equal(typeof registration.factory, 'function');
});

const requiredModules = new Set();

/** 官方图标集的替身：每个图标渲染成带 data-official 标记的 svg，方便断言"确实用了官方图标"。 */
function makeOfficialIcon(name) {
  return (props = {}) =>
    React.createElement('svg', {
      'data-official': name,
      width: props.size ?? 16,
      height: props.size ?? 16,
    });
}

const fakePrimitives = {
  IconFolderOpenOutline16: makeOfficialIcon('IconFolderOpenOutline16'),
  IconNewChatOutline16: makeOfficialIcon('IconNewChatOutline16'),
  IconTrashOutline16: makeOfficialIcon('IconTrashOutline16'),
  IconPlusOutline16: makeOfficialIcon('IconPlusOutline16'),
  IconLoadingOutline16: makeOfficialIcon('IconLoadingOutline16'),
  IconCopyOutline16: makeOfficialIcon('IconCopyOutline16'),
  IconQuestionOutline14: makeOfficialIcon('IconQuestionOutline14'),
  IconCheckOutline16: makeOfficialIcon('IconCheckOutline16'),
  IconSettingsOutline16: makeOfficialIcon('IconSettingsOutline16'),
  IconRightUpOutline16: makeOfficialIcon('IconRightUpOutline16'),
};

function factoryRequire(spec) {
  requiredModules.add(spec);
  if (spec === 'react') return React;
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return fakePrimitives;
  throw new Error(`require("${spec}") 不在平台 seed 表中`);
}

const mod = registration.factory(factoryRequire);

check('工厂只 require react + 官方图标集（无未声明的模块依赖）', () => {
  assert.deepEqual(
    [...requiredModules].sort(),
    ['@deepseek-ai/dsh-client-ui-primitives', 'react'].sort(),
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

function createClientStub({ withSettings = true, withLocale = true } = {}) {
  const registrations = [];
  const opened = [];
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
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get(name) {
      if (name === 'slots') return slots;
      if (name === 'locale') return withLocale ? locale : undefined;
      if (name === 'sessions') return { open: (id) => opened.push(id) };
      if (name === 'layout') return { selectPanel: () => {} };
      if (name === 'settingsScope' && withSettings) return { bind: () => scopeStub };
      return undefined;
    },
    effect(fn) {
      const disposer = fn();
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
  };
  return { ctx, registrations, opened };
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

check('宽栏那一行：主区整块可点=新建 + 右侧四个次要按钮，且用的是官方图标集', () => {
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
  for (const name of [
    'IconTrashOutline16',
    'IconCopyOutline16',
    'IconQuestionOutline14',
    'IconSettingsOutline16',
  ]) {
    assert.ok(markup.includes(`data-official="${name}"`), `应使用官方图标 ${name}\n${markup}`);
  }
  assert.equal(markup.includes('＋'), false, '不应再出现细笔画的文本加号');
});

const bundleSource = await readFile(new URL('../client/client.js', import.meta.url), 'utf8');
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

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
check('package.json 声明了客户端依赖，保证官方图标集先于本包到达', () => {
  assert.deepEqual(packageJson.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-primitives']);
  assert.equal(packageJson.dsh.client.platform, 'web');
});

check('官方图标集缺席时退回文本字形（少一个图标不能让 UI 挂掉）', () => {
  const bareMod = registration.factory((spec) => {
    if (spec === 'react') return React;
    throw new Error('primitives 不在图里');
  });
  const barePlugin = typeof bareMod?.apply === 'function' ? bareMod : bareMod?.default;
  const bare = createClientStub();
  barePlugin.apply(bare.ctx);
  const entry = bare.registrations.find((item) => item.options.name === 'sidebar.panellist');
  assert.ok(entry !== undefined, '降级时那一行仍然要注册');
  const markup = render(entry.component, { size: 16, active: false });
  assert.ok(markup.includes('临时任务'), markup);
  assert.ok(markup.includes('🧹') && markup.includes('?'), `应退回文本字形\n${markup}`);
  assert.ok(markup.includes('data-tt-mark="temporary"'), '自绘标记不依赖官方图标集，任何情况下都在');
  assert.equal((markup.match(/<button/gu) ?? []).length, 4, '四个次要按钮仍然要在');
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
    help.includes('主程序 v') && help.includes('界面 v'),
    '版本要用「主程序 / 界面」这种能看懂的说法分开显示，而不是 host/client 术语',
  );
  assert.ok(help.includes('重启 DSH'), '要直接说清"主程序要重启才更新"');
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
  assert.ok(openable.includes('data-official="IconRightUpOutline16"'), '打开用官方"外部打开"图标');
  assert.equal(openable.includes('aria-label="复制任务根目录"'), false, '能打开时不再占一个复制按钮');

  const notOpenable = render(row, { size: 16, active: false, canOpenPath: false });
  assert.ok(notOpenable.includes('aria-label="复制任务根目录"'), notOpenable);
  assert.ok(notOpenable.includes('data-official="IconCopyOutline16"'), notOpenable);
});

check('悬浮详情自动收起的延迟是 450ms（600ms 偏慢）', () => {
  assert.equal(internals.TRAY_AUTO_CLOSE_MS, 450);
});

check('两半版本不一致能被判出来（说明"界面已更新但主程序还是旧的"）', () => {
  const differ = internals.halvesDiffer;
  assert.equal(typeof differ, 'function', '缺少 halvesDiffer');
  assert.equal(differ('0.2.0', '0.2.3'), true, '一旧一新应判为不一致');
  assert.equal(differ('0.2.3', '0.2.3'), false, '一致时不提示');
  assert.equal(differ(undefined, '0.2.3'), false, '拿不到主程序版本时不做任何断言');
});

check('设置卡片渲染根目录 / 自动清理 / 与 dsh-side-session 的区别', () => {
  const markup = render(entryOf('settings.section').component, {});
  assert.ok(markup.includes('任务根目录'), markup);
  assert.ok(markup.includes('自动清理天数'), markup);
  assert.ok(markup.includes('dsh-side-session'), markup);
  assert.ok(markup.includes('保存'), markup);
});

check('settingsScope 缺失时只注册 4 个插槽（设置卡片降级跳过）', () => {
  const bare = createClientStub({ withSettings: false });
  plugin.apply(bare.ctx);
  assert.deepEqual(
    bare.registrations.map((item) => item.options.name),
    ['sidebar.panellist', 'main', 'shell.overlay', 'shell.overlay'],
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
