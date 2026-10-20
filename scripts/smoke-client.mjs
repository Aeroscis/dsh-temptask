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
 *   7. settingsScope / locale 缺失时各自降级；
 *   8. 「转正」：面板（默认值 / 预选 / 空态 / 目录选择器有无）、提交体（confirm 恒为 true）、
 *      失败时 hint 一起显示、官方会话行两个槽位（非任务会话渲染 null）与 ZH/EN 词典对齐。
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

check('apply 注册：侧边栏那一行 / 兜底空面板 / 浮层 ×2 / 官方会话行槽位 ×2 / 设置卡片', () => {
  assert.deepEqual(
    registrations.map((item) => item.options.name),
    [
      'sidebar.panellist',
      'main',
      'shell.overlay',
      'shell.overlay',
      // 转正的两个官方会话行入口：都由 ui-workspace 声明，所以同样走 slots.inject 注册
      'sidebar.workspaces.session.menu.item',
      'sidebar.workspaces.session.row.action',
      'settings.section',
    ],
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

/** 「取消」类的按钮文字（用于断言"最后一个按钮不是取消"）。 */
const CANCEL_LABELS = new Set(['取消', '关闭', '返回修改']);

/**
 * 模态底部按钮区里的可见文字顺序。
 *
 * 约定：**取消在左、主操作在最右**（两个模态必须一致——用户实测指出过这条不一致）。
 */
function footerLabelsOf(markup) {
  const section = /<div class="__tt_dialogActions">([\s\S]*?)<\/div>/u.exec(markup);
  if (section === null) return [];
  return [...section[1].matchAll(/<button[^>]*>([^<]*)<\/button>/gu)].map((match) => match[1].trim());
}

const runtime = {
  t: (key) => internals.ZH[key] ?? key,
  openSession: () => {},
  notice: () => {},
};

check('宽栏那一行：主区整块可点=新建 + 右侧五个次要按钮，字形全部自绘', () => {
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

  // 次要动作：五个真按钮（转正 / 清理 / 打开或复制 / 说明 / 设置）
  for (const label of ['转正…', '清理临时任务', '说明', '临时任务设置']) {
    assert.ok(markup.includes(`aria-label="${label}"`), `缺少按钮：${label}\n${markup}`);
  }
  assert.equal((markup.match(/<button/gu) ?? []).length, 5, '次要动作应恰好五个按钮');
  assert.ok(
    markup.indexOf('aria-label="清理临时任务"') < markup.indexOf('aria-label="转正…"'),
    '转正要紧跟在清理后面（用户点名的位置）：前两个是"对任务本身做处置"的动作',
  );

  // 主区图标：自绘「临时任务」标记（文件夹 + 时钟），不再用细笔画 ＋ 或官方加号
  assert.ok(
    markup.includes('data-tt-mark="temporary"'),
    '主区应使用自绘的「临时任务」标记（＋ 辨识度低，且窄栏下与官方新建会话分不清）',
  );
  // 行内字形一律自绘：`data-tt-icon` 是它们的记号。宿主图标包改名（0.1.7 把 …Outline16
  // 改成 …OutlineRegular|Medium）不该再影响这里，所以断言只认自己的记号。
  for (const name of ['heart', 'trash', 'copy', 'help', 'settings']) {
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
  // 主区 1 枚 + 次要动作 5 枚 = 6 枚自绘 svg（图标是 data-tt-icon / data-tt-mark 标记的）
  const glyphs = (markup.match(/data-tt-(?:icon|mark)=/gu) ?? []).length;
  assert.equal(glyphs, 6, `应有 6 枚自绘字形（主区 + 五个按钮），实际 ${glyphs}\n${markup}`);
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
  assert.equal(markup.includes('aria-label="转正…"'), false, '窄栏不该多出爱心按钮（与其它四个同进退）');
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
  // 用户只需要知道：有几个任务、住在哪、会话在哪儿、设置去哪改。
  assert.ok(help.includes('任务数量'), help);
  assert.ok(help.includes('任务根目录'), help);
  assert.ok(help.includes('更多设置'), help);
  // 反面：这些是实现细节/开发期信息，不该出现在面向用户的气泡里（用户实测反馈"过程性的东西太多"）。
  for (const noise of ['记录文件', '配置来源', 'dsh-side-session', '插件后端', '插件界面']) {
    assert.equal(help.includes(noise), false, `说明气泡不该出现「${noise}」`);
  }
  // 版本只在**两半不一致**时才出现（`halvesDiffer` 有独立的单测；这里只钉"不该常驻"）。
  assert.equal(
    (help.match(/<button/gu) ?? []).length,
    0,
    '详情气泡不该再有任何按钮——它是悬浮详情，靠"鼠标移开自动收起"',
  );
  assert.ok(help.includes('left:12px') || help.includes('left: 12px'), '应贴在锚点位置');

  tray.set({ panel: 'notice', anchor: null, message: '创建失败：宿主未提供 workspaceRegistry' });
  const notice = render(layer, { runtime, tray });
  assert.ok(notice.includes('创建失败：宿主未提供 workspaceRegistry'), notice);
  assert.ok(notice.includes('left:12px'), '提示气泡也要有定位（没有锚点时用兜底坐标）');

  tray.set({ panel: 'clean', anchor: null });
  const clean = render(layer, { runtime, tray });
  assert.ok(clean.includes('清理临时任务'), clean);
  assert.ok(clean.includes('确认清理'), clean);
  // 两个模态共用同一个外壳（`ModalShell`）：转正是"点周围不关闭 + Esc + 底部按钮"，
  // 清理框必须一致——同一插件里两个居中模态行为不同本身就是缺陷（用户实测反馈过两次）。
  assert.ok(clean.includes('__tt_overlay') && clean.includes('__tt_dialog'), clean);
  assert.ok(clean.includes('aria-modal="true"'), clean);
  assert.ok(clean.includes('data-tt-dialog="clean"'), '标记出它走的也是共用外壳');
  assert.ok(clean.includes('__tt_dialogActions'), '按钮区在模态底部（右对齐那一行）');
  assert.ok(clean.includes('data-tt-dialog-close="true"'), '右上角要有 X（与转正一致）');
  // 顺序约定：取消在左、主操作在最右（两个模态必须一样）
  assert.deepEqual(
    footerLabelsOf(clean),
    ['取消', '确认清理（0）'],
    `清理框底部顺序不对：${JSON.stringify(footerLabelsOf(clean))}`,
  );
  assert.equal(
    CANCEL_LABELS.has(footerLabelsOf(clean).at(-1)),
    false,
    '最后一个按钮必须是主操作，不是取消',
  );

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

check('客户端半边报的版本与 package.json 一致（构建期注入，不再手写常量）', () => {
  // 1) 直接对账：产物里被注入的版本必须等于 package.json 的 version。
  //    失败通常意味着 client/client.js 是旧版本构建出来的产物（跑 npm run build:client）。
  assert.equal(
    internals.CLIENT_VERSION,
    packageJson.version,
    'client/client.js 里的 CLIENT_VERSION 与 package.json 不一致：产物过期了',
  );

  // 2) 行为对账：把 package.json 的版本当作 host 版本传进设置卡片，页脚不该出现告警；
  //    版本不同时必须告警——否则上面那条断言就只是"常量抄对了"，测不出显示逻辑。
  const panel = internals.TaskSettingsPanel;
  const renderWith = (pluginVersion) =>
    render(panel, {
      runtime,
      policy: 'archive',
      pluginVersion,
      scope: scopeStub,
      onSaved: () => {},
      onClose: () => {},
    });

  const same = renderWith(packageJson.version);
  assert.ok(same.includes(`v${packageJson.version}`), '页脚应显示 package.json 里的版本');
  assert.equal(same.includes('⚠️'), false, '两半同版本时页脚不该挂告警');

  const stale = renderWith('0.0.0-stale');
  assert.ok(stale.includes('⚠️'), '反向对照失败：版本不同时页脚必须挂告警');
});

check('设置卡片渲染根目录 / 自动清理 / 保存（不再有"与 dsh-side-session 的区别"这种对比文）', () => {
  const markup = render(entryOf('settings.section').component, {});
  assert.ok(markup.includes('任务根目录'), markup);
  assert.ok(markup.includes('自动清理天数'), markup);
  assert.equal(
    markup.includes('dsh-side-session'),
    false,
    '插件之间的比较属于 README，不该占据设置界面（用户实测反馈）',
  );
  assert.ok(markup.includes('保存'), markup);
});

check('配置通道缺失时也注册 7 个插槽：设置卡片与转正入口改走插件自己的 HTTP 接口', () => {
  const bare = createClientStub({
    withSettings: false,
    withConfigForms: false,
    withUiWorkspace: false,
  });
  plugin.apply(bare.ctx);
  assert.deepEqual(
    bare.registrations.map((item) => item.options.name),
    [
      'sidebar.panellist',
      'main',
      'shell.overlay',
      'shell.overlay',
      'sidebar.workspaces.session.menu.item',
      'sidebar.workspaces.session.row.action',
      'settings.section',
    ],
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

/* ── 4. 转正（promote）：面板 / 官方会话行槽位 / 目录选择器 ── */

/**
 * 一份最小的 /state 快照。转正面板与「这条会话属于哪个任务」的反查都只需要 tasks + home，
 * 其余字段照抄真实返回体的形状（缺字段会让组件在别处踩空，那属于另一个层面的回归）。
 */
function stateWith(tasks, home = 'C:\\Users\\me') {
  return {
    ok: true,
    pluginVersion: packageJson.version,
    rootDir: 'C:\\Users\\me\\.dsh\\dsh-temptask',
    dataFile: 'C:\\Users\\me\\.dsh\\plugin-data\\dsh-temptask\\tasks.json',
    configSource: 'plugin-config',
    config: { rootDir: '', autoCleanDays: 0, dataDir: '', onDeleteSessions: 'archive' },
    tasks,
    warnings: [],
    capabilities: {
      sessionController: true,
      agents: true,
      settings: true,
      webServer: true,
      commands: true,
      workspaceRegistry: true,
      canOpenPath: true,
    },
    sideSessionDetected: false,
    now: 1_700_000_000_000,
    home,
  };
}

const promoteTasks = [
  {
    id: 'a',
    dirName: '2026-10-13-10-00-00',
    path: 'C:\\Users\\me\\.dsh\\dsh-temptask\\2026-10-13-10-00-00',
    createdAt: 1,
    status: 'closed',
    workspacePresent: true,
    sessionIds: ['s-old'],
  },
  {
    id: 'b',
    dirName: '2026-10-13-10-05-00',
    path: 'C:\\Users\\me\\.dsh\\dsh-temptask\\2026-10-13-10-05-00',
    createdAt: 2,
    status: 'active',
    live: true,
    title: '修复登录 bug',
    workspacePresent: true,
    sessionIds: ['s-live-1', 's-live-2'],
  },
];

const promoteForm = (extra = {}) =>
  render(internals.PromotePanel, {
    runtime,
    tasks: promoteTasks,
    home: 'D:\\code',
    onClose: () => {},
    ...extra,
  });

/** 会话行两个槽位共用一个托盘（组件只往里写，断言读它）。 */
const sessionTray = internals.createTray();

/** 某个输入框的默认值（不依赖 SSR 的属性顺序：spellcheck 会插在中间）。 */
function inputValueOf(markup, marker) {
  const match = new RegExp(`${marker}="true"[^>]*value="([^"]*)"`, 'u').exec(markup);
  return match === null ? undefined : match[1];
}

/**
 * 单选里当前被选中的任务 id。
 *
 * 选项行**不是** `<button>`（用 div + role="option"：面板的祖先随时可能是交互元素，
 * 「按钮里嵌按钮」在真实浏览器里会把内容挪走/塌掉），所以这里匹配任意标签。
 */
function selectedTaskIdOf(markup) {
  for (const tag of markup.match(/<[a-z]+[^>]*>/gu) ?? []) {
    if (!tag.includes('aria-selected="true"')) continue;
    const id = /data-tt-promote-task="([^"]+)"/u.exec(tag);
    if (id !== null) return id[1];
  }
  return undefined;
}

check('转正面板：渲染任务单选、默认目录名/父目录，两个选项默认都勾上', () => {
  const markup = promoteForm();
  assert.ok(markup.includes('data-tt-promote-state="form"'), markup);
  assert.ok(markup.includes('要转正的任务'), markup);
  for (const id of ['a', 'b']) {
    assert.ok(markup.includes(`data-tt-promote-task="${id}"`), `缺少任务 ${id}\n${markup}`);
  }
  // 没有预选（侧边栏爱心按钮那条路）时默认挑第一个 active 的 = b
  assert.equal(selectedTaskIdOf(markup), 'b', '默认应预选第一个 active 的任务');
  assert.equal((markup.match(/__tt_optionOn/gu) ?? []).length, 1, '同一时刻只能选中一条任务');
  // 目录名默认 = 节点标题（b 有 title）；父目录默认 = 宿主用户目录
  assert.equal(inputValueOf(markup, 'data-tt-promote-name'), '修复登录 bug');
  assert.equal(inputValueOf(markup, 'data-tt-promote-parent'), 'D:\\code');
  assert.equal(
    (markup.match(/checked=""/gu) ?? []).length,
    2,
    '「把对话带过去」与「完成后打开新会话」默认都要勾上',
  );
  assert.ok(markup.includes('把对话带过去'), markup);
  assert.ok(markup.includes('旧会话按现有策略归档'), '带历史的文案要如实说明旧会话怎么处理');
});

check('转正面板：托盘带过来的 taskId 优先预选（会话行快捷项走这条路）', () => {
  const markup = promoteForm({ initialTaskId: 'a' });
  assert.equal(selectedTaskIdOf(markup), 'a', '带 taskId 时应预选它');
  assert.equal(
    inputValueOf(markup, 'data-tt-promote-name'),
    '2026-10-13-10-00-00',
    '没有标题时目录名回落到时间戳目录名',
  );

  // 无效的 taskId（例如会话行拿到的是已被清理的任务）不该把面板选空
  const stale = promoteForm({ initialTaskId: 'gone' });
  assert.equal(selectedTaskIdOf(stale), 'b', '无效的预选要退回默认选择');
  assert.equal(inputValueOf(stale, 'data-tt-promote-name'), '修复登录 bug');
});

check('转正面板：目标父目录优先取 localStorage 里的上次落点，并会在成功后写回', () => {
  const store = new Map([['__tt_promoteDir', 'E:\\projects']]);
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
  try {
    const markup = promoteForm();
    assert.equal(
      inputValueOf(markup, 'data-tt-promote-parent'),
      'E:\\projects',
      'localStorage 有记录时应优先于宿主用户目录',
    );
    internals.writeStoredPromoteDir('F:\\next');
    assert.equal(store.get(internals.PROMOTE_DIR_KEY), 'F:\\next', '成功后的落点要写回同一个 key');
  } finally {
    delete globalThis.localStorage;
  }
  // 记不住（隐私模式 / 无 localStorage）时退回宿主用户目录，不能抛也不能空
  assert.equal(inputValueOf(promoteForm(), 'data-tt-promote-parent'), 'D:\\code');
});

check('转正面板：父目录为空时给占位提示，两半版本不一致时明说「重启 DSH」', () => {
  // 旧 host（没重启）不会给 /state 的 home 字段 → 输入框会是空的。
  // 空输入框配一句占位提示 + 一句"后端是旧的"，比让人以为是坏控件强。
  const noHome = promoteForm({ home: undefined });
  assert.equal(inputValueOf(noHome, 'data-tt-promote-parent'), '');
  assert.ok(noHome.includes('placeholder="例如 D:\\code'), `空值要有占位提示\n${noHome}`);

  const stale = promoteForm({ staleHost: true });
  assert.ok(stale.includes('插件后端还是旧版本'), '两半版本不一致要在面板里说清楚');
  assert.ok(stale.includes('重启 DSH'), stale);

  // 版本一致时不出现这条告警（不能变成常驻噪音）
  assert.equal(promoteForm().includes('插件后端还是旧版本'), false);
});

check('两个模态的底部按钮顺序一致（取消在左、主操作在最右），右上角都有自绘 X', () => {
  const form = promoteForm();
  assert.deepEqual(
    footerLabelsOf(form),
    ['关闭', '转正'],
    `转正表单底部顺序不对：${JSON.stringify(footerLabelsOf(form))}`,
  );
  assert.equal(
    CANCEL_LABELS.has(footerLabelsOf(form).at(-1)),
    false,
    '最后一个按钮必须是主操作，不是取消',
  );
  assert.ok(form.includes('data-tt-dialog-close="true"'), '右上角要有 X');
  assert.ok(form.includes('data-tt-icon="close"'), 'X 也要是自绘字形（不依赖宿主图标包）');
});

check('行的层级：第一行工作区名、第二行内容（标题→摘要），第三行只补必要信息', () => {
  const withTitle = { ...promoteTasks[0], sessionTitle: '修复 500 错误', preview: '帮我修一下登录页' };
  assert.equal(internals.chatLineOf(withTitle), '修复 500 错误', '第二行优先用会话标题');
  assert.equal(internals.chatLineOf({ ...promoteTasks[0], preview: '只有摘要' }), '只有摘要');
  assert.equal(
    internals.chatLineOf(promoteTasks[0]),
    undefined,
    '两样都没有时第二行不渲染（第一行的目录名已经够认）',
  );

  assert.equal(
    internals.metaLineOf(promoteTasks[0], '条会话'),
    undefined,
    '未改名 + 单条会话 → 不渲染第三行',
  );
  assert.equal(
    internals.metaLineOf({ ...promoteTasks[0], title: '我的项目' }, '条会话'),
    promoteTasks[0].dirName,
    '节点被改过名时要补回目录名',
  );
  assert.equal(internals.metaLineOf({ ...promoteTasks[0], sessionCount: 3 }, '条会话'), '3 条会话');
  assert.equal(
    internals.metaLineOf({ ...promoteTasks[0], title: '我的项目', sessionCount: 2 }, '条会话'),
    `${promoteTasks[0].dirName} · 2 条会话`,
  );
  assert.ok(
    internals.tooltipOf(withTitle).includes('帮我修一下登录页'),
    '列表里放不下的摘要要进 tooltip',
  );

  assert.equal(
    internals.defaultPromoteName(withTitle),
    '修复-500-错误',
    '默认目录名跟着内容走，并洗成合法目录名（不再默认给时间戳）',
  );
  assert.equal(
    internals.defaultPromoteName({ ...promoteTasks[0], preview: 'refactor the auth module' }),
    'refactor-the-auth-module',
  );
  assert.equal(internals.defaultPromoteName(promoteTasks[0]), '2026-10-13-10-00-00');
  assert.equal(internals.defaultPromoteName(undefined), '');
});

check('folderNameFromText：按 host 的 validateName 规则洗（非法字符/空白/结尾点/Windows 保留名）', () => {
  assert.equal(internals.folderNameFromText('a/b:c*?', 'fb'), 'a-b-c');
  assert.equal(internals.folderNameFromText('  hello   world  ', 'fb'), 'hello-world');
  assert.equal(internals.folderNameFromText('name. ', 'fb'), 'name');
  assert.equal(internals.folderNameFromText('con', 'fb'), '_con', '保留名要避开，否则 host 会拒绝');
  assert.equal(internals.folderNameFromText('x'.repeat(80), 'fb').length, 48, '不能生成超长目录名');
  assert.equal(internals.folderNameFromText('', 'fb'), 'fb');
  assert.equal(internals.folderNameFromText('///', 'fb'), 'fb', '洗完什么都不剩就回落');
  assert.equal(internals.folderNameFromText(undefined, 'fb'), 'fb');
});

check('visiblePromoteTasks：默认只给有节点的；一个都没有时退回全部（不能给空列表）', () => {
  const mixed = promoteTasks.map((task, index) => ({ ...task, workspacePresent: index === 1 }));
  assert.deepEqual(
    internals.visiblePromoteTasks(mixed, false).map((task) => task.id),
    ['b'],
    '默认只显示侧边栏还有节点的',
  );
  assert.deepEqual(
    internals.visiblePromoteTasks(mixed, true).map((task) => task.id),
    ['a', 'b'],
    '点了"显示全部"就给全部',
  );
  const none = promoteTasks.map((task) => ({ ...task, workspacePresent: false }));
  assert.deepEqual(
    internals.visiblePromoteTasks(none, false).map((task) => task.id),
    ['a', 'b'],
    '一个带节点的都没有时退回全部，否则模态看起来是坏的',
  );
  assert.deepEqual(internals.visiblePromoteTasks([], false), []);
});

check('转正面板：第一行是工作区名（粗体）、第二行才是内容（小字），默认隐藏只剩文件夹的', () => {
  const candidates = [
    {
      ...promoteTasks[1],
      title: '我的登录修复',
      sessionTitle: '排查 500 错误',
      preview: '偶发 500，日志里是 token 过期后没刷新',
      sessionCount: 3,
    },
    { ...promoteTasks[0], workspacePresent: false, preview: '第二个任务的真实内容' },
  ];
  const markup = promoteForm({ tasks: candidates });

  // 第一行：工作区名（`__tt_itemLabel`，粗体那一档）
  const label = /<span class="__tt_itemLabel"[^>]*>([^<]*)</u.exec(markup);
  assert.equal(label?.[1], '我的登录修复', `第一行必须是工作区名\n${markup}`);
  // 第二行：聊过的内容（`__tt_preview`，小一号）
  const content = /<span class="__tt_preview">([^<]*)</u.exec(markup);
  assert.equal(content?.[1], '排查 500 错误', `第二行必须是内容\n${markup}`);
  // 层级顺序：工作区名在内容之前
  assert.ok(
    markup.indexOf('我的登录修复') < markup.indexOf('排查 500 错误'),
    '工作区名要排在内容之前（主副不能反）',
  );
  assert.ok(markup.includes('3 条会话'), '会话条数进第三行');
  assert.ok(markup.includes('data-tt-promote-task="b"'), markup);
  assert.equal(
    markup.includes('data-tt-promote-task="a"'),
    false,
    '默认不显示只剩文件夹的那条（节点被删过的）',
  );
  assert.ok(markup.includes('data-tt-promote-filter="true"'), '要有过滤开关');
  assert.ok(markup.includes('显示全部（1）'), `开关上要带被隐藏的数量\n${markup}`);
});

check('转正面板：全都只剩文件夹时列出全部，并说明"删工作区不删文件夹"是 DSH 的语义', () => {
  const detached = promoteTasks.map((task) => ({ ...task, workspacePresent: false }));
  const markup = promoteForm({ tasks: detached });
  assert.ok(markup.includes('data-tt-promote-task="a"') && markup.includes('data-tt-promote-task="b"'));
  assert.ok(markup.includes('无节点'), '每行要标出"无节点"');
  assert.ok(markup.includes('删工作区不会删文件夹'), markup);
});

check('「浏览…」只在官方目录选择器可用时出现，拿不到就隐藏（只允许手输）', () => {
  const withPicker = promoteForm({
    directoryPicker: { available: () => true, pick: async () => null },
  });
  assert.ok(withPicker.includes('data-tt-promote-browse="true"'), withPicker);
  assert.ok(withPicker.includes('浏览…'), withPicker);

  const withoutPicker = promoteForm();
  assert.equal(
    withoutPicker.includes('data-tt-promote-browse="true"'),
    false,
    '拿不到选择器时必须隐藏按钮，而不是渲染一个点了会报错的按钮',
  );

  // 服务是挂载期才注册的：句柄在但此刻报"不可用" → 同样隐藏（打开面板时才会再探一次）
  const notYet = promoteForm({
    directoryPicker: { available: () => false, pick: async () => null },
  });
  assert.equal(notYet.includes('data-tt-promote-browse="true"'), false, notYet);
});

check('转正面板：没有任务时给空态，不渲染空表单', () => {
  const markup = render(internals.PromotePanel, {
    runtime,
    tasks: [],
    home: 'D:\\code',
    onClose: () => {},
  });
  assert.ok(markup.includes('data-tt-promote-state="empty"'), markup);
  assert.ok(markup.includes('暂无临时任务可转正'), markup);
  assert.equal(markup.includes('data-tt-promote-name'), false, '空态下不该有输入框');
});

await checkAsync('转正提交：POST /dsh-temptask/api/promote，字段齐全且固定带 confirm: true', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      json: async () => ({
        ok: true,
        task: promoteTasks[1],
        from: promoteTasks[1].path,
        to: 'D:\\code\\my-project',
        workspaceId: 'ws-1',
        sessionId: 's-new',
        historyCarried: true,
        sessionsArchived: 1,
        sessionsCanceled: 0,
        moved: 'rename',
      }),
    };
  };

  // 1) 纯函数：请求体就是这三项决策 + id + confirm
  assert.deepEqual(
    internals.buildPromoteBody({
      taskId: 'b',
      name: 'my-project',
      parentDir: 'D:\\code',
      carry: true,
      open: false,
    }),
    { id: 'b', name: 'my-project', parentDir: 'D:\\code', carry: true, open: false, confirm: true },
    'confirm 必须是 true（面板里已经确认过，host 缺它会回 CONFIRM_REQUIRED）',
  );

  // 2) 真发一次请求，核对 URL / 方法 / 请求体
  const result = await internals.promoteTask({
    taskId: 'b',
    name: 'my-project',
    parentDir: 'D:\\code',
    carry: true,
    open: false,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/dsh-temptask/api/promote');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    id: 'b',
    name: 'my-project',
    parentDir: 'D:\\code',
    carry: true,
    open: false,
    confirm: true,
  });

  // 3) 失败响应原样带着 message + hint 回来（面板据此把它们显示在表单里）
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      ok: false,
      code: 'DIR_BUSY',
      message: '目标目录正被占用',
      hint: '关掉占用它的终端/会话再试一次',
    }),
  });
  const failure = await internals.promoteTask({
    taskId: 'b',
    name: 'my-project',
    parentDir: 'D:\\code',
    carry: true,
    open: true,
  });
  assert.deepEqual(failure, {
    ok: false,
    code: 'DIR_BUSY',
    message: '目标目录正被占用',
    hint: '关掉占用它的终端/会话再试一次',
  });
});

check('转正失败：message 与 hint 一起显示在表单里（不能只飘一句 toast）', () => {
  const markup = render(internals.PromoteErrorNote, {
    error: {
      code: 'TARGET_EXISTS',
      message: '目标目录已存在',
      hint: '换个目录名，或先把占位的目录/文件挪走',
    },
    label: '转正失败',
  });
  assert.ok(markup.includes('data-tt-promote-error="TARGET_EXISTS"'), markup);
  assert.ok(markup.includes('转正失败：目标目录已存在'), markup);
  assert.ok(markup.includes('换个目录名'), 'hint（下一步怎么办）必须一起显示出来');
  assert.ok(markup.includes('TARGET_EXISTS'), '错误码也要看得见，便于排查是 host 哪一类拒绝');
});

check('会话归属反查用 sessionIds（任务名下的旧会话同样算，不只看最后一条）', () => {
  const state = stateWith(promoteTasks);
  assert.equal(internals.findTaskBySession(state, 's-old')?.id, 'a');
  assert.equal(internals.findTaskBySession(state, 's-live-2')?.id, 'b');
  assert.equal(internals.findTaskBySession(state, 's-unknown'), undefined, '不是任务名下的会话 → 反查为空');
  assert.equal(internals.findTaskBySession(null, 's-old'), undefined, '快照还没到时不做任何断言');
  assert.equal(internals.findTaskBySession(state, ''), undefined);

  // 回归：host 半边是旧版（还没重启）时 sessionIds 会缺席。这一路跑在官方会话行的渲染里，
  // 必须只是"认不出来"，绝不能抛——抛了会把整个侧边栏拖下水。
  const staleHost = stateWith([{ ...promoteTasks[0], sessionIds: undefined }]);
  assert.equal(internals.findTaskBySession(staleHost, 's-old'), undefined);
});

check('会话行菜单项：非任务会话渲染 null，任务会话渲染出「转正…」', () => {
  const cache = internals.createStateCache();
  cache.set(stateWith(promoteTasks));

  const miss = render(internals.PromoteSessionMenuItem, {
    sessionId: 's-unknown',
    runtime,
    tray: sessionTray,
    cache,
  });
  assert.equal(miss, '', '普通工作区 / 未分组的会话不该看到这个动作');

  const hit = render(internals.PromoteSessionMenuItem, {
    sessionId: 's-live-2',
    runtime,
    tray: sessionTray,
    cache,
  });
  assert.ok(hit.includes('data-tt-promote-session="b"'), hit);
  assert.ok(hit.includes('role="menuitem"'), '菜单项要是 role=menuitem 的按钮（官方键盘走查读 DOM）');
  assert.ok(hit.includes('转正…'), hit);
  assert.ok(hit.includes('data-tt-icon="heart"'), '入口用自绘爱心');

  // 快照还没到位（面板刚挂载、第一次轮询未回）也只能渲染 null，不能抛
  const empty = render(internals.PromoteSessionMenuItem, {
    sessionId: 's-live-2',
    runtime,
    tray: sessionTray,
    cache: internals.createStateCache(),
  });
  assert.equal(empty, '');
});

check('会话行悬停按钮：同样只对任务会话出现', () => {
  const cache = internals.createStateCache();
  cache.set(stateWith(promoteTasks));
  assert.equal(
    render(internals.PromoteSessionRowAction, {
      sessionId: 's-unknown',
      runtime,
      tray: sessionTray,
      cache,
    }),
    '',
  );
  const hit = render(internals.PromoteSessionRowAction, {
    sessionId: 's-old',
    runtime,
    tray: sessionTray,
    cache,
  });
  assert.ok(hit.includes('data-tt-promote-session-row="a"'), hit);
  assert.ok(hit.includes('aria-label="转正…"'), hit);
});

check('会话行入口点一下：打开 promote 面板并预选这条会话所属的任务', () => {
  const localTray = internals.createTray();
  internals.openPromoteForTask({ tray: localTray }, 'b', null);
  assert.equal(localTray.get().panel, 'promote');
  assert.equal(localTray.get().promoteTaskId, 'b');
  assert.deepEqual(localTray.get().anchor, { left: 12, top: 120 }, '拿不到矩形时用兜底坐标，不能抛');

  // 有真实元素时锚点贴在它下方（气泡不能跑到视口左上角）
  globalThis.HTMLElement = class HTMLElementStub {
    getBoundingClientRect() {
      return { left: 100, top: 200, right: 120, bottom: 220 };
    }
  };
  try {
    const anchor = internals.anchorOfTarget(new globalThis.HTMLElement());
    assert.deepEqual(anchor, {
      left: 94,
      top: 228,
      source: { left: 100, top: 200, right: 120, bottom: 220 },
    });
  } finally {
    delete globalThis.HTMLElement;
  }
});

check('两个官方会话行槽位按包命名空间注册，位置不与官方条目撞车', () => {
  const menu = registrations.find(
    (item) => item.options.name === 'sidebar.workspaces.session.menu.item',
  );
  assert.ok(menu !== undefined, '未注册 sidebar.workspaces.session.menu.item');
  assert.equal(
    menu.options.id,
    'dsh-temptask-promote',
    'id 必须带包命名空间：复用官方 id 会遮蔽官方那一条（pin 100 / rename 200 / fork 300 / archive 400）',
  );
  assert.ok(
    menu.options.order > 400,
    `菜单项要排在官方 archive(400) 之后，形成插件动作那一组（当前 ${menu.options.order}）`,
  );

  const rowButton = registrations.find(
    (item) => item.options.name === 'sidebar.workspaces.session.row.action',
  );
  assert.ok(rowButton !== undefined, '未注册 sidebar.workspaces.session.row.action');
  assert.equal(rowButton.options.id, 'dsh-temptask-promote');
  assert.equal(typeof rowButton.options.label, 'function', 'label 用 thunk，切语言后跟着变');
});

await checkAsync(
  '目录选择器：remote 三种返回形态 + Windows 桌面原生桥都接住，缺失时 available() 为假',
  async () => {
    const ctxOf = (services) => ({ get: (name) => services[name] });
    const envelope = internals.createDirectoryPicker(
      ctxOf({ 'remote.directoryPicker': { pick: async () => ({ ok: true, value: 'D:\\picked' }) } }),
    );
    assert.equal(envelope.available(), true, '命名空间存在时按钮才该出现');
    assert.equal(await envelope.pick(), 'D:\\picked');

    const viaRemote = internals.createDirectoryPicker(
      ctxOf({ remote: { directoryPicker: { pick: async () => null } } }),
    );
    assert.equal(await viaRemote.pick(), null, '用户取消（null）当成功处理，只是不改输入框');

    const thin = internals.createDirectoryPicker(
      ctxOf({ remote: { directoryPicker: { pick: async () => 'E:\\thin' } } }),
    );
    assert.equal(await thin.pick(), 'E:\\thin', '薄实现直接给路径也要接');

    const failed = internals.createDirectoryPicker(
      ctxOf({
        'remote.directoryPicker': {
          pick: async () => ({
            ok: false,
            error: { code: 'directory-picker/unavailable', message: 'needs the native capability' },
          }),
        },
      }),
    );
    await assert.rejects(
      () => failed.pick(),
      /native capability/,
      '能力不匹配要抛错，由面板显示在表单里',
    );

    const missing = internals.createDirectoryPicker(ctxOf({}));
    assert.equal(missing.available(), false, '宿主没挂选择器 → 「浏览…」隐藏');
    await assert.rejects(() => missing.pick(), /未提供目录选择器/);

    // apply 那一刻服务还没挂上：只要面板打开时它已经在了，available() 就该翻成 true
    const late = {};
    const lazy = internals.createDirectoryPicker({ get: (name) => late[name] });
    assert.equal(lazy.available(), false);
    late['remote.directoryPicker'] = { pick: async () => 'D:\\late' };
    assert.equal(lazy.available(), true, '句柄必须每次现取命名空间，不能把"没有"固化下来');
    assert.equal(await lazy.pick(), 'D:\\late');

    // Windows 桌面：组合出来的是 browse 后端（pick 要求 native，会被 host 拒绝），
    // 桌面为此发布了同源全局 __DSH_DESKTOP_PICK_DIRECTORY__ —— 必须优先走它。
    globalThis.__DSH_DESKTOP_PICK_DIRECTORY__ = async () => 'C:\\Users\\me\\picked-by-desktop';
    try {
      const desktop = internals.createDirectoryPicker(
        ctxOf({
          'remote.directoryPicker': {
            pick: async () => ({ ok: false, error: { message: 'needs the native capability' } }),
          },
        }),
      );
      assert.equal(desktop.available(), true);
      assert.equal(await desktop.pick(), 'C:\\Users\\me\\picked-by-desktop');

      globalThis.__DSH_DESKTOP_PICK_DIRECTORY__ = async () => null;
      assert.equal(await desktop.pick(), null, '桌面选择器取消 = null');

      // 只有桌面桥、没有任何 remote 命名空间时也要算"可用"
      const desktopOnly = internals.createDirectoryPicker(ctxOf({}));
      assert.equal(desktopOnly.available(), true);
    } finally {
      delete globalThis.__DSH_DESKTOP_PICK_DIRECTORY__;
    }
  },
);

await checkAsync(
  '目录选择器：0.2.1-rc.2 把桌面桥改名为 __DSH_DIRECTORY_PICKER__（全平台、{ pick } 形态），旧名仍兜底',
  async () => {
    const ctxOf = (services) => ({ get: (name) => services[name] });
    const refuses = ctxOf({
      'remote.directoryPicker': {
        pick: async () => ({ ok: false, error: { message: 'needs the native capability' } }),
      },
    });

    // 0.2.1 起 preload 无条件 expose 的是对象 `{ pick }`（不是裸函数）
    globalThis.__DSH_DIRECTORY_PICKER__ = { pick: async () => 'C:\\Users\\me\\picked-by-021' };
    try {
      const picker = internals.createDirectoryPicker(refuses);
      assert.equal(picker.available(), true);
      assert.equal(await picker.pick(), 'C:\\Users\\me\\picked-by-021', '新桥要优先于 remote');

      // 两个名字同时存在时（跨版本共存/自定义宿主）：新名优先
      globalThis.__DSH_DESKTOP_PICK_DIRECTORY__ = async () => 'C:\\legacy';
      assert.equal(await picker.pick(), 'C:\\Users\\me\\picked-by-021', '新名必须赢过旧名');
      delete globalThis.__DSH_DESKTOP_PICK_DIRECTORY__;

      // 裸函数形态也接住（防御：宿主换个 expose 方式不该让按钮失效）
      globalThis.__DSH_DIRECTORY_PICKER__ = async () => 'C:\\bare-fn';
      assert.equal(await picker.pick(), 'C:\\bare-fn');

      // 对象里没有 pick（宿主改了结构）→ 不能被当成桥：应退回 remote（这个 ctx 的 remote 会被拒）
      globalThis.__DSH_DIRECTORY_PICKER__ = { somethingElse: true };
      await assert.rejects(
        () => picker.pick(),
        /native capability/,
        '结构不对的全局不算桥，必须退回 remote 而不是拿它当选择器',
      );

      // 用户取消
      globalThis.__DSH_DIRECTORY_PICKER__ = { pick: async () => null };
      assert.equal(await picker.pick(), null);
    } finally {
      delete globalThis.__DSH_DIRECTORY_PICKER__;
      delete globalThis.__DSH_DESKTOP_PICK_DIRECTORY__;
    }
  },
);

check('浮层：面板切到 promote 时渲染**居中模态**（爱心按钮点开的就是它）', () => {
  const localTray = internals.createTray();
  const layer = overlayOf('dsh-temptask-tray').component;
  // 锚点参数仍然传进来（会话行入口会带），但转正现在是居中模态，应当**忽略**它。
  localTray.set({ panel: 'promote', anchor: { left: 180, top: 140 } });
  const markup = render(layer, { runtime, tray: localTray });
  assert.ok(markup.includes('__tt_overlay'), markup);
  assert.ok(markup.includes('__tt_dialog'), '转正应与「清理任务」同一套居中模态，而不是贴边浮层');
  assert.ok(markup.includes('aria-modal="true"'), markup);
  assert.ok(markup.includes('__tt_dialogActions'), '按钮区应落在模态底部（右对齐那一行）');
  assert.equal(markup.includes('left:180px'), false, '居中模态不该再吃锚点坐标');
  assert.ok(markup.includes('转正为正式工作区'), markup);
  assert.ok(markup.includes('data-tt-promote-state="empty"'), 'SSR 里拿不到 /state → 空态，不能空白或报错');
});

check('ZH / EN 两个词典 key 完全对齐（漏一条就是半截中文半截英文）', () => {
  assert.deepEqual(Object.keys(internals.EN).sort(), Object.keys(internals.ZH).sort());
  for (const key of Object.keys(internals.ZH)) {
    assert.ok(internals.ZH[key].length > 0, `ZH.${key} 是空的`);
    assert.ok(internals.EN[key].length > 0, `EN.${key} 是空的`);
  }
  assert.equal(internals.ZH.promote, '转正…');
  assert.equal(internals.EN.promote, 'Promote…');
});

console.log(`\n✅ client 全部 ${passed} 项通过`);
