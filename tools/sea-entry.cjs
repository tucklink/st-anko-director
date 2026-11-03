/**
 * ============================================================================
 *  SEA 壳（单文件 exe 的入口）
 * ============================================================================
 *  背景（都是实测/查证来的，不是猜）：
 *    · 这台机器上 Electron 起不来 ✗：`FATAL:platform_channel.cc Check failed: 拒绝访问`
 *      → 环境禁止命名管道 ✓，所以放弃 Electron ✗
 *    · Node 24 自带 `--experimental-sea-config` ✓，但没有 `--build-sea` ✗（25.5 才有）
 *      → 走传统流程：生成 blob → 复制 node.exe → postject 注入 ✓
 *    · SEA 的注入脚本**不能 import 磁盘模块** ✗（Node 官方文档）
 *      但 **`createRequire(__filename)('./x.mjs')` 可以** ✓（Node 24 支持 require(esm)）
 *      → 所以这里把 src/*.js、renderer/index.html、server.mjs 作为 **assets** 打包，
 *        运行时解到临时目录，再 require 进来 ✓
 *
 *  这一步跑完，你就得到一个 **单文件、双击即用、不依赖 Electron** 的 exe ✓
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');

const sea = require('node:sea');

/** assets 里的键前缀，和 build-sea.mjs 里写的保持一致 ✓ */
const ASSET_PREFIX = 'app/';

/**
 * 挑一个**真的能写**的目录。
 *
 * ⚠️ 这里踩过坑 ✗：原来写死 `os.tmpdir()` ✓，但用户的 shell 里
 * `TEMP=C:\Users\PC\AppData\Local\Temp` —— 那个目录**不可写** ✗
 * （实测 `EPERM: operation not permitted, mkdir` ✓），
 * 于是 exe 一启动就死 ✓，日志只留一行 ✓，看起来像"什么都没发生" ✗。
 * 而我这边 DSH 给的 TEMP 是个可写子目录 ✓，所以我的测试**永远发现不了** ✗。
 *
 * 所以：**优先 exe 旁边的目录**（便携式 ✓，双击场景一定可写 ✓），
 * 每个候选都做一次"建目录 + 写文件 + 删文件"的真实探测 ✓，不许假设。
 */
function pickWritableDir(candidates) {
    const errors = [];
    for (const dir of candidates) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            const probe = path.join(dir, '.anko-write-probe');
            fs.writeFileSync(probe, 'ok');
            fs.unlinkSync(probe);
            return { dir, errors };
        } catch (error) {
            errors.push(dir + ' → ' + (error?.code ?? error?.message ?? error));
        }
    }
    return { dir: null, errors };
}

/** exe 路径的短指纹，用来隔离不同位置的 exe ✓ */
function exeStamp() {
    return Buffer.from(process.execPath).toString('base64url').slice(0, 12);
}

function extractAssets(workDir) {
    const keys = sea.getAssetKeys();
    let wrote = 0;
    for (const key of keys) {
        if (!key.startsWith(ASSET_PREFIX)) {
            continue;
        }
        const rel = key.slice(ASSET_PREFIX.length);
        const target = path.join(workDir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const data = sea.getAsset(key);
        fs.writeFileSync(target, Buffer.from(data));
        wrote += 1;
    }
    return wrote;
}

function main() {
    if (!sea.isSea()) {
        console.error('[x] 这个文件只有打包后运行才有意义（现在不在 SEA 环境里）');
        process.exit(1);
    }

    // ★ 日志与设置放在 **exe 所在目录**（便携式）✓
    //   为什么不用家目录 ✗：实测这台机器上 `%USERPROFILE%` 和 `%LOCALAPPDATA%`
    //   都 **不可写**（Access denied）✓ —— 而双击运行时 exe 目录一定可写 ✓。
    //   写不了就退回系统临时目录 ✓，并且**必须把失败打出来**，不许静默吞掉 ✗。
    const exeDir = path.dirname(process.execPath);
    const stamp = exeStamp();

    // ★ 日志与设置：优先 exe 旁边（便携式 ✓）
    const statePick = pickWritableDir([
        exeDir,
        path.join(os.homedir(), '.anko-director'),
        path.join(os.tmpdir(), 'anko-director-' + stamp),
    ]);
    const logPath = statePick.dir ? path.join(statePick.dir, 'anko-startup.log') : null;
    const settingsDir = statePick.dir ?? exeDir;

    const log = (msg) => {
        const line = '[' + new Date().toISOString() + '] ' + msg;
        console.error(line);
        if (logPath) {
            try {
                fs.appendFileSync(logPath, line + os.EOL);
            } catch {
                // 日志写不了不算致命 ✓
            }
        }
    };

    const workPick = pickWritableDir([
        path.join(exeDir, 'anko-runtime'),
        path.join(settingsDir, 'anko-runtime'),
        path.join(os.tmpdir(), 'anko-director-' + stamp),
    ]);

    log('=== 启动 ===');
    log('exe = ' + process.execPath);
    log('node = ' + process.version);
    log('cwd = ' + process.cwd());
    log('日志：' + (logPath ?? '(无可写目录，日志只在控制台)'));

    if (!workPick.dir) {
        log('[x] 找不到可写的解包目录 ✗');
        for (const line of workPick.errors) {
            log('    试过：' + line);
        }
        throw new Error('没有可写的解包目录');
    }
    for (const line of workPick.errors) {
        log('  （跳过不可写目录）' + line);
    }
    log('解包到：' + workPick.dir);

    const count = extractAssets(workPick.dir);
    log('解出 ' + count + ' 个文件');

    process.env.ANKO_SETTINGS = path.join(settingsDir, 'anko-settings.json');
    log('设置文件：' + process.env.ANKO_SETTINGS);

    const req = createRequire(path.join(workPick.dir, 'entry.cjs'));
    log('加载 server.mjs ...');
    req('./server.mjs');
    log('server.mjs 已加载 ✓');
}

try {
    main();
} catch (error) {
    console.error('');
    console.error('[x] 启动失败：' + (error && error.message ? error.message : error));
    console.error('    日志在 exe 同目录的 anko-startup.log');
    // ★ 关键：不要立刻退出 ✗ —— 双击运行时控制台会一闪而过 ✓，
    // 用户什么都看不见 ✓。这里停住等按键，让错误留在屏幕上 ✓。
    try {
        process.stdin.resume();
        console.error('');
        console.error('按 Ctrl+C 或关闭窗口退出。');
    } catch {
        // 拿不到 stdin 就算了（正常双击时通常拿得到 ✓）
    }
}
