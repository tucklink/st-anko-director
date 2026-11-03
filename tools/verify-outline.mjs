/**
 * ============================================================================
 *  大纲体检 —— 拿一段插件产出的成品大纲，独立核一遍
 * ============================================================================
 *  用途：你贴一段大纲过来问"这个对吗"，或者自己怀疑哪里不对时，不用肉眼数格子。
 *
 *  **刻意不复用 `src/option-table.js`** —— 那份逻辑正是要被验证的对象，用它来验等于自证。
 *  这里重新朴素实现一遍：找结果 → 往回读表 → 独立做算术校验。
 *
 *  检查项：
 *    1. 每张选项表：区间是否从 1 连续铺满、末项是否「大成功/大失败」
 *    2. ♛ 是否恰好一行、是否落在包含骰值的那一行
 *    3. 每两个骰子之间的正文字数（收紧的核心指标）
 *    4. 大纲是不是停在一个没解释的骰子上（戛然而止）
 *
 *  用法：node tools/verify-outline.mjs <大纲文件> [--prose-limit=80]
 * ============================================================================
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const limitArg = args.find((a) => a.startsWith('--prose-limit='));
const PROSE_LIMIT = limitArg ? Number(limitArg.split('=')[1]) : 80;

if (!file) {
    console.error('用法：node tools/verify-outline.mjs <大纲文件> [--prose-limit=80]');
    process.exit(2);
}

const text = readFileSync(file, 'utf8');
const lines = text.split('\n');

const RANGE_ROW = /^\s*(\d+)\s*[-–—~〜～]\s*(\d+)\s*[.、,:：)）]?\s*(\S.*)$/;
const SINGLE_ROW = /^\s*(\d+)(?:\s*[.、,:：)）]\s*|\s+)(\S.*)$/;
const CONNECTOR_ROW = /^[→←\-–—>:：\s]+$/;
const RESULT_G = /【(\d+)[dD](\d+)=(\d+)/g;
const ANY_BRACKET = /【[^】]*】/g;

// ---------------------------------------------------------------------------
// 找骰子结果
// ---------------------------------------------------------------------------

const results = [];
for (let i = 0; i < lines.length; i += 1) {
    const re = new RegExp(RESULT_G.source, 'g');
    let match;
    while ((match = re.exec(lines[i])) !== null) {
        results.push({
            line: i,
            faceCount: Number(match[1]),
            faces: Number(match[2]),
            value: Number(match[3]),
            start: match.index,
        });
    }
}

// ---------------------------------------------------------------------------
// 从结果位置往回读一张选项表
// ---------------------------------------------------------------------------

function readTableBefore(before) {
    const rows = [];
    let header = null;
    let phase = 'tail';

    for (const raw of before.split('\n').reverse()) {
        const trimmed = raw.trim();
        if (trimmed === '') {
            continue;
        }
        if (phase === 'tail' && CONNECTOR_ROW.test(trimmed)) {
            continue;
        }

        const range = RANGE_ROW.exec(raw);
        if (range) {
            rows.unshift({ from: Number(range[1]), to: Number(range[2]), text: range[3] });
            phase = 'rows';
            continue;
        }
        const single = SINGLE_ROW.exec(raw);
        if (single) {
            rows.unshift({ from: Number(single[1]), to: Number(single[1]), text: single[2] });
            phase = 'rows';
            continue;
        }

        header = trimmed;
        break;
    }

    return { rows, header };
}

// ---------------------------------------------------------------------------
// 1 & 2：逐张表校验
// ---------------------------------------------------------------------------

const report = [];
let problems = 0;
let tableCount = 0;

const pass = (m) => report.push(`    ✓ ${m}`);
const fail = (m) => { problems += 1; report.push(`    ✗ ${m}`); };

for (const result of results) {
    const before = `${lines.slice(0, result.line).join('\n')}\n${lines[result.line].slice(0, result.start)}`;
    const { rows, header } = readTableBefore(before);
    if (rows.length === 0) {
        continue;
    }

    tableCount += 1;
    report.push(`\n【表 ${tableCount}】第 ${result.line + 1} 行「${header ?? '无表头'}」`
        + ` → ${result.faceCount}d${result.faces} = ${result.value}`);

    const sorted = [...rows].sort((a, b) => a.from - b.from);
    let expected = 1;
    let coverage = sorted.length > 0 && sorted[0].from === 1;
    if (coverage) {
        for (const row of sorted) {
            if (row.from !== expected) { coverage = false; break; }
            expected = row.to + 1;
        }
    }
    if (coverage) {
        pass(`区间从 1 连续铺满到 ${expected - 1}（共 ${rows.length} 行）`);
    } else {
        fail(`区间没有从 1 连续铺满：${sorted.map((r) => `${r.from}-${r.to}`).join(' ')}`);
    }

    const last = sorted[sorted.length - 1];
    if (last && /大成功/.test(last.text) && /大失败/.test(last.text)) {
        pass(`末项（${last.from}-${last.to}）是大成功/大失败`);
    } else {
        fail(`末项不是「大成功/大失败」：${last ? last.text : '(空)'}`);
    }

    const marked = rows.filter((row) => row.text.trimEnd().endsWith('♛'));
    if (marked.length === 0) {
        fail('没有任何一行带 ♛');
    } else if (marked.length > 1) {
        fail(`有 ${marked.length} 行带 ♛（应该只有 1 行）`);
    } else {
        const hit = marked[0];
        if (result.value >= hit.from && result.value <= hit.to) {
            pass(`♛ 落在正确的一行：${hit.from}-${hit.to}（含 ${result.value}）`);
        } else {
            fail(`♛ 标错了：标在 ${hit.from}-${hit.to}，但骰值是 ${result.value}`);
        }
        const others = rows.filter((row) => row !== hit
            && result.value >= row.from && result.value <= row.to);
        if (others.length > 0) {
            fail(`另有 ${others.length} 行也覆盖骰值却没标`);
        }
    }
}

// ---------------------------------------------------------------------------
// 3：两个骰子之间的正文字数（"收紧"的核心指标）
// ---------------------------------------------------------------------------

/** 表格行、表头、请求行都不算正文。 */
function isTableNoise(line) {
    const trimmed = line.trim();
    if (trimmed === '') return true;
    if (RANGE_ROW.test(line) || SINGLE_ROW.test(line)) return true;
    if (/选项骰十项|选项表/.test(trimmed)) return true;
    if (CONNECTOR_ROW.test(trimmed)) return true;
    return false;
}

const proseChunks = [];
let current = '';
for (const line of lines) {
    if (isTableNoise(line)) {
        continue;
    }
    // 骰子结果当分隔符：结果之前归这一段，之后归下一段
    const re = new RegExp(RESULT_G.source, 'g');
    let lastIndex = 0;
    let match;
    while ((match = re.exec(line)) !== null) {
        const close = line.indexOf('】', match.index);
        const end = close >= 0 ? close + 1 : match.index + match[0].length;
        current += line.slice(lastIndex, match.index);
        proseChunks.push(current);
        current = '';
        lastIndex = end;
        re.lastIndex = end; // 跳过整个【…】，免得里面的数字被当成第二个结果
    }
    current += line.slice(lastIndex);
}
proseChunks.push(current);

const proseness = proseChunks
    .map((chunk) => chunk.replace(ANY_BRACKET, '').replace(/\s/g, ''))
    .filter((chunk) => chunk.length > 0);

const maxProse = proseness.length > 0 ? Math.max(...proseness.map((c) => c.length)) : 0;
const avgProse = proseness.length > 0
    ? Math.round(proseness.reduce((sum, c) => sum + c.length, 0) / proseness.length)
    : 0;
const overLimit = proseness.filter((chunk) => chunk.length > PROSE_LIMIT);

report.push('\n【大纲紧致度】两个骰子之间的正文字数');
report.push(`    段数 ${proseness.length} · 最长 ${maxProse} · 平均 ${avgProse} · 上限 ${PROSE_LIMIT}`);
if (overLimit.length === 0) {
    pass('每一段都在上限内');
} else {
    report.push(`    ⚠ ${overLimit.length} 段超过 ${PROSE_LIMIT} 字：`
        + overLimit.map((c) => c.length).join(', '));
}

// ---------------------------------------------------------------------------
// 4：结尾是不是停在一个没解释的骰子上
// ---------------------------------------------------------------------------

report.push('\n【收尾】');
const tail = text.trimEnd();
if (new RegExp(`${ANY_BRACKET.source}$`).test(tail)) {
    fail('大纲**停在一个骰子结果上**，后面没有解释 —— 说明轮数被吃光了');
} else {
    pass('结尾是正文，不是光秃秃的骰子');
}

// ---------------------------------------------------------------------------

console.log(report.join('\n'));
console.log(`\n—— 共 ${results.length} 个骰子结果，其中 ${tableCount} 张选项表 ——`);
console.log(problems === 0 ? '结论：全部正确 ✓' : `结论：发现 ${problems} 个问题 ✗`);
process.exitCode = problems === 0 ? 0 : 1;
