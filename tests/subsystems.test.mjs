import test from 'node:test';
import assert from 'node:assert/strict';

import { createSequenceRng } from '../src/dice.js';
import { PERSIST_LIMIT, createRollLog } from '../src/roll-log.js';
import { BUILTIN_TABLES, getTable, listTables, normalizeTable, rollTable } from '../src/tables.js';
import {
    DEFAULT_ATTRIBUTE_NAMES,
    MAX_RECENT_OUTLINES,
    adjustAttribute,
    bidAdd,
    bidClear,
    bidDraw,
    bidRemove,
    bidSetTitle,
    clearOutlines,
    createState,
    formatAttributes,
    formatBid,
    formatOutlines,
    growthCheck,
    markDead,
    migrateState,
    pushOutline,
    removeAttribute,
    revive,
    rollAttributeSheet,
    setAttribute,
} from '../src/state.js';

// ---------------------------------------------------------------------------
// 随机表
// ---------------------------------------------------------------------------

test('均分表：文本按骰面数均分', () => {
    const table = normalizeTable({ dice: '1d10', texts: ['甲', '乙', '丙'] }, '测试');
    assert.deepEqual(table.entries.map((e) => [e.from, e.to, e.text]), [
        [1, 3, '甲'], [4, 6, '乙'], [7, 10, '丙'],
    ]);
});

test('区间表：原样保留，并按下限排序', () => {
    const table = normalizeTable({ dice: '1d100', bands: [[51, 100, '大'], [1, 50, '小']] }, '测试');
    assert.deepEqual(table.entries.map((e) => [e.from, e.to, e.text]), [[1, 50, '小'], [51, 100, '大']]);
});

test('投表：命中区间并给出明细', () => {
    const result = rollTable({ dice: '1d10', texts: ['甲', '乙', '丙'] }, {
        name: '测试',
        rng: createSequenceRng([5]),
    });
    assert.equal(result.total, 5);
    assert.equal(result.text, '乙');
    assert.equal(result.detail, '1d10=5 → 4-6 区间');
    assert.equal(result.tableName, '测试');
    assert.deepEqual(result.dice, [5]);
});

test('投表：区间没覆盖到骰值时给兜底文案，不报错', () => {
    const result = rollTable({ dice: '1d10', bands: [[1, 3, '甲']] }, { rng: createSequenceRng([9]) });
    assert.equal(result.total, 9);
    assert.match(result.text, /由导游临场决定/);
});

test('表定义有问题时给可读报错', () => {
    assert.throws(() => normalizeTable(null, '缺表'), /不存在/);
    assert.throws(() => normalizeTable({ dice: 'd100', texts: ['a'] }, 'x'), /必须写成 1dN/);
    assert.throws(() => normalizeTable({ dice: '1d10' }, 'x'), /既没有 bands 也没有 texts/);
    assert.throws(() => normalizeTable({ dice: '1d10', bands: [[1, 5]] }, 'x'), /\[下限, 上限, 文本\]/);
    assert.throws(() => normalizeTable({ dice: '1d10', bands: [[1, 50, 'a']] }, 'x'), /超出 1d10 的范围/);
    assert.throws(() => normalizeTable({ dice: '1d10', bands: [[5, 1, 'a']] }, 'x'), /非法区间/);
});

test('内置表都能通过校验（防止内置数据写坏）', () => {
    for (const [name, table] of Object.entries(BUILTIN_TABLES)) {
        const normalized = normalizeTable(table, name);
        assert.ok(normalized.entries.length > 0, `${name} 是空的`);
        // 区间要盖满整个骰面范围
        const covered = new Set();
        for (const entry of normalized.entries) {
            for (let i = entry.from; i <= entry.to; i += 1) {
                covered.add(i);
            }
        }
        const max = Number(/1d(\d+)/.exec(normalized.dice)[1]);
        assert.equal(covered.size, max, `${name} 的区间没盖满 1..${max}`);
    }
});

test('自定义表覆盖同名内置表', () => {
    const custom = { 随机事件: { dice: '1d10', texts: ['只有这一种'] } };
    assert.deepEqual(getTable('随机事件', custom).texts, ['只有这一种']);
    assert.ok(listTables(custom).includes('随机事件'));
    assert.equal(getTable('不存在的表', custom), null);
});

// ---------------------------------------------------------------------------
// 属性
// ---------------------------------------------------------------------------

test('设置与增减属性', () => {
    const state = createState();
    setAttribute(state, '话术', 40);
    assert.equal(state.attributes.话术, 40);

    const changed = adjustAttribute(state, '话术', -5);
    assert.deepEqual(changed, { name: '话术', before: 40, after: 35, delta: -5 });
});

test('属性名的空白会被裁掉，空名报错', () => {
    const state = createState();
    setAttribute(state, '  话术  ', 40);
    assert.equal(state.attributes.话术, 40);
    assert.throws(() => setAttribute(state, '   ', 1), /属性名不能为空/);
});

test('属性值不是数字时报错', () => {
    const state = createState();
    assert.throws(() => setAttribute(state, '话术', 'abc'), /必须是数字/);
    assert.throws(() => adjustAttribute(state, '不存在', 1), /没有这个属性/);
    setAttribute(state, '话术', 40);
    assert.throws(() => adjustAttribute(state, '话术', 'x'), /增减量必须是数字/);
});

test('删属性', () => {
    const state = createState();
    setAttribute(state, '话术', 40);
    assert.deepEqual(removeAttribute(state, '话术'), { name: '话术', value: 40 });
    assert.throws(() => removeAttribute(state, '话术'), /没有这个属性/);
});

test('属性表格式化', () => {
    const state = createState();
    assert.match(formatAttributes(state), /还没有属性/);
    setAttribute(state, '话术', 40);
    setAttribute(state, '幸运', 55);
    assert.equal(formatAttributes(state), '话术 40　幸运 55');
});

test('车卡：按给定名字各投一次', () => {
    const state = createState();
    const sheet = rollAttributeSheet({
        rng: createSequenceRng([10, 20, 30, 40, 50, 60, 70, 80]),
        names: ['力量', '敏捷', '体质', '智力', '意志', '外貌', '教育', '幸运'],
        target: state,
    });
    assert.equal(sheet.values.力量, 10);
    assert.equal(sheet.values.幸运, 80);
    assert.equal(state.attributes.敏捷, 20, '车卡结果要写进状态');
});

test('车卡：默认八项', () => {
    const sheet = rollAttributeSheet({
        rng: createSequenceRng(Array(8).fill(50)),
    });
    assert.deepEqual(Object.keys(sheet.values), [...DEFAULT_ATTRIBUTE_NAMES]);
});

test('成长检定：超过当前值就成长', () => {
    const state = createState();
    setAttribute(state, '话术', 30);
    // 1d100=60 > 30 → 成长，1d10=8 → 30+8=38
    const result = growthCheck(state, '话术', { rng: createSequenceRng([60, 8]) });
    assert.equal(result.grown, true);
    assert.equal(result.gain, 8);
    assert.equal(result.after, 38);
    assert.equal(result.label, '成长');
});

test('成长检定：没超过就没长进，也不消耗第二个骰子', () => {
    const state = createState();
    setAttribute(state, '话术', 80);
    const result = growthCheck(state, '话术', { rng: createSequenceRng([20]) });
    assert.equal(result.grown, false);
    assert.equal(result.gain, 0);
    assert.equal(result.after, 80);
});

test('成长检定：骰值 > 95 时即使技能很高也成长', () => {
    const state = createState();
    setAttribute(state, '话术', 98);
    const result = growthCheck(state, '话术', { rng: createSequenceRng([97, 3]) });
    assert.equal(result.grown, true);
    assert.equal(result.after, 99, '上限 99');
    assert.equal(result.capped, true);
});

// ---------------------------------------------------------------------------
// 安价池
// ---------------------------------------------------------------------------

test('安价：添加、列表、按序号删除', () => {
    const state = createState();
    bidSetTitle(state, '主角接下来做什么');
    const added = bidAdd(state, '去酒馆|去码头');
    assert.deepEqual(added.added, ['去酒馆', '去码头']);
    assert.equal(added.total, 2);

    bidAdd(state, ['继续睡觉']);
    assert.equal(state.bid.options.length, 3);

    const removed = bidRemove(state, 2);
    assert.equal(removed.removed, '去码头');
    assert.deepEqual(state.bid.options, ['去酒馆', '继续睡觉']);

    assert.match(formatBid(state), /【主角接下来做什么】共 2 项/);
    assert.match(formatBid(state), /1\. 去酒馆/);
});

test('安价：序号越界要报错', () => {
    const state = createState();
    bidAdd(state, '甲');
    assert.throws(() => bidRemove(state, 0), /选项序号要在 1–1 之间/);
    assert.throws(() => bidRemove(state, 9), /选项序号要在 1–1 之间/);
});

test('安价：空添加与空池抽取都要报错', () => {
    const state = createState();
    assert.throws(() => bidAdd(state, '  '), /没有可添加的选项/);
    assert.throws(() => bidDraw(state), /安价池是空的/);
});

test('安价：均等抽取并清空', () => {
    const state = createState();
    bidSetTitle(state, '标题');
    bidAdd(state, '甲|乙|丙|丁');
    const drawn = bidDraw(state, { rng: createSequenceRng([3]) });
    assert.equal(drawn.title, '标题');
    assert.equal(drawn.index, 3);
    assert.equal(drawn.option, '丙');
    assert.equal(drawn.total, 4);
    assert.equal(drawn.roll.expr, '1d4');
    assert.equal(state.bid.options.length, 0, '抽完要清空');
    assert.equal(state.bid.title, '', '标题也要清');
});

test('安价：只有一项时不需要随机（但也会走一次 1d1）', () => {
    const state = createState();
    bidAdd(state, '唯一解');
    const drawn = bidDraw(state, { rng: createSequenceRng([1]) });
    assert.equal(drawn.option, '唯一解');
    assert.equal(drawn.roll.expr, '1d1');
});

test('安价：清空返回清掉的条数', () => {
    const state = createState();
    bidAdd(state, '甲|乙');
    assert.deepEqual(bidClear(state), { cleared: 2 });
    assert.match(formatBid(state), /安价池是空的/);
});

// ---------------------------------------------------------------------------
// 状态迁移
// ---------------------------------------------------------------------------

test('migrateState：垃圾输入给一份干净状态，而不是崩', () => {
    for (const junk of [null, undefined, 42, 'x', [], { attributes: 'nope' }]) {
        const state = migrateState(junk);
        assert.deepEqual(state.attributes, {});
        assert.equal(state.combat, null);
        assert.deepEqual(state.bid.options, []);
    }
});

test('migrateState：把脏数据洗干净', () => {
    const state = migrateState({
        attributes: { 话术: '40', 坏: 'abc', '': 1, 幸运: 55.7 },
        bid: { title: 123, options: ['甲', '  ', 5] },
        customTables: { 我的表: { dice: '1d6', texts: ['a'] }, 垃圾: 'x' },
        storySoFar: 99,
    });
    assert.deepEqual(state.attributes, { 话术: 40, 幸运: 55 });
    assert.deepEqual(state.bid.options, ['甲', '5']);
    assert.equal(state.bid.title, '123');
    assert.deepEqual(Object.keys(state.customTables), ['我的表']);
    assert.equal(state.storySoFar, '99');
});

test('migrateState：带版本号，方便将来迁移', () => {
    assert.equal(migrateState({}).version, createState().version);
});

// ---------------------------------------------------------------------------
// 骰点日志的落盘体积
// ---------------------------------------------------------------------------

test('★ 骰点日志：检定要记下目标值（否则「58 → 失败」没法复核）', () => {
    const log = createRollLog();
    log.add(
        { expr: '1d100', total: 58, dice: [58], kind: 'check', name: '话术', rate: 40, label: '失败' },
        { kind: 'check', context: '自动·第2轮' },
    );
    const text = log.formatLast(1);
    assert.match(text, /1d100 = 58 → 失败（话术40）/, `实际：${text}`);

    // 普通投骰没有目标值，不该多出一对空括号
    const plain = createRollLog();
    plain.add({ expr: '1d6', total: 4, dice: [4], kind: 'roll' }, { kind: 'roll' });
    assert.ok(!plain.formatLast(1).includes('（）'), `实际：${plain.formatLast(1)}`);

    // 存盘/恢复也要带上
    const back = createRollLog().hydrate(log.toJSON());
    assert.match(back.formatLast(1), /（话术40）/);
});

test('★ 骰点日志：内存留 500 条，落盘只留最近 100 条（聊天文件不能太重）', () => {
    // 实测 500 条 ≈ 65 KB，全部跟着聊天文件存太重；落盘只留最近的。
    const log = createRollLog();
    for (let i = 0; i < 600; i += 1) {
        log.add(
            { expr: '1d6', total: (i % 6) + 1, dice: [(i % 6) + 1], kind: 'roll', at: 1700000000000 + i },
            { kind: 'roll', context: `第${i}轮` },
        );
    }

    assert.equal(log.size(), 500, '内存里留 500 条，面板能查一整个会话');
    const json = log.toJSON();
    assert.equal(json.entries.length, PERSIST_LIMIT, '落盘只留最近 100 条');
    assert.equal(json.entries.at(-1).context, '第599轮', '留的必须是最新的那批');

    const bytes = JSON.stringify(json).length;
    assert.ok(bytes < 20000, `落盘体积 ${bytes} 字节 —— 超过 20KB 就说明又存太多了`);

    // 恢复之后条数与落盘一致，序号也不能丢
    const back = createRollLog().hydrate(json);
    assert.equal(back.size(), PERSIST_LIMIT);
    assert.equal(back.last(1)[0].seq, json.entries.at(-1).seq, '序号要接着，不能从头开始');
});



test('★ 前情记忆：存最近几份大纲，重复的不再存', () => {
    const state = createState();
    assert.deepEqual(state.recentOutlines, []);

    assert.equal(pushOutline(state, '第一幕').added, true);
    pushOutline(state, '第二幕');
    assert.equal(pushOutline(state, '第二幕').added, false, '连着推两次同一份只存一份');
    assert.deepEqual(state.recentOutlines, ['第一幕', '第二幕']);

    pushOutline(state, '第三幕');
    pushOutline(state, '第四幕');
    assert.deepEqual(state.recentOutlines, ['第二幕', '第三幕', '第四幕'], '只留最近的');
    assert.equal(state.recentOutlines.length, MAX_RECENT_OUTLINES);

    assert.equal(pushOutline(state, '   ').added, false, '空白不算一份');
    assert.equal(pushOutline(state, null).added, false);
});

test('★ 前情文本：从结尾截断（接续点在结尾），并且带分隔提示', () => {
    const state = createState();
    pushOutline(state, '第一幕');
    pushOutline(state, '第二幕');

    const text = formatOutlines(state);
    assert.match(text, /第一幕/);
    assert.match(text, /第二幕/);
    assert.match(text, /下一次推演从这里接/);

    // 超长时从**结尾**保留：开头丢了顶多少点背景，结尾丢了就接不上
    const long = `${'开'.repeat(3000)}结尾在这里`;
    pushOutline(state, long);
    const cut = formatOutlines(state, 100);
    assert.match(cut, /…（前略）/);
    assert.match(cut, /结尾在这里/);
    assert.ok(cut.length < 400);
});

test('前情可以清空（想重新开局时）', () => {
    const state = createState();
    pushOutline(state, '第一幕');
    pushOutline(state, '第二幕');
    assert.equal(clearOutlines(state).cleared, 2);
    assert.deepEqual(state.recentOutlines, []);
    assert.equal(formatOutlines(state), '');
    assert.equal(clearOutlines(state).cleared, 0);
});

test('migrateState：老存档的 storySoFar 会被补成第一份前情', () => {
    assert.deepEqual(migrateState({ storySoFar: '很久以前' }).recentOutlines, ['很久以前']);
    assert.deepEqual(migrateState({ recentOutlines: ['a', 'b', 'c', 'd'] }).recentOutlines,
        ['b', 'c', 'd'], '只留最近 3 份');
    assert.deepEqual(migrateState({ recentOutlines: ['a', 1, null, '', 'b'] }).recentOutlines, ['a', 'b']);
    assert.deepEqual(migrateState({ recentOutlines: '不是数组' }).recentOutlines, []);
    assert.deepEqual(migrateState({}).recentOutlines, []);
    assert.deepEqual(migrateState(null).recentOutlines, []);
});

// ---------------------------------------------------------------------------
// 死亡状态
// ---------------------------------------------------------------------------

test('死亡：markDead 落成持久状态，并把 HP 清零', () => {
    const state = createState();
    setAttribute(state, 'HP', 20);
    const info = markDead(state, '第 3 轮被钢板打倒');

    assert.equal(state.dead, true);
    assert.equal(info.note, '第 3 轮被钢板打倒');
    assert.equal(state.attributes.HP, 0, '死了 HP 就是 0');

    const back = revive(state);
    assert.equal(back.was, true);
    assert.equal(state.dead, false);
    assert.equal(state.deathNote, '');

    assert.equal(revive(state).was, false, '没死时撤销不该报"撤销过"');
});

test('死亡：没有 HP 属性时 markDead 也不炸', () => {
    const state = createState();
    assert.doesNotThrow(() => markDead(state, ''));
    assert.equal(state.dead, true);
    assert.equal(state.deathNote, '');
});

test('migrateState：死亡标记会被清洗（只有严格的 true 才算死）', () => {
    assert.equal(migrateState({ dead: true, deathNote: 42 }).dead, true);
    assert.equal(migrateState({ dead: true, deathNote: 42 }).deathNote, '42');
    assert.equal(migrateState({ dead: 'yes' }).dead, false);
    assert.equal(migrateState({ dead: 1 }).dead, false);
    assert.equal(migrateState({}).dead, false, '老存档没有这个字段，默认活着');
});
