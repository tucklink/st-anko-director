import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_HIT_MARK,
    coversFromOne,
    isHeaderLike,
    markOptionHits,
    markRowBefore,
    parseOptionRow,
} from '../src/option-table.js';

/** 一张标准的孔明式十项表（每项独占一行）。 */
const TABLE = [
    '先去哪边打听 —— 选项骰十项：',
    '1-3 酒馆',
    '4-6 货栈',
    '7-9 码头管事',
    '10 【1D2】大成功/大失败',
    '→ ',
].join('\n');

// ---------------------------------------------------------------------------
// 认行
// ---------------------------------------------------------------------------

test('认区间行', () => {
    assert.deepEqual(parseOptionRow('1-3 酒馆'), { from: 1, to: 3, text: '酒馆' });
    assert.deepEqual(parseOptionRow('  7 – 9 码头管事'), { from: 7, to: 9, text: '码头管事' });
    assert.deepEqual(parseOptionRow('1～3 酒馆'), { from: 1, to: 3, text: '酒馆' });
    assert.deepEqual(parseOptionRow('1-3. 酒馆'), { from: 1, to: 3, text: '酒馆' });
});

test('认单值行', () => {
    assert.deepEqual(parseOptionRow('10 【1D2】大成功/大失败'), { from: 10, to: 10, text: '【1D2】大成功/大失败' });
    assert.deepEqual(parseOptionRow('1. 酒馆'), { from: 1, to: 1, text: '酒馆' });
    assert.deepEqual(parseOptionRow('3、码头'), { from: 3, to: 3, text: '码头' });
    assert.deepEqual(parseOptionRow('5）甲板'), { from: 5, to: 5, text: '甲板' });
});

test('不是选项行的一律不认', () => {
    assert.equal(parseOptionRow('选项骰十项：'), null);
    assert.equal(parseOptionRow('→ '), null);
    assert.equal(parseOptionRow('他走了。'), null);
    assert.equal(parseOptionRow(''), null);
    assert.equal(parseOptionRow(null), null);
    assert.equal(parseOptionRow('9-3 倒过来的区间'), null, 'from > to 要拒绝');
});

// ---------------------------------------------------------------------------
// 铺满校验（防误伤的关键）
// ---------------------------------------------------------------------------

test('铺满 1..N 才算选项表', () => {
    assert.equal(coversFromOne([
        { from: 1, to: 3 }, { from: 4, to: 6 }, { from: 7, to: 9 }, { from: 10, to: 10 },
    ]), true);

    assert.equal(coversFromOne([{ from: 1, to: 1 }, { from: 2, to: 2 }, { from: 3, to: 3 }]), true,
        '每行一个数字也算');

    assert.equal(coversFromOne([{ from: 2, to: 2 }, { from: 3, to: 3 }]), false, '不从 1 开始');
    assert.equal(coversFromOne([{ from: 1, to: 3 }, { from: 5, to: 6 }]), false, '中间有洞');
    assert.equal(coversFromOne([{ from: 1, to: 3 }, { from: 3, to: 5 }]), false, '有重叠');
    assert.equal(coversFromOne([]), false, '空表');
});

test('★ 正文里普通的编号列表不会被当成选项表（第二道闸：表头）', () => {
    // 这是最容易被误伤的形状：正文里的 1/2 讨论，编号也恰好从 1 连续铺满
    const prose = [
        '他给了三条路让我选。',
        '1 走吧',
        '2 留下',
        '→ ',
    ].join('\n');
    assert.equal(markRowBefore(`${prose}【1d10=2】`, prose.length, 2), null,
        '上一行不像表头、又只有两行 → 不该打标');
});

test('表头像表头（含"选项/骰/表/项"或以冒号结尾）就够了', () => {
    const withColon = ['他顿了顿：', '1 走吧', '2 留下', '→ '].join('\n');
    assert.match(markRowBefore(`${withColon}【1d10=2】`, withColon.length, 2).text, /2 留下 ♛/);

    assert.equal(isHeaderLike('先去哪边打听 —— 选项骰十项：'), true);
    assert.equal(isHeaderLike('大失败效果表'), true);
    assert.equal(isHeaderLike('今晚吃什么：'), true);
    assert.equal(isHeaderLike('他给了三条路让我选。'), false);
    assert.equal(isHeaderLike('他往前走了几步，然后停下来'), false);
    assert.equal(isHeaderLike(''), false);
});

test('没有表头、但行数够多（≥5）也认', () => {
    const rows = Array.from({ length: 5 }, (_, i) => `${i + 1} 第${i + 1}项`).join('\n');
    const text = `上一段正文。\n${rows}\n→ 【1d10=3】`;
    assert.match(markRowBefore(text, text.indexOf('【1d10=3】'), 3).text, /3 第3项 ♛/);
});

test('正文开头就是表格（没有表头行）也认', () => {
    const text = '1-2 甲\n3-4 乙\n→ 【1d4=3】';
    assert.match(markRowBefore(text, text.indexOf('【1d4=3】'), 3).text, /3-4 乙 ♛/);
});

// ---------------------------------------------------------------------------
// 打标
// ---------------------------------------------------------------------------

test('★ 命中行会被打上 ♛', () => {
    const marked = markRowBefore(`${TABLE}【1d10=7】`, TABLE.length, 7).text;
    assert.ok(marked);
    assert.match(marked, /7-9 码头管事 ♛/);
    assert.ok(!marked.includes('1-3 酒馆 ♛'), '别的行不该被打标');
    assert.ok(marked.endsWith('【1d10=7】'), '结果本身要原样保留');
});

test('打标不会吃掉原来的缩进与结果', () => {
    const text = '选项：\n  1-3 甲\n  4-6 乙\n  7-9 丙\n  10 丁\n→ 【1d10=7】';
    const marked = markRowBefore(text, text.indexOf('【1d10=7】'), 7).text;
    assert.equal(marked, '选项：\n  1-3 甲\n  4-6 乙\n  7-9 丙 ♛\n  10 丁\n→ 【1d10=7】');
});

test('投出最后一项（大成功/大失败）时标在第 10 行', () => {
    const marked = markRowBefore(`${TABLE}【1d10=10 → 1d2=2（大失败）】`, TABLE.length, 10).text;
    assert.match(marked, /10 【1D2】大成功\/大失败 ♛/);
});

test('已经标过就不再叠第二个', () => {
    const once = markRowBefore(`${TABLE}【1d10=7】`, TABLE.length, 7).text;
    assert.equal(markRowBefore(once, once.indexOf('【1d10=7】'), 7).status, 'already', '命中行本来就标着 → 算 already');
});

test('认不出表就什么都不做', () => {
    const noTable = '他往前走了几步。\n→ ';
    assert.equal(markRowBefore(`${noTable}【1d10=7】`, noTable.length, 7), null);
});

test('表有洞时宁可不标', () => {
    const gapped = ['选项：', '1-3 甲', '5-6 乙', '→ '].join('\n');
    assert.equal(markRowBefore(`${gapped}【1d10=2】`, gapped.length, 2), null);
});

test('自定义符号', () => {
    const marked = markRowBefore(`${TABLE}【1d10=7】`, TABLE.length, 7, { mark: '★' }).text;
    assert.match(marked, /7-9 码头管事 ★/);
});

test('空符号 = 关掉打标', () => {
    assert.equal(markRowBefore(`${TABLE}【1d10=7】`, TABLE.length, 7, { mark: '' }), null);
});

test('默认符号就是 ♛', () => {
    assert.equal(DEFAULT_HIT_MARK, '♛');
});

// ---------------------------------------------------------------------------
// 批量
// ---------------------------------------------------------------------------

test('两张表各标各的（用精确下标，从后往前打）', () => {
    const first = '第一张：\n1-2 甲\n3-4 乙\n→ ';
    const second = '第二张：\n1-2 丙\n3-4 丁\n→ ';
    const gap = '中间还有一段正文。\n';
    const head = `${first}【1d4=3】\n${gap}${second}`;
    const text = `${head}【1d4=1】`;

    const at1 = first.length;
    const at2 = head.length;

    const result = markOptionHits(text, [
        { replacement: '【1d4=3】', value: 3, at: at1 },
        { replacement: '【1d4=1】', value: 1, at: at2 },
    ]);

    assert.equal(result.marked, 2);
    assert.match(result.text, /3-4 乙 ♛/);
    assert.match(result.text, /1-2 丙 ♛/);
    assert.ok(!/1-2 甲 ♛/.test(result.text));
    assert.ok(!/3-4 丁 ♛/.test(result.text));
});

test('没有 at 时退回按顺序 indexOf 找', () => {
    const text = `${TABLE}【1d10=7】`;
    const result = markOptionHits(text, [{ replacement: '【1d10=7】', value: 7 }]);
    assert.equal(result.marked, 1);
    assert.match(result.text, /7-9 码头管事 ♛/);
});

test('批量：认不出表时 marked 为 0，文本原样返回', () => {
    const text = '正文。\n→ 【1d10=7】';
    const result = markOptionHits(text, [{ replacement: '【1d10=7】', value: 7 }]);
    assert.equal(result.marked, 0);
    assert.equal(result.text, text);
});

test('批量：空列表 / 空符号 / 坏数据都不炸', () => {
    // 返回值带 corrected（被擦掉的"抢标"行数）和 shape（表格形态诊断，用来回喂）
    const empty = { text: 'x', marked: 0, corrected: 0, shape: { slots: 0, distinct: 0, critMismatch: 0 } };
    assert.deepEqual(markOptionHits('x', []), empty);
    assert.deepEqual(markOptionHits('x', [{ replacement: 'y', value: 1 }], { mark: '' }), empty);
    assert.deepEqual(markOptionHits('x', [null, { value: 'nan' }]), empty);
    assert.deepEqual(markOptionHits('x', null), empty);
});

test('★ 表格形态诊断：格数 / 不同走向数 / crit 位是否写对', () => {
    const mk = (rows) => [`选项骰十项：`, ...rows, '10 【1D2】大成功/大失败'].join('\n');
    // 正常十格、走向都不同
    const good = mk(['1 甲', '2 乙', '3 丙', '4 丁', '5 戊', '6 己', '7 庚', '8 辛', '9 壬']);
    const a = markOptionHits(`${good}\n【1d10=3】`, [{ replacement: '【1d10=3】', value: 3 }]);
    assert.equal(a.shape.slots, 10, '十项表该是 10 格');
    assert.equal(a.shape.distinct, 10);
    assert.equal(a.shape.critMismatch, 0);

    // 只有三条不同走向、格数也不够 → 回喂用
    const thin = mk(['1 甲', '2 甲', '3 甲', '4 甲', '5 甲', '6 甲', '7 甲', '8 甲', '9 甲']);
    const b = markOptionHits(`${thin}\n【1d10=3】`, [{ replacement: '【1d10=3】', value: 3 }]);
    assert.ok(b.shape.distinct < 5, `只有 ${b.shape.distinct} 条不同走向，该被判为不合规`);
    assert.equal(b.shape.slots, 10, '格数还是 10（1–10 都铺满了），问题只在走向太单一');

    // 六项表：格数就真的只有 6 → 用来回喂"十项表要铺满 1–10"
    const six = ['选项骰六项：', '1 甲', '2 乙', '3 丙', '4 丁', '5 戊', '6 己'].join('\n');
    const c = markOptionHits(`${six}\n【1d6=3】`, [{ replacement: '【1d6=3】', value: 3 }]);
    assert.equal(c.shape.slots, 6, '六项表就是 6 格');
});

test('★ 第 10 项写错也要能看出来（投中最后一项但那行不是大成功/大失败）', () => {
    // 自相矛盾的产物：表里第 10 项写着「去赌场」，骰子却按 crit 走了 1d2 连投、还标了命中
    const table = [
        '选项骰十项：',
        '1 甲', '2 乙', '3 丙', '4 丁', '5 戊', '6 己', '7 庚', '8 辛', '9 壬',
        '10 去赌场',
    ].join('\n');
    const out = markOptionHits(`${table}\n【1d10=10】`, [{ replacement: '【1d10=10】', value: 10 }]);
    assert.equal(out.shape.critMismatch, 1, '要能认出"最后一项不是 crit 位"');

    // 写对了就不该报
    const ok = [`选项骰十项：`, '1 甲', '2 乙', '3 丙', '4 丁', '5 戊', '6 己', '7 庚', '8 辛', '9 壬',
        '10 【1D2】大成功/大失败'].join('\n');
    assert.equal(markOptionHits(`${ok}\n【1d10=10】`, [{ replacement: '【1d10=10】', value: 10 }])
        .shape.critMismatch, 0);
});

test('★ 模型抢标且标错行 → 擦掉重标（一张表不能两个标记）', () => {
    // 实测过的现象：模型把标记打在 `2 乙`，骰值是 7 → `2 乙 ♛` 和 `7 庚 ♛` 并存，
    // 读者不知道信哪个。谁投的骰子谁负责标，所以错的那份要擦掉。
    const table = [
        '选项骰十项：',
        '1 甲', '2 乙 ♛', '3 丙', '4 丁', '5 戊', '6 己',
        '7 庚', '8 辛', '9 壬', '10 【1D2】大成功/大失败',
    ].join('\n');
    const out = markOptionHits(`${table}\n【1d10=7】`, [{ replacement: '【1d10=7】', value: 7 }]);

    assert.equal((out.text.match(/♛/g) ?? []).length, 1, '一张表只能有一个标记');
    assert.match(out.text, /7 庚 ♛/, '标在命中行');
    assert.ok(!/2 乙 ♛/.test(out.text), '错的那份要擦掉');
    assert.equal(out.corrected, 1, '要报告改正了几处');
    assert.equal(out.marked, 1);
});

test('★ 模型自己标对了 → 算标上了，不再叠一个，也不该误报', () => {
    const table = [
        '选项骰十项：',
        '1 甲', '2 乙', '3 丙', '4 丁', '5 戊', '6 己',
        '7 庚 ♛',
        '8 辛', '9 壬', '10 【1D2】大成功/大失败',
    ].join('\n');
    const out = markOptionHits(`${table}\n【1d10=7】`, [{ replacement: '【1d10=7】', value: 7 }]);

    assert.equal((out.text.match(/♛/g) ?? []).length, 1, '不能叠成两个');
    assert.equal(out.marked, 1, '标对了就算标上（旧代码这里返回"没改动" → 误报"没能认出命中行"）');
    assert.equal(out.corrected, 0);
});
