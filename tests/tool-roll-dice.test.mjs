/**
 * 函数工具（P2 地基）的单元测试。
 *
 * 这个模块是纯的：不碰 DOM、不碰酒馆、骰子引擎由调用方注入 —— 所以能直接测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ROLL_DICE_TOOL_NAME,
    ROLL_DICE_PARAMETERS,
    canUseDiceTool,
    buildRollDiceTool,
    findOptionRow,
    renderOptionTable,
} from '../src/tool-roll-dice.js';

const TEN_OPTIONS = [
    '1 甲', '2 乙', '3 丙', '4 丁', '5 戊', '6 己', '7 庚', '8 辛', '9 壬',
    '10 【1D2】大成功/大失败',
];

test('工具名与参数结构符合酒馆核心的契约', () => {
    assert.equal(ROLL_DICE_TOOL_NAME, 'RollDice');
    // 官方范本（stable-diffusion）的形状：type + object + properties + required
    assert.equal(ROLL_DICE_PARAMETERS.type, 'object');
    assert.ok(ROLL_DICE_PARAMETERS.properties.expression, 'expression 必须有');
    assert.deepEqual(ROLL_DICE_PARAMETERS.required, ['expression'], '只有 expression 是必填');

    // ★ 两条**防回归**断言（都是拿真实故障换来的，别删）：
    // ① 不许有 $schema —— Google 的 Schema 类型不认它，OpenRouter 还按 Draft 7 校验
    assert.equal(ROLL_DICE_PARAMETERS.$schema, undefined, '$schema 会让 Gemini 侧拒收/误解析');
    // ② **不许有数组参数** —— 官方论坛：malformed function call 最常见于"数组或长字符串"参数；
    //    实测带 options（十项长中文）时上游返回 native_finish_reason: MALFORMED_FUNCTION_CALL
    const kinds = Object.values(ROLL_DICE_PARAMETERS.properties).map((item) => item.type);
    assert.ok(!kinds.includes('array'), `工具参数里不许出现数组（实测会 malformed），实际：${kinds.join(',')}`);
    assert.equal(ROLL_DICE_PARAMETERS.properties.options, undefined, 'options 必须已经删掉');
});

test('findOptionRow：普通行 / 区间行 / 没写号数的行', () => {
    assert.equal(findOptionRow(TEN_OPTIONS, 7).text, '庚');
    assert.equal(findOptionRow(['1-3 甲乙丙', '4 丁', '5 戊', '6 己', '7 庚', '8 辛', '9 壬', '10 大成功'], 2).text, '甲乙丙');
    assert.equal(findOptionRow(['走左边', '走右边'], 2).text, '走右边', '没写号数就按顺序算');
    assert.equal(findOptionRow(TEN_OPTIONS, 99), null, '落在表外要返回 null');
    assert.equal(findOptionRow(null, 1), null, '坏数据不炸');
});

test('renderOptionTable：命中行打标记，别的行不动', () => {
    const text = renderOptionTable({ label: '命运', options: TEN_OPTIONS, expression: '1d10', total: 7 });
    const lines = text.split('\n');
    assert.match(lines[0], /命运：投 1d10 = 7/);
    assert.equal((text.match(/♛/g) ?? []).length, 1, '一张表只能有一个标记');
    assert.match(text, /7 庚 ♛/);
    assert.ok(!/6 己 ♛/.test(text));
});

test('renderOptionTable：标记符号可配置、可留空', () => {
    const withStar = renderOptionTable({ options: TEN_OPTIONS, expression: '1d10', total: 3, mark: '★' });
    assert.match(withStar, /3 丙 ★/);
    assert.ok(!withStar.includes('♛'), '符号换了就不该再出现 ♛');

    const empty = renderOptionTable({ options: TEN_OPTIONS, expression: '1d10', total: 3, mark: '' });
    assert.ok(!empty.includes('♛'), '留空就不打标');
    assert.match(empty, /3 丙/);
});

test('★ action：真投骰并把结果回给模型（含选项命中）', async () => {
    const seen = [];
    const tool = buildRollDiceTool({
        roll: (expression) => ({ expr: expression, total: 7 }),
        onRoll: (event) => seen.push(event),
    });
    assert.equal(typeof tool.action, 'function');

    const result = await tool.action({ expression: '1d10', label: '选项', options: TEN_OPTIONS });
    assert.match(result, /【1d10=7】/, `回执要带真结果，实际：${result}`);
    assert.match(result, /命中第 7 项：庚/, '要告诉模型命中了哪一项');

    assert.equal(seen.length, 1, 'onRoll 要回调一次（记日志用）');
    assert.equal(seen[0].total, 7);
    assert.equal(seen[0].label, '选项');
    assert.equal(seen[0].options.length, 10, '结构化十项要原样带出来');
});

test('action：坏参数要抛错（抛错才会被酒馆核心当失败回给模型）', async () => {
    const tool = buildRollDiceTool({ roll: () => ({ expr: '1d10', total: 1 }) });
    await assert.rejects(() => tool.action({}), /expression/);
    await assert.rejects(() => tool.action({ expression: '  ' }), /expression/);
    // 引擎没给结果也要抛，不能静默返回一个空回执
    const broken = buildRollDiceTool({ roll: () => ({ expr: '1d10' }) });
    await assert.rejects(() => broken.action({ expression: '1d10' }), /没有给出结果/);
});

test('buildRollDiceTool：没有 roll 函数就当场报错（别等运行时）', () => {
    assert.throws(() => buildRollDiceTool({}), /roll/);
});

test('formatMessage：选项表渲染成给人看的文本，且不需要 total 也不炸', () => {
    const tool = buildRollDiceTool({ roll: () => ({ expr: '1d10', total: 5 }), mark: () => '♛' });
    const text = String(tool.formatMessage({ expression: '1d10', label: '选项', options: TEN_OPTIONS }));
    assert.match(text, /选项：投 1d10/);
    assert.match(text, /1 甲/, '十项都要在里面');

    // 不是选项表 → 简短一行
    const plain = String(tool.formatMessage({ expression: '1d100', label: '话术' }));
    assert.match(plain, /投骰：1d100（话术）/);
});

test('canUseDiceTool：拿不到 / 抛错都要安全地判成"不支持"', () => {
    assert.equal(canUseDiceTool({}), false);
    assert.equal(canUseDiceTool(null), false);
    assert.equal(canUseDiceTool({ isToolCallingSupported: () => true }), true);
    assert.equal(canUseDiceTool({ isToolCallingSupported: () => false }), false);
    assert.equal(canUseDiceTool({
        isToolCallingSupported: () => { throw new Error('核心没准备好'); },
    }), false, '抛错不能把插件带崩');
});
