/**
 * ============================================================================
 *  把 安科导游 打包成**单文件 exe**（Node SEA，不依赖 Electron）
 * ============================================================================
 *  为什么不用 Electron：这台机器上 Electron 起不来 ✗
 *      FATAL:platform_channel.cc(89) Check failed: 拒绝访问 (0x5)
 *    环境禁止命名管道 ✓（实测 v22/v28/v32 全崩，连 --version 都崩）
 *
 *  为什么用 SEA：Node 24 自带 `--experimental-sea-config` ✓（但没有 --build-sea ✗）
 *    流程：生成 blob → 复制 node.exe → 用 postject 注入 ✓
 *
 *  为什么要把源码作为 assets：SEA 的注入脚本**不能 import 磁盘模块** ✗
 *    但 `createRequire(__filename)('./x.mjs')` 可以 ✓（Node 24 支持 require(esm) ✓）
 *    → 壳（tools/sea-entry.cjs）运行时把 assets 解到临时目录再 require ✓
 *
 *  跑法：node tools/build-sea.mjs
 *  产物：dist-app/安科导游.exe
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(ROOT, 'dist-app');
const BUILD_DIR = path.join(ROOT, '.sea-build');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/** 要打进 exe 的文件（相对 ROOT）✓ */
const APP_FILES = [
    'server.mjs',
    'src/dice.js',
    'src/rules.js',
    'src/inline.js',
    'src/option-table.js',
    'src/prompts.js',
    'src/director.js',
    'src/combat.js',
    'src/state.js',
    'src/api.js',
    'renderer/index.html',
];

function log(msg) {
    console.log('  ' + msg);
}

function step(title) {
    console.log('');
    console.log('=== ' + title + ' ===');
}

async function main() {
    step('1) 检查前置条件');
    log('Node ' + process.version);
    if (!fs.existsSync(path.join(ROOT, 'node_modules', 'postject'))) {
        console.error('  ✗ 缺少 postject。先执行：npm install postject --ignore-scripts');
        process.exit(1);
    }
    for (const rel of APP_FILES) {
        if (!fs.existsSync(path.join(ROOT, rel))) {
            console.error('  ✗ 缺文件：' + rel);
            process.exit(1);
        }
    }
    log('要打包 ' + APP_FILES.length + ' 个文件 ✓');

    step('2) 准备构建目录');
    fs.rmSync(BUILD_DIR, { recursive: true, force: true });
    fs.mkdirSync(BUILD_DIR, { recursive: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const assets = {};
    for (const rel of APP_FILES) {
        // assets 的键统一加 app/ 前缀，和 tools/sea-entry.cjs 里的 ASSET_PREFIX 对应 ✓
        assets['app/' + rel.split(path.sep).join('/')] = path.join(ROOT, rel);
    }

    step('3) 生成 SEA blob');
    const configPath = path.join(BUILD_DIR, 'sea-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
        main: path.join(ROOT, 'tools', 'sea-entry.cjs'),
        output: path.join(BUILD_DIR, 'sea-prep.blob'),
        disableExperimentalSEAWarning: true,
        assets,
    }, null, 2), 'utf8');
    log('配置写好：' + configPath);

    // 注意：这一步是 **node 自己**做的 ✓，不 spawn 子进程 ✓
    const { execFileSync: runNode } = await import('node:child_process');
    try {
        runNode(process.execPath, ['--experimental-sea-config', configPath], {
            cwd: ROOT,
            stdio: 'inherit',
        });
    } catch (error) {
        console.error('  ✗ 生成 blob 失败：' + (error?.message ?? error));
        process.exit(1);
    }
    const blobPath = path.join(BUILD_DIR, 'sea-prep.blob');
    if (!fs.existsSync(blobPath)) {
        console.error('  ✗ 没生成 blob');
        process.exit(1);
    }
    log('blob 大小：' + (fs.statSync(blobPath).size) + ' 字节 ✓');

    step('4) 复制 node.exe 作为基底');
    const exePath = path.join(OUT_DIR, '安科导游.exe');
    fs.copyFileSync(process.execPath, exePath);
    log('基底：' + (fs.statSync(exePath).size / 1024 / 1024).toFixed(1) + ' MB');

    step('5) 注入 blob（postject API，不用 spawn）');
    const apiPath = path.join(ROOT, 'node_modules', 'postject', 'dist', 'api.js');
    const { inject } = await import('file://' + apiPath.replace(/\\/g, '/'));
    const { constants } = fs;
    await inject(exePath, 'NODE_SEA_BLOB', fs.readFileSync(blobPath), {
        sentinelFuse: FUSE,
    });
    log('注入完成 ✓');

    step('6) 结果');
    const size = fs.statSync(exePath).size;
    log('产物：' + exePath);
    log('大小：' + (size / 1024 / 1024).toFixed(1) + ' MB');
    log('用法：双击它 → 浏览器自动打开 → 填 API Key 就能玩 ✓');
}

main().catch((error) => {
    console.error('');
    console.error('[x] 打包失败：' + (error?.stack ?? error));
    process.exit(1);
});
