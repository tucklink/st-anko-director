/**
 * ============================================================================
 *  安科导游 · 独立桌面版（Electron 主进程 · CommonJS 版）
 * ============================================================================
 *  为什么是 `.cjs` 而不是 ESM ✗：
 *    本机 npm 镜像实际给到的 Electron 是 **v20.18.1**（`--version` 实测 ✓），
 *    而 **ESM 主进程要 Electron ≥28** 才支持 ✓ —— v20 下 ESM main 直接崩：
 *      `TypeError: Cannot read properties of undefined (reading 'exports')`
 *  所以主进程用 **CJS** ✓ —— 然后用**动态 `import()`** 去加载 ESM 的 `src/*.js` ✓
 *  （CJS 里 `await import(esm)` 在 Node 20 里是合法的 ✓）。
 *  这样既不依赖 Electron 版本，也不用把引擎改成 CJS ✓。
 *
 *  其余设计与 ESM 版一致：窗口 + 四个 IPC ✓；渲染进程只能通过 preload 的窄接口 ✓。
 */

'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const HERE = __dirname;

/** 引擎是 ESM ✓ —— 用动态 import 加载（只加载一次，缓存起来 ✓） */
let enginePromise = null;
function loadEngine() {
    if (!enginePromise) {
        enginePromise = (async () => {
            const [{ runDirector, describeError }, { callChatApi, API_KINDS }, prompts] = await Promise.all([
                import('./src/director.js'),
                import('./src/api.js'),
                import('./src/prompts.js'),
            ]);
            return {
                runDirector,
                describeError,
                callChatApi,
                API_KINDS,
                DIRECTOR_SYSTEM_PROMPT: prompts.DIRECTOR_SYSTEM_PROMPT,
            };
        })();
    }
    return enginePromise;
}

const DEFAULT_SETTINGS = Object.freeze({
    apiKind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    model: '',
    temperature: null,
    maxTokens: null,
    maxRounds: 6,
    person: 'auto',
    hitMark: '♛',
});

let settingsPath = '';
let mainWindow = null;

async function readSettings() {
    try {
        const text = await fs.readFile(settingsPath, 'utf8');
        return { ...DEFAULT_SETTINGS, ...JSON.parse(text) };
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
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            preload: path.join(HERE, 'preload.cjs'),
        },
    });
    mainWindow.loadFile(path.join(HERE, 'renderer', 'index.html'));
    mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
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

ipcMain.handle('anko:getSettings', async () => readSettings());
ipcMain.handle('anko:saveSettings', async (_event, next) => writeSettings(next));
ipcMain.handle('anko:apiKinds', async () => {
    const { API_KINDS } = await loadEngine();
    return Object.keys(API_KINDS);
});

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
        const engine = await loadEngine();
        const result = await engine.runDirector({
            userInput,
            contextBrief: history ? `# 前情（之前的定稿内容，照这个接着写）\n${history}` : '',
            // ⚠️ 这里**不要**传 `rng: Math.random` ✗ ——
            // 引擎要的随机源签名是 `(faces) => 1..faces 的整数` ✓，
            // 直接给 Math.random 会让它返回 0.5 这类越界值 → 抛
            // `DiceError: 随机源返回了越界值 0.5（本应为 1..10）` ✓
            // （这是用假模型跑核心链路时抓出来的，一推演就炸 ✓）
            // 不传就自动用 src/dice.js 的 defaultRng ✓
            maxRounds: settings.maxRounds,
            person: settings.person,
            hitMark: settings.hitMark,
            systemPrompt: engine.DIRECTOR_SYSTEM_PROMPT,
            generate: async (request) => engine.callChatApi({
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
        const engine = await loadEngine().catch(() => null);
        const describe = engine?.describeError ?? ((e) => String(e && e.message ? e.message : e));
        return { ok: false, error: describe(error) };
    }
});
