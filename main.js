/**
 * ============================================================================
 *  安科导游 · 独立桌面版（Electron 主进程）
 * ============================================================================
 *  为什么要单独做一个 app：酒馆扩展那套（面板/命令/注入/世界书）离不开酒馆 ✓；
 *  但**骰子与导演引擎是纯 JS、只依赖注入的 rng/generate** ✓ —— 所以这里直接复用
 *  `src/` 里那几个模块，一行都不改 ✓。
 *
 *  能复用的：src/dice.js、src/rules.js、src/director.js、src/inline.js、
 *            src/option-table.js、src/prompts.js、src/combat.js、src/state.js、src/api.js
 *  不能复用的：index.js（面板/命令/酒馆事件）—— 那些在本文件里用 Electron 的 IPC 重做 ✓
 *
 *  ⚠️ 本文件放在**仓库根目录**，就是为了 `import './src/...'` 在
 *     「`electron .` 开发运行」和「打包成 exe」两种情况下都成立 ✓
 *     （如果把 app 放进子目录，打包时 ../src 会被漏掉 ✗ —— 这是踩过的经典坑 ✓）。
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { runDirector, describeError } from './src/director.js';
import { callChatApi, API_KINDS } from './src/api.js';
import { DIRECTOR_SYSTEM_PROMPT } from './src/prompts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 设置文件的默认值 —— 只要 baseURL/key/模型三项就能跑 ✓ */
const DEFAULT_SETTINGS = Object.freeze({
    apiKind: 'openai',      // 'openai' = OpenAI 兼容（含你的 custom 端点/OpenRouter）✓；'gemini' = Google 原生 ✓
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    model: '',
    temperature: null,      // null = 不传 ✓（推理型模型别乱设温度 ✓）
    maxTokens: null,        // null = 不传 ✓（思考 token 也吃这个额度 ✓，所以宁可交给服务商默认 ✓）
    maxRounds: 6,
    person: 'auto',
    hitMark: '♛',
});

let settingsPath = '';
let mainWindow = null;

async function readSettings() {
    try {
        const text = await fs.readFile(settingsPath, 'utf8');
        const parsed = JSON.parse(text);
        return { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

async function writeSettings(next) {
    const merged = { ...DEFAULT_SETTINGS, ...(next ?? {}) };
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1180,
        height: 820,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: '#14161a',
        title: '安科导游',
        webPreferences: {
            // 安全默认：渲染进程不能碰 Node ✓，所有能力走 preload 的窄接口 ✓
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            preload: path.join(HERE, 'preload.js'),
        },
    });
    mainWindow.loadFile(path.join(HERE, 'renderer', 'index.html'));
    mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
    settingsPath = path.join(app.getPath('userData'), 'anko-settings.json');
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// ---------------------------------------------------------------------------
// IPC：渲染进程只有这四个能力 ✓
// ---------------------------------------------------------------------------

ipcMain.handle('anko:getSettings', async () => readSettings());

ipcMain.handle('anko:saveSettings', async (_event, next) => writeSettings(next));

ipcMain.handle('anko:apiKinds', async () => Object.keys(API_KINDS));

/**
 * 跑一幕：把 `src/director.js` 的循环接到 Electron 上。
 *
 * 关键点：`generate` 是**注入**进去的 ✓ —— 引擎不知道自己在酒馆里还是在 exe 里 ✓。
 * 这里用 `src/api.js` 直连（exe 里没有 CORS 这回事 ✓，酒馆里那个"口子"在这儿是正路 ✓）。
 */
ipcMain.handle('anko:run', async (_event, payload) => {
    const settings = await readSettings();
    const userInput = String(payload?.userInput ?? '').trim();
    const history = String(payload?.history ?? '').trim();

    if (!userInput) {
        return { ok: false, error: '先在输入框里写玩家这一回合要做什么' };
    }
    if (!settings.apiKey) {
        return { ok: false, error: '先在设置里填 API Key' };
    }
    if (!settings.model) {
        return { ok: false, error: '先在设置里填模型名' };
    }

    const send = (channel, data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(channel, data);
        }
    };

    try {
        const result = await runDirector({
            userInput,
            // 前情摘要：这里先用纯文本 ✓（酒馆版那套 chatMetadata/世界书在 exe 里没有 ✓）
            contextBrief: history
                ? `# 前情（之前的定稿内容，照这个接着写）\n${history}`
                : '',
            // ⚠️ 不要传 `rng: Math.random` ✗ —— 引擎要的是 `(faces) => 1..faces 的整数` ✓
            // （不传就用 src/dice.js 的 defaultRng ✓；这是用假模型跑核心链路时抓出来的 ✓）
            // 轮数上限**不用自己夹**：`runDirector` 内部有 clampRounds ✓
            // （prompts.js 里的 clampBudget 是模块私有的，没有导出 ✗ —— 这是被验证脚本抓出来的 ✓）
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
            onProgress: (event) => send('anko:progress', {
                phase: event?.phase ?? '',
                round: event?.round ?? null,
                message: event?.message ?? '',
                rolls: Array.isArray(event?.rolls)
                    ? event.rolls.map((r) => ({ expr: r.expr, total: r.total, label: r.label ?? '' }))
                    : undefined,
            }),
        });

        return {
            ok: true,
            outline: result.outline,
            rounds: result.rounds,
            reason: result.reason,
            warnings: result.warnings ?? [],
            rolls: (result.rolls ?? []).map((r) => ({
                expr: r.expr,
                total: r.total,
                label: r.label ?? '',
                detail: r.detail ?? '',
            })),
        };
    } catch (error) {
        // 用引擎自己的 describeError ✓ —— 它会把"被抛出来的对象"也读成人话 ✓
        return { ok: false, error: describeError(error) || String(error) };
    }
});
