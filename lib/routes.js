import { messageOf } from './sessions.js';
import { ERROR_CODES } from './types.js';
/** 路由前缀。 */
export const API_PREFIX = '/dsh-temptask/api';
/** 请求体上限（这些接口的载荷都很小）。 */
const MAX_BODY_BYTES = 16 * 1024;
/* ─────────────────────────── HTTP 工具 ─────────────────────────── */
function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
    });
    res.end(body);
}
async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        size += buffer.length;
        if (size > MAX_BODY_BYTES)
            throw new Error('请求体过大');
        chunks.push(buffer);
    }
    if (size === 0)
        return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function asObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function asString(value) {
    return typeof value === 'string' ? value : '';
}
function asBoolean(value) {
    return value === true;
}
/** 判断 Host 是否是 loopback authority。 */
function isLoopbackAuthority(host) {
    const lower = host.toLowerCase();
    const name = lower.startsWith('[')
        ? lower.slice(0, lower.indexOf(']') + 1)
        : (lower.split(':')[0] ?? '');
    return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}
/** 请求是否可信（同源 + 非跨站 + loopback/已声明 authority）。 */
function isTrustedRequest(req, trustedHosts) {
    const host = req.headers.host;
    if (typeof host === 'string' && host.length > 0) {
        const trusted = isLoopbackAuthority(host) ||
            trustedHosts.some((entry) => entry.toLowerCase() === host.toLowerCase());
        if (!trusted)
            return false;
    }
    if (req.headers['sec-fetch-site'] === 'cross-site')
        return false;
    const origin = req.headers.origin;
    // 浏览器一定会带 Origin；缺失说明请求不是页面发出的（中间层代理会剥离它）。
    if (origin === undefined)
        return true;
    try {
        return new URL(origin).host === host;
    }
    catch {
        return false;
    }
}
/** 统一异常 → ApiError，保证接口永远返回 JSON。 */
function toApiError(error) {
    return { ok: false, code: ERROR_CODES.badRequest, message: messageOf(error) };
}
/* ─────────────────────────── 路由构造 ─────────────────────────── */
export function createRoutes(host) {
    const { manager } = host;
    /** 统一的处理器包装：方法检查 + 同源检查 + 启动等待 + JSON 响应。 */
    function route(path, method, impl) {
        return {
            path,
            async handle(req, res) {
                try {
                    if ((req.method ?? 'GET').toUpperCase() !== method) {
                        res.setHeader('allow', method);
                        sendJson(res, 405, { ok: false, code: ERROR_CODES.badRequest, message: `本接口只接受 ${method}` });
                        return;
                    }
                    if (!isTrustedRequest(req, host.trustedHosts())) {
                        sendJson(res, 403, {
                            ok: false,
                            code: ERROR_CODES.badRequest,
                            message: 'untrusted origin：请求来源不是本机回环或已声明的 authority',
                        });
                        return;
                    }
                    const body = method === 'POST' ? asObject(await readJsonBody(req)) : {};
                    await host.ready;
                    const result = await impl(body, req);
                    sendJson(res, 200, result);
                }
                catch (error) {
                    host.log('warn', `${path} 处理失败：${messageOf(error)}`);
                    sendJson(res, 200, toApiError(error));
                }
            },
        };
    }
    return [
        route(`${API_PREFIX}/state`, 'GET', async () => await manager.state()),
        // 新建：没有命名参数——目录名是时间戳，节点标题就是它（DSH 对工作区的默认行为）。
        route(`${API_PREFIX}/create`, 'POST', async () => await manager.create()),
        // 打开：接受任务 ID / 目录名 / 节点标题片段（与 /temptask open 同一套匹配）。
        route(`${API_PREFIX}/open`, 'POST', async (body) => {
            const query = asString(body.id).trim() || asString(body.query).trim();
            if (query.length === 0) {
                return { ok: false, code: ERROR_CODES.badRequest, message: '缺少任务 ID' };
            }
            return manager.open(query);
        }),
        route(`${API_PREFIX}/delete`, 'POST', async (body) => {
            const id = asString(body.id).trim();
            if (id.length === 0) {
                return { ok: false, code: ERROR_CODES.badRequest, message: '缺少任务 ID' };
            }
            if (!asBoolean(body.confirm)) {
                return {
                    ok: false,
                    code: ERROR_CODES.confirm,
                    message: '删除是不可恢复操作，需要二次确认',
                    hint: '客户端应弹出确认框后带 confirm: true 重试。',
                };
            }
            return manager.remove(id);
        }),
        route(`${API_PREFIX}/clean`, 'POST', async (body) => {
            if (!asBoolean(body.confirm)) {
                return {
                    ok: false,
                    code: ERROR_CODES.confirm,
                    message: '清理是不可恢复操作，需要二次确认',
                    hint: '客户端应弹出确认框后带 confirm: true 重试。',
                };
            }
            const ids = Array.isArray(body.ids)
                ? body.ids.filter((value) => typeof value === 'string')
                : undefined;
            const result = await manager.clean({ ids, all: asBoolean(body.all) });
            return result;
        }),
        route(`${API_PREFIX}/ack-open`, 'POST', async () => {
            manager.ackPendingOpen();
            return { ok: true };
        }),
        // 打开任务根目录（走官方 openWorkspacePath；无 GUI 宿主会返回 opened:false + 原因，
        // 客户端据此退回「复制根目录」）。
        // 注意 `ok: true` 这层信封不能省：客户端按 ApiResult 解析，缺了它会把"打开成功"当失败。
        route(`${API_PREFIX}/open-root`, 'POST', async () => ({ ok: true, ...(await host.openRoot()) })),
        route(`${API_PREFIX}/config`, 'POST', async (body) => host.writeLocalConfig({
            ...(typeof body.rootDir === 'string' ? { rootDir: body.rootDir } : {}),
            ...(typeof body.autoCleanDays === 'number' || typeof body.autoCleanDays === 'string'
                ? { autoCleanDays: Number(body.autoCleanDays) }
                : {}),
            ...(body.onDeleteSessions === 'archive' || body.onDeleteSessions === 'keep'
                ? { onDeleteSessions: body.onDeleteSessions }
                : {}),
        })),
    ];
}
