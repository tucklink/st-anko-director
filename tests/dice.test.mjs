import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DiceError,
    LIMITS,
    createSequenceRng,
    cryptoRandomInt,
    defaultRng,
    isValidExpression,
    parseExpression,
    rollExpression,
} from '../src/dice.js';

// 用确定性随机源，测试才有意义
const roll = (expr, seq) => rollExpression(expr, { rng: createSequenceRng(seq) });

test('基础投骰：1d100 取序列值', () => {
    const r = roll('1d100', [42]);
    assert.equal(r.expr, '1d100');
    assert.equal(r.total, 42);
    assert.deepEqual(r.dice, [42]);
    assert.match(r.detail, /1d100\[42\]=42/);
});

test('多骰求和与加值：3d6+2', () => {
    const r = roll('3d6+2', [1, 2, 3]);
    assert.equal(r.total, 8);
    assert.deepEqual(r.dice, [1, 2, 3]);
    assert.match(r.detail, /3d6\[1,2,3\]=6 \+ 2/);
});

test('取大：3d6k2 只取最大的两颗', () => {
    const r = roll('3d6k2', [1, 5, 3]);
    assert.equal(r.total, 8); // 5+3
    assert.deepEqual(r.dice, [1, 5, 3], '原始点数要全记下来，k 不能吃掉明细');
    assert.match(r.detail, /→取5,3/);
});

test('取大遇到并列：稳定取靠前的', () => {
    const r = roll('4d6k3', [4, 4, 2, 4]);
    assert.equal(r.total, 12);
});

test('乘法优先于加减，且整体作用：3d6*5+2', () => {
    const r = roll('3d6*5+2', [1, 1, 1]);
    assert.equal(r.total, 17); // 3*5+2
});

test('X 与 * 等价，也认小写 x', () => {
    assert.equal(roll('3d6X5', [1, 1, 1]).total, 15);
    assert.equal(roll('3d6*5', [1, 1, 1]).total, 15);
    assert.equal(roll('3d6x5', [1, 1, 1]).total, 15);
});

test('减值与多骰混合：1d6+1d4-1', () => {
    const r = roll('1d6+1d4-1', [6, 4]);
    assert.equal(r.total, 9);
    assert.deepEqual(r.dice, [6, 4]);
});

test('空格不影响解析', () => {
    assert.equal(roll(' 3d6 + 2 ', [1, 1, 1]).total, 5);
});

test('1d1 合法，恒为 1', () => {
    assert.equal(roll('1d1', [1]).total, 1);
});

test('数量与面数边界', () => {
    assert.equal(roll(`${LIMITS.MAX_COUNT}d1`, Array.from({ length: LIMITS.MAX_COUNT }, () => 1)).total, LIMITS.MAX_COUNT);
    assert.equal(roll(`1d${LIMITS.MAX_FACES}`, [LIMITS.MAX_FACES]).total, LIMITS.MAX_FACES);
});

test('越界一律报错，不静默截断', () => {
    assert.throws(() => roll(`${LIMITS.MAX_COUNT + 1}d6`, []), /骰子个数必须在/);
    assert.throws(() => roll(`1d${LIMITS.MAX_FACES + 1}`, []), /骰子面数必须在/);
    assert.throws(() => roll('0d6', []), /骰子个数必须在/);
    assert.throws(() => roll('3d6k4', [1, 2, 3]), /取大数量 4 不能超过骰子个数 3/);
});

test('残缺写法给出可读报错', () => {
    assert.throws(() => roll('d100', []), /骰子数量不能省略/);
    assert.throws(() => roll('1d', []), /d 后面要跟面数|应该是一个数字/);
    assert.throws(() => roll('3d6k', []), /k 后面要跟数量/);
});

test('明确"不做"的语法：单独给报错，别让用户猜', () => {
    assert.throws(() => roll('3#1d6', []), /不支持多轮掷骰/);
    assert.throws(() => roll('1d100b2', []), /不支持奖励骰/);
    assert.throws(() => roll('1d100p1', []), /不支持惩罚骰/);
    assert.throws(() => roll('1d100h', []), /不支持暗骰/);
    assert.throws(() => roll('5w6', []), /不支持骰池/);
    assert.throws(() => roll('10/2', []), /不支持除法/);
    assert.throws(() => roll('(1d6+2)*3', []), /不支持括号/);
});

test('空表达式与非法字符', () => {
    assert.throws(() => roll('', []), /表达式是空的/);
    assert.throws(() => roll('   ', []), /表达式是空的/);
    assert.throws(() => roll('1d6+abc', []), /无法识别的字符|应该是一个数字/);
});

test('表达式解析失败时 DiceError 带 code 与位置', () => {
    try {
        parseExpression('1d100/2');
        assert.fail('应该抛错');
    } catch (error) {
        assert.ok(error instanceof DiceError);
        assert.equal(error.code, 'no-division');
        assert.equal(error.position, 5);
    }
});

test('isValidExpression 不抛异常', () => {
    assert.equal(isValidExpression('3d6k2+1'), true);
    assert.equal(isValidExpression('d6'), false);
    assert.equal(isValidExpression('1d6/2'), false);
});

test('随机源越界会被抓住（防止注入坏随机源）', () => {
    assert.throws(() => rollExpression('1d6', { rng: () => 7 }), /随机源返回了越界值/);
    assert.throws(() => rollExpression('1d6', { rng: () => 0 }), /随机源返回了越界值/);
});

test('确定性随机源用光会报错，而不是悄悄返回 undefined', () => {
    assert.throws(() => roll('3d6', [1, 2]), /确定性随机源用光了/);
});

test('cryptoRandomInt：范围正确、1 的边界、非法入参', () => {
    for (let i = 0; i < 500; i += 1) {
        const v = cryptoRandomInt(6);
        assert.ok(v >= 0 && v < 6, `越界: ${v}`);
    }
    assert.equal(cryptoRandomInt(1), 0);
    assert.throws(() => cryptoRandomInt(0), /随机上界/);
    assert.throws(() => cryptoRandomInt(1.5), /随机上界/);
});

test('cryptoRandomInt 不是常数（弱随机的兜底检查）', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
        seen.add(cryptoRandomInt(100));
    }
    assert.ok(seen.size > 30, `200 次 1d100 只出了 ${seen.size} 种值，随机源可疑`);
});

test('defaultRng 返回 1..faces', () => {
    for (let i = 0; i < 300; i += 1) {
        const v = defaultRng(20);
        assert.ok(v >= 1 && v <= 20, `越界: ${v}`);
    }
});
