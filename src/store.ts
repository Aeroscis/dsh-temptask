/**
 * dsh-temptask — 任务清单持久化（`<pluginDataDir>/tasks.json`）。
 *
 * 可靠性要求（对应需求「错误处理与边界情况」）：
 *   - 原子写入：先写 `tasks.json.tmp` 再 rename，避免半截文件；
 *   - 进程内串行锁：同名进程的所有变更排队执行；
 *   - **跨进程安全**：每次写入前在锁内**重读磁盘**，以磁盘内容为基准做变更。
 *     同一个 DSH_HOME 下可能同时跑两个 profile（例如 desktop + `dsh web`），
 *     它们共享同一份 tasks.json；若以各自的内存副本为基准整份覆盖，就会互相抹掉。
 *   - 幂等写：变更前后内容一致就不落盘（避免「没有实际变化也写一次」）。
 *   - 清单损坏：启动时备份为 `tasks.json.bak` 并重建空清单；运行期只告警、不覆盖证据。
 *
 * 已知边界：这里没有跨进程文件锁，残留窗口是「一次 read-modify-write」
 * （读盘 → 变更 → rename，通常亚毫秒级）。再做重一点需要 OS 级文件锁或每任务一个文件，
 * 对本插件的使用频率不值得；如需更强保证，见 README「并发」一节。
 */
import { copyFile, readFile } from 'node:fs/promises';

import { writeJsonAtomic } from './config.js';
import type { Task, TaskStatus, TaskStore } from './types.js';

/** 清单版本。 */
export const TASK_STORE_VERSION = 1;

export interface LoadOutcome {
  /** 恢复过程中的告警（如清单损坏已备份重建），交给 UI 展示。 */
  warnings: string[];
}

export interface TaskStoreFileOptions {
  /** 运行期告警出口（清单损坏、记录无法解析等）。 */
  onWarning?: (message: string) => void;
}

/** 读盘结果。区分「文件不存在」与「文件损坏」，因为二者处理方式完全不同。 */
type DiskRead =
  | { kind: 'ok'; store: TaskStore }
  | { kind: 'missing' }
  | { kind: 'corrupt'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 校验并收敛单条任务记录；返回 undefined 表示这条无法修复，应丢弃。 */
function coerceTask(value: unknown): Task | undefined {
  if (!isRecord(value)) return undefined;
  const id = str(value.id);
  const dirName = str(value.dirName);
  const path = str(value.path);
  const createdAt = num(value.createdAt);
  if (id === undefined || dirName === undefined || path === undefined || createdAt === undefined) {
    return undefined;
  }
  const status: TaskStatus = value.status === 'closed' ? 'closed' : 'active';
  const task: Task = {
    id,
    dirName,
    path,
    createdAt,
    status,
  };
  const workspaceId = str(value.workspaceId);
  if (workspaceId !== undefined) task.workspaceId = workspaceId;
  const lastOpenedAt = num(value.lastOpenedAt);
  if (lastOpenedAt !== undefined) task.lastOpenedAt = lastOpenedAt;
  const closedAt = num(value.closedAt);
  if (closedAt !== undefined) task.closedAt = closedAt;
  const sessionId = str(value.sessionId);
  if (sessionId !== undefined) task.sessionId = sessionId;
  return task;
}

/** 任务清单文件：内存缓存 + 串行化原子落盘 + 跨进程重读。 */
export class TaskStoreFile {
  /** 内存缓存：只服务于读路径（列表/查询），写入路径一律以磁盘为基准。 */
  private store: TaskStore;

  /** 串行锁：每个变更/重读排在上一笔之后。 */
  private tail: Promise<unknown> = Promise.resolve();

  private readonly onWarning: ((message: string) => void) | undefined;

  constructor(
    readonly file: string,
    initialRootDir: string,
    options: TaskStoreFileOptions = {},
  ) {
    this.store = { version: TASK_STORE_VERSION, rootDir: initialRootDir, tasks: [] };
    this.onWarning = options.onWarning;
  }

  private note(message: string): void {
    this.onWarning?.(message);
  }

  /** 当前清单的浅拷贝（调用方不可直接改内部数组）。 */
  snapshot(): TaskStore {
    return { version: this.store.version, rootDir: this.store.rootDir, tasks: [...this.store.tasks] };
  }

  /** 只读任务列表（浅拷贝）。 */
  list(): Task[] {
    return [...this.store.tasks];
  }

  find(id: string): Task | undefined {
    return this.store.tasks.find((task) => task.id === id);
  }

  findByDir(path: string): Task | undefined {
    return this.store.tasks.find((task) => task.path === path);
  }

  findBySession(sessionId: string): Task | undefined {
    return this.store.tasks.find((task) => task.sessionId === sessionId);
  }

  /* ─────────────────────────── 读 ─────────────────────────── */

  /**
   * 启动加载：文件不存在按空清单处理，损坏则备份重建。
   * 任何情况都不抛错——插件启动不能被一份坏清单卡死。
   */
  async load(fallbackRootDir: string): Promise<LoadOutcome> {
    const warnings: string[] = [];
    const read = await this.readFromDisk(fallbackRootDir);

    if (read.kind === 'ok') {
      this.store = read.store;
      return { warnings };
    }

    if (read.kind === 'corrupt') {
      const backedUp = await this.backupCorrupt();
      const message = `${read.message}，已${backedUp ? `备份为 ${this.file}.bak 并` : ''}重建空清单`;
      warnings.push(message);
      this.note(message);
    }

    this.store = { version: TASK_STORE_VERSION, rootDir: fallbackRootDir, tasks: [] };
    if (read.kind === 'corrupt') {
      try {
        await this.persist();
      } catch {
        /* 写不进去也要让插件继续跑，UI 会显示告警 */
      }
    }
    return { warnings };
  }

  /**
   * 运行期重读：让本进程看到别的进程（另一个 profile）写入的变更。
   *
   * 不做时间窗节流——`/state` 的语义就是「界面看到的就是磁盘上的」，
   * 而读取是一次原子 rename 后的整文件读（KB 级），成本远低于一次界面误导。
   * 损坏时只告警、不覆盖内存缓存，也不改动文件。
   */
  async refresh(): Promise<void> {
    await this.enqueue(async () => {
      const read = await this.readFromDisk(this.store.rootDir);
      if (read.kind === 'ok') {
        this.store = read.store;
      } else if (read.kind === 'missing') {
        // 文件被删掉了：磁盘是权威，本进程的缓存随之清空。
        this.store = { version: TASK_STORE_VERSION, rootDir: this.store.rootDir, tasks: [] };
      } else {
        this.note(`${read.message}（本次沿用内存中的清单，未改动文件）`);
      }
    });
  }

  /**
   * 串行化地变更清单并落盘。
   *
   * 基准是**锁内刚读到的磁盘内容**，不是内存缓存——这是跨进程正确性的关键：
   * 另一个 profile 刚写进去的任务不会被本进程的整份覆盖抹掉。
   * @param mutate 在锁内改写 draft；抛错则不写盘并把错误抛给调用方。
   */
  async mutate<T>(mutate: (draft: TaskStore) => T | Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const read = await this.readFromDisk(this.store.rootDir);

      let base: TaskStore;
      if (read.kind === 'ok') {
        base = read.store;
      } else if (read.kind === 'missing') {
        base = { version: TASK_STORE_VERSION, rootDir: this.store.rootDir, tasks: [] };
      } else {
        // 磁盘上是坏内容：先留下证据，再以本进程已知的记录为基准继续。
        await this.backupCorrupt();
        this.note(`${read.message}（已备份，本次以内存中的清单为基准）`);
        base = {
          version: TASK_STORE_VERSION,
          rootDir: this.store.rootDir,
          tasks: this.store.tasks.map((task) => ({ ...task })),
        };
      }

      const before = JSON.stringify(base);
      const result = await mutate(base);
      // 幂等写：内容没变就不落盘（例如 session/disposed 落在一个非任务会话上）。
      if (JSON.stringify(base) !== before) {
        await writeJsonAtomic(this.file, base);
      }
      this.store = base;
      return result;
    });
  }

  /** 立即把当前内存态落盘（启动修复路径用）。 */
  async persist(): Promise<void> {
    await writeJsonAtomic(this.file, this.store);
  }

  /* ─────────────────────────── 内部 ─────────────────────────── */

  /** 把一笔工作排进串行锁；锁本身不会因为某次失败而永久 reject。 */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 读盘并校验。**绝不在这里写盘**：修复策略由调用方决定——
   * startup 备份并重建、write 备份后以内存为基准、peek 只告警。
   */
  private async readFromDisk(fallbackRootDir: string): Promise<DiskRead> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { kind: 'missing' };
      return { kind: 'corrupt', message: `任务清单损坏：读取失败（${String(code ?? error)}）` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { kind: 'corrupt', message: `任务清单损坏：JSON 解析失败（${String(error)}）` };
    }

    if (!isRecord(parsed) || parsed.version !== TASK_STORE_VERSION || !Array.isArray(parsed.tasks)) {
      return { kind: 'corrupt', message: '任务清单损坏：结构不符合预期' };
    }

    const tasks: Task[] = [];
    let dropped = 0;
    for (const row of parsed.tasks) {
      const task = coerceTask(row);
      if (task === undefined) dropped += 1;
      else tasks.push(task);
    }
    if (dropped > 0) {
      this.note(`任务清单中有 ${dropped} 条记录无法解析，已忽略（文件未改动）`);
    }

    return {
      kind: 'ok',
      store: {
        version: TASK_STORE_VERSION,
        rootDir: str(parsed.rootDir) ?? fallbackRootDir,
        tasks,
      },
    };
  }

  /** 备份损坏文件为 `tasks.json.bak`（保留证据，供人工找回）。 */
  private async backupCorrupt(): Promise<boolean> {
    try {
      await copyFile(this.file, `${this.file}.bak`);
      return true;
    } catch {
      return false;
    }
  }
}
