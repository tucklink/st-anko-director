#!/usr/bin/env node
/**
 * ============================================================================
 *  npm run ask <关键词…>   —— 在文档里找已有结论（开工前先跑这个）
 * ============================================================================
 *  为什么有这个脚本：
 *    我在这个项目里反复犯的错是"先改代码、被纠正后才翻文档" ✗，
 *    而翻文档的成本高（5 个 md，几百行）正好是借口 ✗。
 *    这里把成本压到一条命令 ✓ —— 命中会直接给出 `文件:行: 原文` ✓。
 *
 *  用法：
 *    npm run ask 预设
 *    npm run ask max_tokens 预设
 *    npm run ask 钩子 hooks
 *
 *  多个关键词是 **OR** 关系 ✓；大小写不敏感 ✓；中文直接当子串搜 ✓。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 要搜的文件（按优先级） ✓ */
const TARGETS = [
    'AGENTS.md',
    'docs/INDEX.md',
    'docs/开发规范与踩坑清单.md',
    'docs/设计书.md',
    'docs/安科规则调研.md',
    'docs/独立桌面版.md',
    'README.md',
];

const MAX_PER_KEYWORD = Number(process.env.ANKO_ASK_MAX ?? 25);

const keywords = process.argv.slice(2).filter(Boolean);
if (keywords.length === 0) {
    console.error('用法：npm run ask <关键词…>     例：npm run ask 预设');
    process.exit(2);
}

const lower = keywords.map((k) => k.toLowerCase());
let total = 0;

for (const rel of TARGETS) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
        continue;
    }
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    const hits = [];
    lines.forEach((line, index) => {
        const text = line.toLowerCase();
        if (lower.some((k) => text.includes(k))) {
            hits.push({ line: index + 1, text: line.trim() });
        }
    });
    if (hits.length === 0) {
        continue;
    }
    console.log('');
    console.log(`=== ${rel}（${hits.length} 处）===`);
    for (const hit of hits.slice(0, MAX_PER_KEYWORD)) {
        const shown = hit.text.length > 120 ? hit.text.slice(0, 120) + '…' : hit.text;
        console.log(`  ${rel}:${hit.line}  ${shown}`);
    }
    if (hits.length > MAX_PER_KEYWORD) {
        console.log(`  … 还有 ${hits.length - MAX_PER_KEYWORD} 处（调 ANKO_ASK_MAX 可放宽）`);
    }
    total += hits.length;
}

console.log('');
if (total === 0) {
    console.error(`✗ 没有任何命中：${keywords.join(' / ')}`);
    console.error('  换个词再试（中文 / 英文 / 字段名都要试一遍）✓；');
    console.error('  仍然没有 → 说明确实是新问题，那时才去查外部资料 ✓。');
    process.exit(1);
}
console.log(`共 ${total} 处命中。结论以带 file:line 的为准 ✓。`);
