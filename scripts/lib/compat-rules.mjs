/**
 * compat-probe 的判定规则。
 *
 * 这里只放纯函数：给定插件清单、宿主版本和观察到的接口表面，决定结论是什么、
 * 变了哪些项。读宿主产物、解析 AST、读写参照文件都在 scripts/compat-probe.mjs 里。
 *
 * 拆开的理由是可测：判定逻辑的正确性不该依赖本机是否装了 DSH。
 */

/** 结论种类。ALL_CLEAR 之外全部需要人看一眼。 */
export const VERDICT = {
  UNCHANGED: 'UNCHANGED',
  DRIFT: 'DRIFT',
  OUT_OF_RANGE: 'OUT-OF-RANGE',
  NO_BASELINE: 'NO-BASELINE',
  UNVERIFIABLE: 'UNVERIFIABLE',
}

/** 进程退出码。用来让定时任务和 CI 只看退出码就能分流。 */
export const EXIT = {
  UNCHANGED: 0,
  ATTENTION: 10,
  OUT_OF_RANGE: 20,
  UNVERIFIABLE: 30,
}

/**
 * 与宿主 dsh-app-boot 的 evaluatePluginCompatibility 同规则判定版本范围。
 *
 * 有 engines.dsh 就只看它、忽略 peer；否则逐个校验 @deepseek-ai/dsh 与
 * @deepseek-ai/dsh-* 的 peer。宿主调用 semver 时传 includePrerelease: true，
 * 这里必须一致，否则预发布版本的结论会反过来。
 */
export function evaluateRange(manifest, runtimeVersion, semver) {
  const satisfies = (range) =>
    typeof range === 'string' &&
    range.trim() !== '' &&
    semver.satisfies(runtimeVersion, range, { includePrerelease: true })

  if (typeof manifest?.engines?.dsh === 'string') {
    const ok = satisfies(manifest.engines.dsh)
    return {
      source: 'engines.dsh',
      range: manifest.engines.dsh,
      ok,
      unmet: ok ? {} : { 'engines.dsh': manifest.engines.dsh },
    }
  }

  const unmet = {}
  for (const [name, range] of Object.entries(manifest?.peerDependencies ?? {})) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    if (!satisfies(range)) unmet[name] = range
  }
  return { source: 'peerDependencies', range: undefined, ok: Object.keys(unmet).length === 0, unmet }
}

/**
 * 合并同名的服务条目。
 *
 * 清单里允许把一个服务分几条写（例如「正常调用的方法」和「已知缺失的方法」分开记录），
 * 合并后成员的判定才完整；否则后一条会把前一条覆盖掉，缺失就查不出来。
 */
function mergeByName(services) {
  const merged = new Map()
  for (const service of services ?? []) {
    const existing = merged.get(service.name)
    if (existing === undefined) {
      merged.set(service.name, { ...service, members: [...(service.members ?? [])], implementedBy: [...(service.implementedBy ?? [])] })
      continue
    }
    for (const member of service.members ?? []) {
      if (!existing.members.includes(member)) existing.members.push(member)
    }
    for (const name of service.implementedBy ?? []) {
      if (!existing.implementedBy.includes(name)) existing.implementedBy.push(name)
    }
  }
  return [...merged.values()]
}

/**
 * 把服务声明整理成可比的观察记录。
 *
 * `declarations` 是服务名到提供方列表，每个提供方给出它导出的成员名。成员表读不出来时
 * （没有解析器），记录标成 membersUndetermined：不下「缺失」的结论，也不当作没问题。
 */
export function observeServices(surfaces, declarations) {
  const observed = { hostServices: {}, clientServices: {} }

  for (const group of ['host', 'client']) {
    const wantClientEntry = group === 'client'
    for (const entry of mergeByName(surfaces[group]?.services)) {
      const candidates = declarations.get(entry.name) ?? []
      // 成员可能不在声明服务的那个包里。宿主常见形状是：底座包声明 super(ctx, "x")，
      // 具体实现包继承底座、只写 super(ctx) 并实现方法（dsh-subprocess 与
      // dsh-subprocess-local 就是这种关系）。清单里可以用 `implementedBy` 指定实现包，
      // 把这些包的方法一并算进来。
      const extra = (entry.implementedBy ?? []).flatMap((name) => declarations.get(`@pkg:${name}`) ?? [])
      const sameSide = candidates.filter((candidate) => candidate.isClient === wantClientEntry)
      const pool = [...(sameSide.length > 0 ? sameSide : candidates), ...extra]

      if (pool.length === 0) {
        observed[`${group}Services`][entry.name] = { provided: false }
        continue
      }

      const available = new Set(pool.flatMap((candidate) => candidate.members))
      const undetermined = pool.some((candidate) => !candidate.membersKnown)
      observed[`${group}Services`][entry.name] = {
        provided: true,
        provider: [...new Set(pool.map((candidate) => candidate.packageName))].sort().join(', '),
        missingMembers: undetermined ? [] : (entry.members ?? []).filter((member) => !available.has(member)),
        ...(undetermined ? { membersUndetermined: true } : {}),
      }
    }
  }

  return observed
}

/** 插槽声明整体比对：声明在不在、kind 与 scope 有没有变。 */
export function observeSlots(names, declarations) {
  const observed = {}
  for (const name of names ?? []) {
    const declaration = declarations.get(name)
    observed[name] =
      declaration === undefined
        ? { declared: false }
        : { declared: true, kind: declaration.kind, scope: declaration.scope }
  }
  return observed
}

/**
 * 逐项比对两份观察记录，返回人可读的差异行。顺序稳定，便于比对输出。
 *
 * 只看包的版本号变了（`present`/`entry` 都一样）不算接口变化：包版本随宿主每次发版都动，
 * 把它算成差异会让每一次宿主升级都报 DRIFT，人就学会忽略结论了——那等于没有检查。
 * 这类差异单独记在 `versionOnly` 里，供输出时说明「宿主换了，接口没换」。
 */
export function diffSurface(before, after) {
  const changes = []
  const versionOnly = []
  for (const group of ['hostServices', 'clientServices', 'slots', 'packages']) {
    const a = before?.[group] ?? {}
    const b = after?.[group] ?? {}
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (JSON.stringify(a[key]) === JSON.stringify(b[key])) continue
      if (a[key] === undefined) changes.push(`${group}.${key}: 新增 ${describe(after[key])}`)
      else if (b[key] === undefined) changes.push(`${group}.${key}: 移除（原为 ${describe(a[key])}）`)
      else if (group === 'packages' && samePackageShape(a[key], b[key])) {
        versionOnly.push(`${group}.${key}: v${a[key].version} → v${b[key].version}`)
      } else changes.push(`${group}.${key}: ${describe(a[key])} → ${describe(b[key])}`)
    }
  }
  return { changes, versionOnly }
}

/** 两个包记录除了版本号以外是否一致。 */
function samePackageShape(a, b) {
  if (a === undefined || b === undefined) return false
  return a.present === b.present && a.entry === b.entry
}

/** 一条观察记录的短文，用于输出与差异行。 */
export function describe(value) {
  if (value === undefined) return '无'
  if (value.provided === false) return '未提供'
  if (value.declared === false) return '未声明'
  if (value.present === false) return '包不存在'
  const parts = []
  if (value.provider !== undefined) parts.push(`由 ${value.provider} 提供`)
  if (value.membersUndetermined === true) parts.push('成员未能判定')
  if (value.missingMembers?.length > 0) parts.push(`缺少方法 ${value.missingMembers.join('、')}`)
  if (value.kind !== undefined) parts.push(`kind=${value.kind} scope=${value.scope}`)
  if (value.version !== undefined) parts.push(`v${value.version}`)
  if (value.entry === false) parts.push('入口文件缺失')
  return parts.length > 0 ? parts.join('，') : '存在'
}

/**
 * 结论。顺序是有意为之：版本越界优先于一切——那种情况下宿主会在装载阶段就拒绝插件，
 * 接口表面变没变都不重要。
 */
export function decide({ range, baseline, changes }) {
  if (!range.ok) return VERDICT.OUT_OF_RANGE
  if (baseline === undefined) return VERDICT.NO_BASELINE
  return changes.length > 0 ? VERDICT.DRIFT : VERDICT.UNCHANGED
}

/** 结论到退出码。没有参照记录也算需要处理。 */
export function exitCodeFor(verdict) {
  if (verdict === VERDICT.OUT_OF_RANGE) return EXIT.OUT_OF_RANGE
  if (verdict === VERDICT.UNCHANGED) return EXIT.UNCHANGED
  if (verdict === VERDICT.UNVERIFIABLE) return EXIT.UNVERIFIABLE
  return EXIT.ATTENTION
}
