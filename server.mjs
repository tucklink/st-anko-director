/**
 * ============================================================================
 *  安科导游 · 本地网页版服务（不依赖 Electron）
 * ============================================================================
 *  为什么有这条路：
 *    Electron 在本机起不来 —— 不是代码问题，是环境禁止命名管道：
 *      FATAL:platform_channel.cc(89) Check failed: 拒绝访问 (0x5)
 *    实测 v22 / v28 / v32 全部在原生初始化阶段崩（连 --version 都崩）✗
 *  而 **Node 本身跑得好好的** ✓，所以改成：
 *      node server.mjs  →  起本地 HTTP 服务  →  用系统浏览器打开  →  能玩 ✓
 *
 *  与 Electron 版共用同一套引擎（src/*.js），一行不改 ✓。
 *  也没有 CORS 问题：页面和服务同源 ✓。
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

import { runDirector, describeError } from './src/director.js';
import { callChatApi, API_KINDS } from './src/api.js';
import { DIRECTOR_SYSTEM_PROMPT } from './src/prompts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 设置文件路径可由环境变量覆盖 ✓ —— 打包成 exe 后，解包目录会被清理 ✗，
// 所以 SEA 壳会把它指到 ~/.anko-director/ ✓（见 tools/sea-entry.cjs）
const SETTINGS_PATH = process.env.ANKO_SETTINGS || path.join(HERE, 'anko-settings.json');
const PORT = Number(process.env.ANKO_PORT ?? 8123);

const DEFAULT_SETTINGS = {
    apiKind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    model: '',
    temperature: null,
    maxTokens: null,
    maxRounds: 6,
    person: 'auto',
    hitMark: '♛',
};

async function readSettings() {
    try {
        const text = await fs.readFile(SETTINGS_PATH, 'utf8');
        return { ...DEFAULT_SETTINGS, ...JSON.parse(text) };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

async function writeSettings(next) {
    const merged = { ...DEFAULT_SETTINGS, ...(next ?? {}) };
    await fs.writeFile(SETTINGS_PATH, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
}

function json(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store',
    });
    res.end(text);
}

async function readBody(req, limit = 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) {
            throw new Error('请求体过大');
        }
        chunks.push(chunk);
    }
    if (chunks.length === 0) {
        return {};
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new Error('请求体不是合法 JSON');
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
};

async function serveStatic(res, urlPath) {
    const rel = urlPath === '/' ? '/index.html' : urlPath;
    // 只允许 renderer 目录里的文件（防目录穿越 ✓）
    const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(HERE, 'renderer', safe);
    if (!filePath.startsWith(path.join(HERE, 'renderer'))) {
        res.writeHead(403).end('forbidden');
        return;
    }
    try {
        const data = await fs.readFile(filePath);
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
            'Cache-Control': 'no-store',
        });
        res.end(data);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not found');
    }
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

    try {
        if (url.pathname === '/api/settings' && req.method === 'GET') {
            json(res, 200, await readSettings());
            return;
        }
        if (url.pathname === '/api/settings' && req.method === 'POST') {
            json(res, 200, await writeSettings(await readBody(req)));
            return;
        }
        if (url.pathname === '/api/kinds' && req.method === 'GET') {
            json(res, 200, Object.keys(API_KINDS));
            return;
        }
        if (url.pathname === '/api/run' && req.method === 'POST') {
            const body = await readBody(req);
            const settings = await readSettings();
            const userInput = String(body?.userInput ?? '').trim();
            const history = String(body?.history ?? '').trim();

            if (!userInput) {
                json(res, 400, { ok: false, error: '先在输入框里写玩家这一回合要做什么' });
                return;
            }
            if (!settings.apiKey) {
                json(res, 400, { ok: false, error: '先在设置里填 API Key' });
                return;
            }
            if (!settings.model) {
                json(res, 400, { ok: false, error: '先在设置里填模型名' });
                return;
            }

            const result = await runDirector({
                userInput,
                contextBrief: history ? `# 前情（之前的定稿内容，照这个接着写）\n${history}` : '',
                // 不传 rng：用 src/dice.js 的 defaultRng ✓（传 Math.random 会越界崩 ✓）
                maxRounds: settings.maxRounds,
                person: settings.person,
                hitMark: settings.hitMark,
                systemPrompt: DIRECTOR_SYSTEM_PROMPT,
                generate: async (request) => callChatApi({
                    kind: settings.apiKind,
                    baseUrl: settings.baseUrl,
                    apiKey: settings.apiKey,
                    model: settings.model,
                    systemPrompt: request.systemPrompt,
                    prompt: request.prompt,
                    prefill: request.prefill,
                    temperature: Number.isFinite(settings.temperature) ? settings.temperature : null,
                    maxTokens: Number.isFinite(settings.maxTokens) && settings.maxTokens > 0
                        ? settings.maxTokens
                        : null,
                }),
            });

            json(res, 200, {
                ok: true,
                outline: result.outline,
                rounds: result.rounds,
                reason: result.reason,
                warnings: result.warnings ?? [],
                rolls: (result.rolls ?? []).map((r) => ({
                    expr: r.expr, total: r.total, label: r.label ?? '', detail: r.detail ?? '',
                })),
            });
            return;
        }
        if (req.method === 'GET') {
            await serveStatic(res, url.pathname);
            return;
        }
        res.writeHead(405).end('method not allowed');
    } catch (error) {
        json(res, 500, { ok: false, error: describeError(error) || String(error) });
    }
});

server.on('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
        console.error('');
        console.error('[!] 端口 ' + PORT + ' 已被占用（可能已经开着一个了）');
        console.error('    换一个端口重试：设置环境变量 ANKO_PORT，例如');
        console.error('      set ANKO_PORT=8124 && 安科导游.exe');
        return;
    }
    console.error('[x] 服务启动失败：' + (error?.message ?? error));
});

server.listen(PORT, '127.0.0.1', () => {
    const address = `http://127.0.0.1:${PORT}/`;
    console.log('');
    console.log('  ==================================================');
    console.log('   安科导游已启动 ✓');
    console.log('');
    console.log('   在浏览器里打开这个地址：');
    console.log('     ' + address);
    console.log('');
    console.log('   设置文件：' + SETTINGS_PATH);
    console.log('   关掉这个窗口就停止服务');
    console.log('  ==================================================');
    console.log('');

    // 自动打开浏览器 —— **必须包在 try/catch 里** ✗：
    // 受限环境里 child_process.spawn 会抛 EPERM ✓，若不捕获，
    // 它会把这个 HTTP 服务一起带崩 ✗（本文件第一版就是这么崩的 ✓）。
    // 打不开也不影响使用：用户手动复制地址即可 ✓。
    if (process.platform === 'win32' && process.env.ANKO_NO_OPEN !== '1') {
        let opened = false;
        try {
            execFile('cmd', ['/c', 'start', '', address], (error) => {
                if (error) {
                    console.log('  （自动打开浏览器失败：' + (error.message ?? error) + '）');
                    console.log('  （请手动复制上面的地址到浏览器）');
                }
            });
            opened = true;
        } catch (error) {
            console.log('  （自动打开浏览器失败：' + (error?.message ?? error) + '）');
        }
        if (!opened) {
            console.log('  （请手动复制上面的地址到浏览器）');
        }
    }
});
