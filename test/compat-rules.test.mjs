/**
 * compat-probe 的判定规则。
 *
 * 这个检查的价值全在判断上：说「没变」时不能是假阴性，说「变了」时不能是假阳性。
 * 这里按「前提 → 结论」直接测纯函数，不需要装 DSH；真实宿主上的结果由
 * `npm run compat` 自己验证。
 *
 * 版本范围的用例取值来自宿主 dsh-app-boot 的 evaluatePluginCompatibility：
 * 它调用 semver 时传 includePrerelease: true，这一点决定了预发布版本的结论。
 */
import assert from 'node:assert/strict'
import {
  EXIT,
  VERDICT,
  decide,
  diffSurface,
  evaluateRange,
  exitCodeFor,
  observeServices,
  observeSlots,
} from '../scripts/lib/compat-rules.mjs'

/**
 * 这个仓库没有依赖，测试也不能依赖 semver。这里放一个只覆盖本文件用到的范围形式的
 * 判定器，支持精确版本与 caret，按 includePrerelease 解释。
 *
 * 它必须与宿主的语义一致：宿主调用 semver 时传 includePrerelease: true，
 * 因此 ^0.2.1-0 同时覆盖 0.2.1-rc.2 与 0.2.2-rc.1。下面有断言专门盯这一点，
 * 也盯着「调用方必须传这个选项」，防止有人把它改回默认语义。
 */
function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
  assert.ok(match !== null, `测试里的版本号必须是 semver：${version}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** 比较两个已解析版本；预发布小于同号正式版。 */
function compare(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  // includePrerelease 下，预发布标识只影响排序，不影响是否落在范围内；
  // 这里只需要「大小」用于下界比较。
  return 0
}

/** 单个范围段：精确版本或 caret。 */
function satisfiesPart(version, part) {
  const target = parse(version)

  if (part.startsWith('^')) {
    const base = parse(part.slice(1))
    if (target.major !== base.major) return false
    // 0.x 的 caret 锁次版本；1.x 及以上锁主版本。
    if (base.major === 0) return target.minor === base.minor
    return true
  }

  // 精确版本：语义是「不小于该版本且同主次版本」在 includePrerelease 下的宽松比较，
  // 对本文件用到的 0.2.0-rc.2 这类写法，等价于不满足（宿主版本更高）。
  return compare(target, parse(part)) === 0
}

function matches(version, range) {
  return range
    .split('||')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .some((part) => satisfiesPart(version, part))
}

/**
 * 传给被测算法的替身：它断言调用方确实传了 includePrerelease，因为宿主就是那么调的。
 * 如果有人从判定逻辑里去掉这个选项，这里的断言会立刻失败，而不是悄悄改变结论。
 */
const semver = {
  satisfies(version, range, options = {}) {
    assert.equal(options.includePrerelease, true, '调用方必须与宿主一样传 includePrerelease: true')
    return matches(version, range)
  },
}

/**
 * 不带选项的调用，用来演示默认语义与 includePrerelease 的差别。
 *
 * 默认语义下，范围的最小版本是预发布时，只匹配「同一 major.minor.patch」的预发布：
 * ^0.2.1-0 覆盖 0.2.1-rc.2，但不覆盖 0.2.2-rc.1。宿主传了 includePrerelease，
 * 所以它能覆盖后者——这正是本插件 0.5.2 把范围写成 ^0.2.1-0 的原因。
 */
const strictSemver = {
  satisfies(version, range) {
    const target = parse(version)
    for (const part of range.split('||').map((item) => item.trim())) {
      const base = parse(part.replace(/^\^/, ''))
      if (target.prerelease.length > 0 && base.prerelease.length > 0) {
        if (target.major !== base.major || target.minor !== base.minor || target.patch !== base.patch) continue
      }
      if (matches(version, part)) return true
    }
    return false
  },
}

let passed = 0
function check(label, fn) {
  fn()
  passed += 1
  console.log(`  ok ${label}`)
}

/* ── 版本范围：与宿主同规则 ── */

check('engines.dsh 存在时只看它，忽略 peer', () => {
  const manifest = {
    engines: { dsh: '^0.2.2-0' },
    peerDependencies: { '@deepseek-ai/dsh': '0.0.1' },
  }
  const result = evaluateRange(manifest, '0.2.2-rc.1', semver)
  assert.equal(result.source, 'engines.dsh')
  assert.equal(result.ok, true, 'peer 写得再窄也不该参与判定')
})

check('engines.dsh 不满足 → ok 为 false 并给出 unmet', () => {
  const result = evaluateRange({ engines: { dsh: '^0.3.0' } }, '0.2.2-rc.1', semver)
  assert.equal(result.ok, false)
  assert.equal(result.unmet['engines.dsh'], '^0.3.0')
})

check('没有 engines.dsh 时逐条校验 @deepseek-ai/dsh* 的 peer', () => {
  const manifest = {
    peerDependencies: {
      '@deepseek-ai/dsh': '^0.2.1-0 || ^0.2.2-0',
      '@deepseek-ai/dsh-workspace': '0.2.0-rc.2',
      'some-other-package': '^1.0.0',
    },
  }
  const result = evaluateRange(manifest, '0.2.2-rc.1', semver)
  assert.equal(result.source, 'peerDependencies')
  assert.equal(result.ok, false)
  assert.deepEqual(Object.keys(result.unmet), ['@deepseek-ai/dsh-workspace'])
  assert.equal(
    Object.hasOwn(result.unmet, 'some-other-package'),
    false,
    '非 @deepseek-ai/dsh* 的 peer 不参与兼容性判定',
  )
})

check('预发布宿主落在 ^0.2.1-0 内，与宿主的 includePrerelease 语义一致', () => {
  assert.equal(evaluateRange({ engines: { dsh: '^0.2.1-0' } }, '0.2.2-rc.1', semver).ok, true)
  assert.equal(
    evaluateRange({ engines: { dsh: '^0.2.1-rc.3' } }, '0.2.2-rc.1', semver).ok,
    true,
    '^0.2.1-rc.3 在 includePrerelease 下覆盖同主次版本的后续预发布',
  )
})

check('去掉 includePrerelease 就会误判 —— 这条说明为什么必须复刻宿主的调用方式', () => {
  assert.equal(strictSemver.satisfies('0.2.2-rc.1', '^0.2.1-0'), false, '默认语义会把 0.2.2-rc.1 判为不兼容')
})

check('下一个大版本即使在范围内也应当被拦住', () => {
  assert.equal(evaluateRange({ engines: { dsh: '^0.2.1-0 || ^0.2.2-0' } }, '0.3.0-rc.1', semver).ok, false)
})

/* ── 服务观察：缺失与未判定要分开 ── */

const SURFACES = {
  host: {
    services: [{ name: 'workspaceRegistry', members: ['get', 'resolveByPath', 'insertBefore'] }],
  },
  client: {
    services: [{ name: 'workspaces', members: ['insertBefore'] }],
  },
}

check('服务在、方法齐 → missingMembers 为空', () => {
  const declarations = new Map([
    [
      'workspaceRegistry',
      [{ packageName: 'dsh-workspace', isClient: false, membersKnown: true, members: ['get', 'resolveByPath', 'insertBefore'] }],
    ],
  ])
  const observed = observeServices(SURFACES, declarations)
  assert.equal(observed.hostServices.workspaceRegistry.provided, true)
  assert.deepEqual(observed.hostServices.workspaceRegistry.missingMembers, [])
})

check('服务在、方法缺 → 精确列出缺的方法', () => {
  const declarations = new Map([
    [
      'workspaceRegistry',
      [{ packageName: 'dsh-workspace', isClient: false, membersKnown: true, members: ['get'] }],
    ],
  ])
  const observed = observeServices(SURFACES, declarations)
  assert.deepEqual(observed.hostServices.workspaceRegistry.missingMembers, ['resolveByPath', 'insertBefore'])
})

check('服务不在 → provided 为 false，而不是报方法缺失', () => {
  const observed = observeServices(SURFACES, new Map())
  assert.deepEqual(observed.hostServices.workspaceRegistry, { provided: false })
})

check('成员读不出来 → 标 membersUndetermined，且不谎报缺失', () => {
  const declarations = new Map([
    ['workspaceRegistry', [{ packageName: 'dsh-workspace', isClient: false, membersKnown: false, members: [] }]],
  ])
  const observed = observeServices(SURFACES, declarations)
  assert.equal(observed.hostServices.workspaceRegistry.membersUndetermined, true)
  assert.deepEqual(observed.hostServices.workspaceRegistry.missingMembers, [])
})

check('同一服务由两端各提供一份时，按插件声明的那一端比对', () => {
  const declarations = new Map([
    [
      'workspaceRegistry',
      [
        { packageName: 'host-provider', isClient: false, membersKnown: true, members: ['get'] },
        { packageName: 'client-provider', isClient: true, membersKnown: true, members: [] },
      ],
    ],
  ])
  const observed = observeServices(SURFACES, declarations)
  assert.equal(observed.hostServices.workspaceRegistry.provider, 'host-provider')
  assert.deepEqual(observed.hostServices.workspaceRegistry.missingMembers, ['resolveByPath', 'insertBefore'])
})

check('同名服务分几条写时成员取并集，后一条不覆盖前一条', () => {
  const surfaces = {
    host: {
      services: [
        { name: 'subagents', members: ['getProvider'] },
        { name: 'subagents', members: ['start'] },
      ],
    },
    client: { services: [] },
  }
  const declarations = new Map([
    ['subagents', [{ packageName: 'dsh-subagent', isClient: false, membersKnown: true, members: ['getProvider'] }]],
  ])
  const observed = observeServices(surfaces, declarations)
  assert.deepEqual(
    observed.hostServices.subagents.missingMembers,
    ['start'],
    '第二条里的 start 必须参与判定，不能被同名条目覆盖掉',
  )
})

check('implementedBy 指定的实现包，其方法算进服务', () => {
  const surfaces = {
    host: {
      services: [{ name: 'subprocess', members: ['spawnTerminal'], implementedBy: ['dsh-subprocess-local'] }],
    },
    client: { services: [] },
  }
  const declarations = new Map([
    ['subprocess', [{ packageName: 'dsh-subprocess', isClient: false, membersKnown: true, members: [] }]],
    ['@pkg:dsh-subprocess-local', [{ packageName: 'dsh-subprocess-local', isClient: false, membersKnown: true, members: ['spawnTerminal'] }]],
  ])
  const observed = observeServices(surfaces, declarations)
  assert.deepEqual(
    observed.hostServices.subprocess.missingMembers,
    [],
    '底座包声明服务名、实现包给方法时，不该把实现包的方法算成缺失',
  )
  assert.match(observed.hostServices.subprocess.provider, /dsh-subprocess-local/)
})

/* ── 插槽 ── */

check('插槽声明在 → 记录 kind 与 scope', () => {
  const observed = observeSlots(['shell.overlay'], new Map([['shell.overlay', { kind: 'list', scope: 'root' }]]))
  assert.deepEqual(observed['shell.overlay'], { declared: true, kind: 'list', scope: 'root' })
})

check('插槽没声明 → declared 为 false（写错槽位名时界面会静默消失，这里必须报）', () => {
  const observed = observeSlots(['shell.overlay'], new Map())
  assert.deepEqual(observed['shell.overlay'], { declared: false })
})

/* ── 差异与结论 ── */

const BEFORE = {
  hostServices: { workspaceRegistry: { provided: true, provider: 'dsh-workspace', missingMembers: [] } },
  clientServices: {},
  slots: { 'shell.overlay': { declared: true, kind: 'list', scope: 'root' } },
  packages: { '@deepseek-ai/dsh-workspace': { present: true, version: '0.2.2-rc.1', entry: true } },
}

check('完全一致 → 没有差异', () => {
  assert.deepEqual(diffSurface(BEFORE, structuredClone(BEFORE)), [])
})

check('方法缺失 → 差异行说明缺了哪个方法', () => {
  const after = structuredClone(BEFORE)
  after.hostServices.workspaceRegistry.missingMembers = ['insertBefore']
  const changes = diffSurface(BEFORE, after)
  assert.equal(changes.length, 1)
  assert.match(changes[0], /insertBefore/)
})

check('插槽 scope 变了 → 差异行同时给出前后值', () => {
  const after = structuredClone(BEFORE)
  after.slots['shell.overlay'].scope = 'pane'
  const changes = diffSurface(BEFORE, after)
  assert.equal(changes.length, 1)
  assert.match(changes[0], /scope=pane/)
  assert.match(changes[0], /scope=root/)
})

check('新增一个包 → 差异行标为新增', () => {
  const after = structuredClone(BEFORE)
  after.packages['@deepseek-ai/dsh-new'] = { present: true, version: '0.2.2-rc.1', entry: true }
  const changes = diffSurface(BEFORE, after)
  assert.equal(changes.length, 1)
  assert.match(changes[0], /新增/)
})

check('版本越界优先于表面变化', () => {
  const verdict = decide({
    range: { ok: false, unmet: { 'engines.dsh': '^0.3.0' } },
    baseline: BEFORE,
    changes: ['whatever'],
  })
  assert.equal(verdict, VERDICT.OUT_OF_RANGE)
})

check('没有参照记录时不说 UNCHANGED', () => {
  assert.equal(decide({ range: { ok: true, unmet: {} }, baseline: undefined, changes: [] }), VERDICT.NO_BASELINE)
})

check('范围正常、有参照、无差异 → UNCHANGED', () => {
  assert.equal(decide({ range: { ok: true, unmet: {} }, baseline: BEFORE, changes: [] }), VERDICT.UNCHANGED)
})

check('范围正常、有参照、有差异 → DRIFT', () => {
  assert.equal(decide({ range: { ok: true, unmet: {} }, baseline: BEFORE, changes: ['x'] }), VERDICT.DRIFT)
})

/* ── 退出码：让定时任务只看退出码就能分流 ── */

check('退出码：无变化 0、需处理 10、越界 20、无法判定 30', () => {
  assert.equal(exitCodeFor(VERDICT.UNCHANGED), EXIT.UNCHANGED)
  assert.equal(exitCodeFor(VERDICT.DRIFT), EXIT.ATTENTION)
  assert.equal(exitCodeFor(VERDICT.NO_BASELINE), EXIT.ATTENTION)
  assert.equal(exitCodeFor(VERDICT.OUT_OF_RANGE), EXIT.OUT_OF_RANGE)
  assert.equal(exitCodeFor(VERDICT.UNVERIFIABLE), EXIT.UNVERIFIABLE)
  assert.equal(EXIT.UNCHANGED, 0, '0 必须只表示「确实没事」')
})

console.log(`\ncompat 判定规则 ${passed} 项通过`)
