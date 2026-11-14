/**
 * 宿主升级检查：DSH 换了版本之后，本插件依赖的那些接口还在不在。
 *
 * 这个脚本回答一个问题，并且只回答这个问题：宿主运行时换了，本插件用到的服务、方法、
 * 插槽、注入包有没有跟着变。它不做构建，不跑测试，不联网。
 *
 * 判定依据全部取自宿主的真实产物，不靠本仓库手抄的表：
 *
 *   - 版本范围用宿主自带的 semver 判定，并且和宿主一样传 includePrerelease: true。
 *     宿主侧的判定函数是 dsh-app-boot 的 evaluatePluginCompatibility：清单里有 engines.dsh
 *     就只看它、忽略 peer；否则逐个校验 @deepseek-ai/dsh 与 @deepseek-ai/dsh-* 的 peer。
 *   - 服务名从宿主产物里扫出来。宿主有两种提供方式：类的构造函数里 super(ctx, "<名字>")，
 *     以及插件体里 ctx.provide("<名字>", 实例)。两种都认。
 *   - 服务的方法来自该服务所属类的实例成员，用宿主自带的 acorn 解析得到，不做正则猜测。
 *   - 插槽声明取自声明它的客户端包里 "<名字>": { kind, scope } 的字面量。
 *
 * 三种结论：
 *
 *   UNCHANGED      版本在范围内，接口表面与参照记录一致。不需要人介入。
 *   DRIFT          版本在范围内，但某个接口表面变了，或者还没有参照记录。需要人看一眼。
 *   OUT-OF-RANGE   版本超出 engines.dsh 或 peer 范围。宿主会在装载时拒绝本插件。
 *
 * 退出码：0 UNCHANGED / 10 DRIFT 或没有参照记录 / 20 OUT-OF-RANGE / 30 无法判定。
 *
 * 用法：
 *
 *   node scripts/compat-probe.mjs                    判定，与 dsh-baseline.json 比对
 *   node scripts/compat-probe.mjs --write-baseline   记录当前宿主为参照
 *   node scripts/compat-probe.mjs --json             输出机器可读结果
 *   node scripts/compat-probe.mjs --verbose          打印每个接口的明细
 *
 * 环境变量 DSH_APP_ASAR 或 DSH_APP_ROOT 可指定宿主位置。默认按常见安装路径和当前
 * 可执行文件的位置查找。找不到宿主时退出码 30，不会当成通过。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  EXIT,
  VERDICT,
  decide,
  describe,
  diffSurface,
  evaluateRange,
  exitCodeFor,
  observeServices,
  observeSlots,
} from './lib/compat-rules.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SURFACES_FILE = path.join(REPO_ROOT, 'dsh-surfaces.json')
const BASELINE_FILE = path.join(REPO_ROOT, 'dsh-baseline.json')

/* ─────────────────────────────── 宿主产物读取 ─────────────────────────────── */

const normalize = (value) => value.replaceAll('\\', '/').replace(/^\.\//, '')

/**
 * app.asar 是 Electron 归档格式：头部 8 字节，随后是一段 pickle 包裹的 JSON 目录，
 * 文件内容按 offset 排在 4 字节对齐之后的位置。这里只读目录和按需读文件。
 */
function openAsar(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  const head = Buffer.alloc(8)
  fs.readSync(fd, head, 0, 8, 0)
  const pickleSize = head.readUInt32LE(4)
  const headerBuffer = Buffer.alloc(pickleSize)
  fs.readSync(fd, headerBuffer, 0, pickleSize, 8)
  const jsonLength = headerBuffer.readUInt32LE(4)
  const directory = JSON.parse(headerBuffer.subarray(8, 8 + jsonLength).toString('utf8'))
  const baseOffset = Math.ceil((8 + pickleSize) / 4) * 4

  const index = new Map()
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const full = prefix === '' ? name : `${prefix}/${name}`
      if (child.files !== undefined) walk(child, full)
      // unpacked 条目不在归档里，按缺失处理：需要它们的宿主自会暴露别的信号。
      else if (child.unpacked !== true) index.set(full, { size: child.size, offset: Number(child.offset) })
    }
  }
  walk(directory, '')

  return {
    kind: 'asar',
    path: asarPath,
    describe: asarPath,
    indices: [...index.keys()],
    has: (relative) => index.has(normalize(relative)),
    read(relative) {
      const entry = index.get(normalize(relative))
      if (entry === undefined) return undefined
      const buffer = Buffer.alloc(entry.size)
      fs.readSync(fd, buffer, 0, entry.size, baseOffset + entry.offset)
      return buffer.toString('utf8')
    },
    close: () => fs.closeSync(fd),
  }
}

/** 解包安装（开发版或旧版桌面）就是普通目录。 */
function openDirectory(rootPath) {
  const files = []
  const walk = (relative) => {
    let names
    try {
      names = fs.readdirSync(path.join(rootPath, relative), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of names) {
      const next = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(next)
      else files.push(next)
    }
  }
  walk('')

  const set = new Set(files.map(normalize))
  return {
    kind: 'directory',
    path: rootPath,
    describe: rootPath,
    indices: [...set],
    has: (relative) => set.has(normalize(relative)),
    read(relative) {
      try {
        return fs.readFileSync(path.join(rootPath, relative), 'utf8')
      } catch {
        return undefined
      }
    },
    close() {},
  }
}

/**
 * 定位宿主产物。
 *
 * 显式指定了位置就只认那个位置：勾错了路径却静默换一台宿主去检查，等于给出一个
 * 关于别的东西的结论。这种情况下返回 { error } 让上层报「无法判定」。
 */
function openHost() {
  const explicit = [
    process.env.DSH_APP_ASAR,
    process.env.DSH_APP_ROOT === undefined
      ? undefined
      : path.join(process.env.DSH_APP_ROOT, 'resources', 'app.asar'),
    process.env.DSH_APP_ROOT,
  ].filter((value) => typeof value === 'string' && value.length > 0)

  if (explicit.length > 0) {
    for (const candidate of explicit) {
      const opened = openCandidate(candidate)
      if (opened !== undefined) return opened
    }
    return {
      error:
        `指定的宿主位置里没有可读的 app.asar 或解包目录：${explicit.join('、')}。` +
        '检查 DSH_APP_ASAR / DSH_APP_ROOT，或去掉它们让脚本按常见安装路径查找。',
    }
  }

  const fallbacks = [
    path.join(path.dirname(process.execPath), 'resources', 'app.asar'),
    path.join(path.dirname(process.execPath), 'resources', 'app'),
    'C:/Program Files/DSH NEXT/resources/app.asar',
    'C:/Program Files/DSH NEXT/resources/app',
    'C:/Program Files/DSH Desktop/resources/app.asar',
    'C:/Program Files/DSH Desktop/resources/app',
  ]
  for (const candidate of fallbacks) {
    const opened = openCandidate(candidate)
    if (opened !== undefined) return opened
  }
  return { error: '找不到 DSH 运行时（app.asar 或解包目录）。可用 DSH_APP_ASAR 或 DSH_APP_ROOT 指定。' }
}

function openCandidate(candidate) {
  let stat
  try {
    stat = fs.statSync(candidate)
  } catch {
    return undefined
  }
  if (stat.isFile() && candidate.endsWith('.asar')) return openAsar(candidate)
  if (stat.isDirectory()) return openDirectory(candidate)
  return undefined
}

/* ─────────────────────────────── 依赖加载 ─────────────────────────────── */

/**
 * 从一个具体的 package.json 位置解析出某个包。宿主和 profile 的依赖布局不同，
 * 逐个试，全部失败才算找不到。
 */
function requireFromAnchors(packageName, anchors) {
  for (const anchor of anchors) {
    try {
      return createRequire(anchor)(packageName)
    } catch {
      /* 换下一个 */
    }
  }
  return undefined
}

/**
 * 版本范围判定必须和宿主一致。自己重写 includePrerelease 的语义出错时，结论会静默地
 * 反过来：该拦的放过去，或者反过来误报不兼容。因此优先用宿主的 semver，其次 profile 的。
 */
function loadSemver(host) {
  const anchors = [
    path.join(REPO_ROOT, 'package.json'),
    process.env.DSH_PROFILE_DIR === undefined
      ? undefined
      : path.join(process.env.DSH_PROFILE_DIR, 'package.json'),
  ].filter((value) => typeof value === 'string')

  for (const anchor of anchors) {
    const semver = requireFromAnchors('semver', [anchor])
    if (semver !== undefined) return semver
  }
  if (host.kind === 'asar') {
    // 宿主自带一份 semver（app-boot 用它判定兼容性），解出来用。
    const extracted = extractPackage(host, 'semver', ['index.js', 'classes/', 'functions/', 'internal/', 'ranges/', 'package.json'])
    if (extracted !== undefined) {
      const semver = requireFromAnchors('semver', [path.join(extracted, 'package.json')])
      if (semver !== undefined) return semver
    }
  }
  return undefined
}

/**
 * 解析宿主产物需要用 acorn：手写词法分析对 new Map() 这类表达式会认错成员。
 * 宿主自带一份（app-boot 用它），解出来用；拿不到时上层会把方法级判定降级并写明，
 * 而不是让整个检查失败——版本范围和插槽声明不依赖解析器。
 */
async function loadAcorn(host) {
  const extracted = extractPackage(host, 'acorn', ['dist/acorn.mjs', 'package.json'], 'dist/acorn.mjs')
  if (extracted !== undefined) {
    const entry = path.join(extracted, 'dist/acorn.mjs')
    if (fs.existsSync(entry)) {
      try {
        return await import(pathToFileURL(entry).href)
      } catch {
        /* 落到「没有解析器」 */
      }
    }
  }
  return undefined
}

/**
 * 把宿主产物里的一个包解到临时目录，按宿主位置与版本做键，重复运行直接复用。
 * 返回解出后的根目录。
 */
function extractPackage(host, packageName, wanted, entryRelative) {
  const prefix = `node_modules/${packageName}/`
  const names = host.indices.filter((name) => name.startsWith(prefix))
  if (names.length === 0) return undefined

  const selected = names.filter((name) => {
    const relative = name.slice(prefix.length)
    return relative === 'package.json' || wanted.some((item) => (item.endsWith('/') ? relative.startsWith(item) : relative === item))
  })
  if (selected.length === 0) return undefined

  const key = createHash('sha1')
    .update(`${host.describe}\u0000${packageName}\u0000${selected.join('\u0000')}`)
    .digest('hex')
    .slice(0, 12)
  const target = path.join(os.tmpdir(), 'dsh-compat-probe', key, packageName)
  const marker = path.join(target, '.complete')

  if (!fs.existsSync(marker)) {
    fs.rmSync(target, { recursive: true, force: true })
    for (const name of selected) {
      const relative = name.slice(prefix.length)
      const destination = path.join(target, relative)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.writeFileSync(destination, host.read(name) ?? '')
    }
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(marker, entryRelative ?? '')
  }
  return target
}

/* ─────────────────────────────── 版本范围判定 ─────────────────────────────── */

/** 宿主自己用的运行时版本来自 dsh-app-boot；退一步用 dsh 包的版本。 */
function readRuntimeVersion(host) {
  for (const packageName of ['dsh-app-boot', 'dsh']) {
    const source = host.read(`node_modules/@deepseek-ai/${packageName}/package.json`)
    if (source === undefined) continue
    try {
      const version = JSON.parse(source).version
      if (typeof version === 'string') return { version, from: packageName }
    } catch {
      /* 换下一个 */
    }
  }
  return undefined
}

/* ─────────────────────────────── 服务声明 ─────────────────────────────── */

const BUNDLE_PATTERN = /^node_modules\/@deepseek-ai\/([^/]+)\/lib\/(.+\.js)$/

/**
 * 扫宿主产物，建服务名到提供方的表。只解析可能声明服务的那批文件：串里出现
 * `super(` 或 `.provide(` 才值得解析，其余跳过——这一步把一千多个包压到两百多个。
 */
function scanServices(host, acorn) {
  const byService = new Map()
  // 没有解析器就一条都不解析：上层会把「服务已提供但成员未判定」如实报出来。
  if (acorn === undefined) return { byService, parseFailures: [] }
  const parseFailures = []

  for (const file of host.indices) {
    const match = BUNDLE_PATTERN.exec(file)
    if (match === null) continue
    const [, packageName, entry] = match
    const source = host.read(file)
    if (source === undefined) continue
    if (!source.includes('super(') && !source.includes('.provide(')) continue

    let ast
    try {
      ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
    } catch (error) {
      parseFailures.push(`${file}: ${error.message}`)
      continue
    }

    // 文件里出现的类，按变量名登记。服务实例可能是类本身，也可能由类构造出来。
    const classes = new Map()
    // 类节点到它的变量名：`var X = class extends S` 的 ClassExpression 自身没有 id。
    const nameOfClass = new Map()
    // x.prototype.m = ... 形式的方法：不在类体里，但同样挂在实例上。
    const prototypes = new Map()
    // const y = new X(...) 形式的局部实例，供 provide("x", y) 反查。
    const instances = new Map()

    walkAST(ast, (node) => {
      if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
        if (node.id?.name !== undefined) {
          classes.set(node.id.name, node)
          nameOfClass.set(node, node.id.name)
        }
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
        if (node.init?.type === 'ClassExpression') {
          classes.set(node.id.name, node.init)
          nameOfClass.set(node.init, node.id.name)
        } else if (node.init?.type === 'NewExpression' && node.init.callee.type === 'Identifier') {
          instances.set(node.id.name, node.init.callee.name)
        } else if (node.init?.type === 'Identifier') {
          instances.set(node.id.name, node.init.name)
        }
      }
      // X.prototype.m = / X.prototype["m"] =
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression') {
        const target = node.left.object
        if (
          target.type === 'MemberExpression' &&
          target.object.type === 'Identifier' &&
          target.property.type === 'Identifier' &&
          target.property.name === 'prototype'
        ) {
          const key = node.left.property
          const name = key.type === 'Identifier' ? key.name : key.type === 'Literal' ? String(key.value) : undefined
          if (name !== undefined) {
            const set = prototypes.get(target.object.name) ?? new Set()
            set.add(name)
            prototypes.set(target.object.name, set)
          }
        }
      }
    })

    const membersOf = (className) => {
      if (className === undefined) return undefined
      const classNode = classes.get(className)
      const fromBody = classNode === undefined ? undefined : classBodyMembers(classNode)
      const fromPrototype = prototypes.get(className)
      if (fromBody === undefined && fromPrototype === undefined) return undefined
      return [...new Set([...(fromBody ?? []), ...(fromPrototype ?? [])])].sort()
    }

    const seenClasses = new Set()
    const record = (name, kind, className) => {
      const members = className === undefined ? undefined : membersOf(className)
      const bucket = byService.get(name) ?? []
      bucket.push({
        packageName,
        file,
        entry,
        kind,
        membersKnown: members !== undefined,
        members: members ?? [],
      })
      byService.set(name, bucket)
    }

    for (const node of ast.body) {
      for (const declaration of declarationsIn(node, instances, nameOfClass)) {
        record(declaration.name, declaration.kind, declaration.className)
      }
    }

    // 包里所有类的实例成员，按包名登记一份。
    //
    // 为什么需要：宿主把接口与实现分在两个包是常见形状——底座包声明 super(ctx, "subprocess")，
    // 实现包继承底座、只写 super(ctx) 并实现方法。这时服务名与「方法在哪个包」不在同一处，
    // 清单用 implementedBy 指到实现包就能取到这些方法。
    for (const [className, classNode] of classes) {
      if (seenClasses.has(classNode)) continue
      seenClasses.add(classNode)
      const members = membersOf(className)
      if (members === undefined || members.length === 0) continue
      const key = `@pkg:${packageName}`
      const bucket = byService.get(key) ?? []
      bucket.push({ packageName, file, entry, isClient: entry === 'client.js', membersKnown: true, members })
      byService.set(key, bucket)
    }
  }

  return { byService, parseFailures }
}

/** 深度遍历 AST，跳过位置字段。 */
function walkAST(node, visit) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walkAST(child, visit)
    return
  }
  visit(node)
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue
    walkAST(node[key], visit)
  }
}

/** 在一个顶层语句里找服务声明：构造函数里的 super(ctx, "名字")，或正文里的 provide("名字", …)。 */
function declarationsIn(node, instances, nameOfClass) {
  const found = []

  const visit = (current, enclosingClass) => {
    if (current === null || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const child of current) visit(child, enclosingClass)
      return
    }
    if (current.type === 'ClassDeclaration' || current.type === 'ClassExpression') {
      visitClass(current)
      return
    }
    if (current.type === 'CallExpression' && current.callee.type === 'MemberExpression') {
      const property = current.callee.property
      const propertyName = property.type === 'Identifier' ? property.name : undefined
      const first = stringLiteral(current.arguments[0])

      if (propertyName === 'provide' && first !== undefined) {
        // provide("x", 表达式)：能解析出实现类就取它的成员；拿不到就标成成员未判定，
        // 而不是当作「没有成员」——那是脚本的局限，不是宿主的事实。
        const second = current.arguments[1]
        let className
        if (second?.type === 'Identifier') className = instances.get(second.name) ?? second.name
        else if (second?.type === 'NewExpression' && second.callee.type === 'Identifier') className = second.callee.name
        found.push({ kind: 'provide', name: first, className })
      }
    }
    for (const key of Object.keys(current)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue
      visit(current[key], enclosingClass)
    }
  }

  const visitClass = (classNode) => {
    // 只关心构造函数里显式声明服务名的那一类。
    for (const member of classNode.body.body) {
      if (member.type !== 'MethodDefinition' || member.kind !== 'constructor') continue
      const walk = (current) => {
        if (current === null || typeof current !== 'object') return
        if (Array.isArray(current)) {
          for (const child of current) walk(child)
          return
        }
        if (
          current.type === 'CallExpression' &&
          current.callee.type === 'Super' &&
          current.arguments.length >= 2
        ) {
          const name = stringLiteral(current.arguments[1])
          if (name !== undefined) {
            found.push({ kind: 'super', name, className: nameOfClass.get(classNode) })
          }
        }
        for (const key of Object.keys(current)) {
          if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue
          walk(current[key])
        }
      }
      if (member.value?.body !== undefined) walk(member.value.body)
    }
  }

  visit(node, undefined)
  return found
}

/**
 * 读出一个字符串字面量的值。
 *
 * 必须同时认反引号：宿主从 0.2.2-rc.3 起把客户端产物压成单行，字符串字面量改用模板字面量
 * 写（`super(ctx, \`slots\`)`）。只认单双引号时这些声明会被整片漏掉，表现为一堆服务
 * 「未提供」——那是探针的盲区，不是宿主变了。
 *
 * 带插值的模板（`${x}` 那种）不算字面量：它的值运行期才知道。
 */
const stringLiteral = (node) => {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('')
  }
  return undefined
}

/**
 * 读取类的实例成员名。静态成员不算：调用方拿到的是实例，static 上的方法调不到。
 * 构造函数也不算，它不是服务接口。
 */
function classBodyMembers(classNode) {
  const names = []
  for (const member of classNode.body.body) {
    if (member.type !== 'MethodDefinition' && member.type !== 'PropertyDefinition') continue
    if (member.static === true) continue
    if (member.kind === 'constructor') continue
    const key = member.key
    if (key.type === 'Identifier') names.push(key.name)
    else if (key.type === 'PrivateIdentifier') names.push(`#${key.name}`)
    else if (key.type === 'Literal') names.push(String(key.value))
  }
  return names
}

/* ─────────────────────────────── 插槽声明 ─────────────────────────────── */

/**
 * 每个插槽在声明它的客户端包里写成 "<名字>": { kind, scope } 的字面量。
 * 这里把宿主产物里所有这种形状都收进来，不限定声明方是哪个包。
 *
 * 引号有讲究：0.2.2-rc.1 及更早用单双引号，0.2.2-rc.3 起压成单行后改用反引号。
 * 三种都认，否则新一代宿主上所有插槽都会被判成「未声明」。
 */
function scanSlots(host) {
  const slots = new Map()
  const q = '["\'`]'
  const pattern = new RegExp(
    `${q}([A-Za-z][\\w.]*)${q}\\s*:\\s*\\{\\s*kind\\s*:\\s*${q}([a-z]+)${q}\\s*,\\s*scope\\s*:\\s*${q}([a-zA-Z-]+)${q}`,
    'g',
  )

  for (const file of host.indices) {
    const match = BUNDLE_PATTERN.exec(file)
    if (match === null) continue
    const source = host.read(file)
    if (source === undefined || !source.includes('scope:')) continue
    for (const declaration of source.matchAll(pattern)) {
      if (!slots.has(declaration[1])) {
        slots.set(declaration[1], { kind: declaration[2], scope: declaration[3], declaredIn: match[1] })
      }
    }
  }
  return slots
}

/* ─────────────────────────────── 插件侧声明 ─────────────────────────────── */

function readSurfaces() {
  if (!fs.existsSync(SURFACES_FILE)) {
    throw new Error(
      `缺少 ${path.basename(SURFACES_FILE)}：这份文件列出本插件依赖的宿主接口，没有它就无法判断宿主升级影响了什么。`,
    )
  }
  return JSON.parse(fs.readFileSync(SURFACES_FILE, 'utf8'))
}

const readManifest = () => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))

/* ─────────────────────────────── 观察到的事实 ─────────────────────────────── */

/**
 * 把当前宿主上观察到的接口表面收成一份可比的记录。
 *
 * 记录里只放声明层面的事实：服务由哪个包提供、方法在不在、插槽怎么声明、包在不在。
 * 不放文件哈希——宿主任何与插件无关的改动都会改哈希，那样每次升级都报变化，等于没有结论。
 */
function observeSurface(host, surfaces, services, slots) {
  const serviceRecords = new Map()
  for (const [name, candidates] of services) {
    serviceRecords.set(
      name,
      candidates.map((candidate) => ({
        packageName: candidate.packageName,
        isClient: candidate.entry === 'client.js',
        members: candidate.members,
        membersKnown: candidate.membersKnown,
      })),
    )
  }

  const observed = {
    ...observeServices(surfaces, serviceRecords),
    slots: observeSlots(surfaces.client?.slots, slots),
    packages: {},
  }

  const packages = [
    ...(surfaces.host?.packages ?? []).map((shortName) => ['index', shortName]),
    ...(surfaces.client?.packages ?? []).map((shortName) => ['client', shortName]),
  ]
  for (const [entry, shortName] of packages) {
    observed.packages[`@deepseek-ai/${shortName}`] = observePackage(host, shortName, entry)
  }

  return observed
}

function observePackage(host, shortName, entry) {
  const source = host.read(`node_modules/@deepseek-ai/${shortName}/package.json`)
  if (source === undefined) return { present: false }
  let version
  try {
    version = JSON.parse(source).version
  } catch {
    version = undefined
  }
  return {
    present: true,
    version,
    entry: host.has(`node_modules/@deepseek-ai/${shortName}/lib/${entry}.js`),
  }
}

/**
 * dsh CLI 声明的 @deepseek-ai/dsh-* 依赖，用它当「这份安装应当有哪些包」的全集。
 * 找不到 CLI 清单时返回空数组，调用方退回只看 app-boot 的依赖。
 */
function readCliDependencies(host) {
  const source = host.read('node_modules/@deepseek-ai/dsh/package.json')
  if (source === undefined) return []
  try {
    const manifest = JSON.parse(source)
    const names = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]
    // 只看宿主运行时与能力包；devDependencies 里混着 eslint 这类与宿主无关的包。
    return [...new Set(names)].filter((name) => name.startsWith('@deepseek-ai/dsh-'))
  } catch {
    return []
  }
}

/**
 * 判断这份宿主产物是否是一次完整安装。
 *
 * 为什么必须查：dsh-temptask 的 _asar 目录里只有 21 个包，是当年为了验证某条契约抽取的
 * 子集。拿它来检查本插件，会得到一长串「服务未提供」——那是采样造成的，不是宿主的事实。
 *
 * 判据是基线事实：一份能运行 DSH 的安装里，本插件依赖的每个服务提供方都必须存在。
 * 缺一个就说明这不是完整安装，此时不下任何「接口变了」的结论。
 */
function checkCompleteness(host, surfaces) {
  const providers = [
    ...(surfaces.host?.providerPackages ?? []),
    ...(surfaces.client?.providerPackages ?? []),
  ]
  const missing = [...new Set(providers)].filter(
    (name) => !host.has(`node_modules/@deepseek-ai/${name}/package.json`),
  )
  if (missing.length === 0) return { complete: true }

  return {
    complete: false,
    reason:
      `这份宿主产物不完整：缺少 ${missing.length} 个应当存在的宿主包（${missing.join('、')}）。` +
      '只抽取了部分包的副本无法用于判定接口是否变化，请指向完整安装的 app.asar。',
  }
}

/* ─────────────────────────────── 主流程 ─────────────────────────────── */

const argv = new Set(process.argv.slice(2))
const writeBaseline = argv.has('--write-baseline')
const asJson = argv.has('--json')
const verbose = argv.has('--verbose')

async function main() {
  const manifest = readManifest()
  const host = openHost()
  if (host.error !== undefined) {
    return finish({ verdict: 'UNVERIFIABLE', reason: host.error }, EXIT.UNVERIFIABLE)
  }

  const runtime = readRuntimeVersion(host)
  const semver = loadSemver(host)
  if (runtime === undefined || semver === undefined) {
    host.close()
    const missing = [
      runtime === undefined ? 'dsh-app-boot 版本' : undefined,
      semver === undefined ? 'semver' : undefined,
    ].filter(Boolean)
    return finish({ verdict: 'UNVERIFIABLE', reason: `宿主产物里取不到：${missing.join('、')}。` }, EXIT.UNVERIFIABLE)
  }

  const surfaces = readSurfaces()
  // 残缺的宿主副本（只抽了几个包做实验）会让一堆服务看起来「未提供」，那是采样问题，
  // 不是宿主的事实。先确认这是一份完整安装，否则如实报无法判定，不给出误导性的差异。
  const completeness = checkCompleteness(host, surfaces)
  if (!completeness.complete) {
    host.close()
    return finish({ verdict: 'UNVERIFIABLE', reason: completeness.reason }, EXIT.UNVERIFIABLE)
  }

  const range = evaluateRange(manifest, runtime.version, semver)
  // 没有解析器时方法级判定降级，其余判定照常：版本范围和插槽声明不依赖 AST。
  const acorn = await loadAcorn(host)
  const { byService, parseFailures } = scanServices(host, acorn)
  const slots = scanSlots(host)
  const surface = observeSurface(host, surfaces, byService, slots)
  host.close()

  const baseline = fs.existsSync(BASELINE_FILE)
    ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
    : undefined
  const { changes, versionOnly } =
    baseline === undefined ? { changes: [], versionOnly: [] } : diffSurface(baseline.surface, surface)

  const verdict = decide({ range, baseline, changes })

  const result = {
    verdict,
    plugin: { name: manifest.name, version: manifest.version },
    runtime: { version: runtime.version, from: runtime.from, host: host.describe },
    range,
    baseline: baseline === undefined ? undefined : { runtime: baseline.runtime, recordedAt: baseline.recordedAt },
    changes,
    versionOnly,
    parseFailures,
    surface,
  }

  if (writeBaseline) {
    fs.writeFileSync(
      BASELINE_FILE,
      `${JSON.stringify(
        {
          $comment:
            '本文件由 node scripts/compat-probe.mjs --write-baseline 生成，记录确认可用的宿主版本与接口表面，供后续升级比对。',
          runtime: runtime.version,
          recordedAt: new Date().toISOString(),
          surface,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    result.wroteBaseline = path.relative(REPO_ROOT, BASELINE_FILE)
  }

  // 写入参照本身就是这次运行的目的，写完即成功；版本越界仍然报出来。
  const exitCode = writeBaseline ? (range.ok ? EXIT.UNCHANGED : EXIT.OUT_OF_RANGE) : exitCodeFor(verdict)
  finish(result, exitCode)
}

function finish(result, exitCode) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = exitCode
    return
  }

  if (result.verdict === 'UNVERIFIABLE') {
    console.log(`无法判定：${result.reason}`)
    process.exitCode = exitCode
    return
  }

  console.log(`宿主运行时  ${result.runtime.version}  (${result.runtime.host})`)
  console.log(`插件        ${result.plugin.name}@${result.plugin.version}`)
  const rangeText =
    result.range.source === 'engines.dsh'
      ? `engines.dsh ${result.range.range}`
      : `peer 范围（${Object.keys(result.range.unmet).length} 条不满足）`
  console.log(`版本范围    ${rangeText} → ${result.range.ok ? '在范围内' : '超出范围'}`)

  if (result.wroteBaseline !== undefined) {
    console.log(`\n已写入 ${result.wroteBaseline}，参照宿主 ${result.runtime.version}`)
    process.exitCode = exitCode
    return
  }

  if (verbose) {
    console.log('\n接口表面')
    for (const group of ['hostServices', 'clientServices', 'slots', 'packages']) {
      for (const [key, value] of Object.entries(result.surface[group] ?? {})) {
        console.log(`  ${`${group}.${key}`.padEnd(44)} ${describe(value)}`)
      }
    }
  }

  // 只有版本号变了时说明一句：宿主换了但接口没换，参照里记的是哪个宿主照旧有效。
  const versionNote =
    result.versionOnly?.length > 0
      ? `\n宿主版本变了（${result.baseline.runtime} → ${result.runtime.version}），接口表面未变。` +
        `\n  ${result.versionOnly.length} 个包的版本号跟着变，不影响兼容性；确认插件在这个宿主上好用后，` +
        '可运行 --write-baseline 把参照推进到新版本。'
      : ''

  if (result.verdict === 'UNCHANGED') {
    console.log(`\nUNCHANGED  接口表面与参照记录一致（参照宿主 ${result.baseline.runtime}）`)
    if (versionNote.length > 0) console.log(versionNote)
  } else if (result.verdict === 'DRIFT') {
    console.log(`\nDRIFT  接口表面变了（参照宿主 ${result.baseline.runtime}）：`)
    for (const change of result.changes) console.log(`  - ${change}`)
    if (versionNote.length > 0) console.log(versionNote)
    console.log('\n处理方法见 skill dsh-plugin-compat。')
  } else if (result.verdict === 'OUT-OF-RANGE') {
    console.log('\nOUT-OF-RANGE  宿主会拒绝装载本插件，必须先适配：')
    for (const [name, range] of Object.entries(result.range.unmet)) {
      console.log(`  - ${name} 要求 ${range}，宿主是 ${result.runtime.version}`)
    }
    if (result.changes.length > 0) {
      console.log('\n接口表面同时变了：')
      for (const change of result.changes) console.log(`  - ${change}`)
    }
  } else {
    console.log('\n没有参照记录。确认当前宿主可用后运行：node scripts/compat-probe.mjs --write-baseline')
  }

  if (result.parseFailures.length > 0) {
    console.log(`\n注意：${result.parseFailures.length} 个宿主产物无法解析，相关服务的成员未参与判定：`)
    for (const failure of result.parseFailures.slice(0, 5)) console.log(`  - ${failure}`)
  }

  process.exitCode = exitCode
}

await main()
