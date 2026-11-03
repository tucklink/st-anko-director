import test from 'node:test';
import assert from 'node:assert/strict';

import { createSequenceRng } from '../src/dice.js';
import {
    BACKGROUND_BANDS,
    BACKGROUND_CRIT_MIN,
    BACKGROUND_FUMBLE_MAX,
    CHECK_LABEL,
    CHECK_LEVEL,
    formatCheckReplacement,
    formatKongmingReplacement,
    judgeCheck,
    rollBackground,
    rollCheck,
    rollKongming,
    rollYesNo,
} from '../src/rules.js';

// ---------------------------------------------------------------------------
// 轨道 C：是非骰（1d2）—— 语义由插件固定
// ---------------------------------------------------------------------------

test('是非骰：1 = 是/进行，2 = 否/不进行（固定语义，不由模型定）', () => {
    const yes = rollYesNo({ rng: createSequenceRng([1]) });
    assert.equal(yes.kind, 'yesno');
    assert.equal(yes.total, 1);
    assert.equal(yes.yes, true);
    assert.equal(yes.label, '是');

    const no = rollYesNo({ rng: createSequenceRng([2]) });
    assert.equal(no.yes, false);
    assert.equal(no.label, '否');
});

test('是非骰：只认 1d2（1d3/2d2 都要当场报错，不许当成是非骰）', () => {
    assert.throws(() => rollYesNo({ expression: '1d3', rng: createSequenceRng([1]) }), /只认 1d2/);
    assert.throws(() => rollYesNo({ expression: '2d2', rng: createSequenceRng([1, 1]) }), /只认 1d2/);
    // 空格/大小写要容错 ✓
    assert.equal(rollYesNo({ expression: ' 1D2 ', rng: createSequenceRng([1]) }).yes, true);
});

// ---------------------------------------------------------------------------
// 轨道 D：背景骰（1d100）—— 每 25 一格、四档递进、低=坏高=好
// ---------------------------------------------------------------------------

test('背景骰：四档边界 1/25/26/50/51/75/76/100 逐个核对', () => {
    assert.deepEqual(BACKGROUND_BANDS.map((b) => [b.from, b.to]), [[1, 25], [26, 50], [51, 75], [76, 100]]);
    const cases = [
        [1, 1, 'fumble'], [5, 1, 'fumble'],       // ≤5 = 大失败（**新极性**：低=坏）
        [6, 1, null], [25, 1, null],
        [26, 2, null], [50, 2, null],
        [51, 3, null], [75, 3, null],
        [76, 4, null], [95, 4, null],
        [96, 4, 'critical'], [100, 4, 'critical'], // ≥96 = 大成功
    ];
    for (const [total, band, crit] of cases) {
        const r = rollBackground({ rng: createSequenceRng([total]) });
        assert.equal(r.total, total);
        assert.equal(r.band, band, `${total} 应落在第 ${band} 档`);
        assert.equal(r.crit, crit, `${total} 的 crit 判定不对`);
    }
});

test('背景骰：crit 时要给效果表（与选项骰同一套规矩），非 crit 时不要', () => {
    assert.equal(rollBackground({ rng: createSequenceRng([3]) }).needEffectTable, true, '大失败要效果表');
    assert.equal(rollBackground({ rng: createSequenceRng([3]) }).label, '大失败');
    assert.equal(rollBackground({ rng: createSequenceRng([97]) }).needEffectTable, true, '大成功要效果表');
    assert.equal(rollBackground({ rng: createSequenceRng([97]) }).label, '大成功');
    const mid = rollBackground({ rng: createSequenceRng([42]) });
    assert.equal(mid.needEffectTable, false);
    assert.equal(mid.label, '第 2 档（共 4 档）');
});

test('背景骰：只认 1d100', () => {
    assert.throws(() => rollBackground({ expression: '1d20', rng: createSequenceRng([10]) }), /只认 1d100/);
});

test('背景骰的边界常量与规则文字一致（改一处忘另一处是常见事故）', () => {
    assert.equal(BACKGROUND_FUMBLE_MAX, 5);
    assert.equal(BACKGROUND_CRIT_MIN, 96);
    // 1–5 大失败、6–25 归第 1 档 —— 两者可以并存（crit 只是叠在档位上的额外说明 ✓）
    assert.equal(rollBackground({ rng: createSequenceRng([5]) }).band, 1);
    assert.equal(rollBackground({ rng: createSequenceRng([96]) }).band, 4);
});

// ---------------------------------------------------------------------------
// 轨道 A：COC 房规 3
// ---------------------------------------------------------------------------

test('房规3：1–5 一律大成功，与成功率无关', () => {
    for (const v of [1, 2, 3, 4, 5]) {
        assert.equal(judgeCheck(v, 1), CHECK_LEVEL.CRITICAL, `骰值 ${v}`);
        assert.equal(judgeCheck(v, 99), CHECK_LEVEL.CRITICAL, `骰值 ${v}`);
    }
});

test('房规3：96–100 一律大失败，即使成功率很高', () => {
    for (const v of [96, 97, 98, 99, 100]) {
        assert.equal(judgeCheck(v, 100), CHECK_LEVEL.FUMBLE, `骰值 ${v}`);
        assert.equal(judgeCheck(v, 1000), CHECK_LEVEL.FUMBLE, `骰值 ${v}`);
    }
});

test('困难成功 / 极难成功按成功率的一半与五分之一', () => {
    // 成功率 40 → 极难 ≤ 8，困难 ≤ 20，成功 ≤ 40
    assert.equal(judgeCheck(8, 40), CHECK_LEVEL.EXTREME);
    assert.equal(judgeCheck(9, 40), CHECK_LEVEL.HARD);
    assert.equal(judgeCheck(20, 40), CHECK_LEVEL.HARD);
    assert.equal(judgeCheck(21, 40), CHECK_LEVEL.SUCCESS);
    assert.equal(judgeCheck(40, 40), CHECK_LEVEL.SUCCESS);
    assert.equal(judgeCheck(41, 40), CHECK_LEVEL.FAIL);
});

test('设计书里的那个例子：1d100=68 / 话术40 → 失败', () => {
    assert.equal(judgeCheck(68, 40), CHECK_LEVEL.FAIL);
});

test('房规3 的特点：成功率为 1 时，1–5 照样是大成功', () => {
    // 骰娘手册专门指出 房规2 与 房规3 的区别就在这里：
    // 初始值为 1 的技能，在房规2 下大成功率只有 1，在房规3 下有 5。
    assert.equal(judgeCheck(1, 1), CHECK_LEVEL.CRITICAL);
    assert.equal(judgeCheck(2, 1), CHECK_LEVEL.CRITICAL);
    assert.equal(judgeCheck(5, 1), CHECK_LEVEL.CRITICAL);
    assert.equal(judgeCheck(6, 1), CHECK_LEVEL.FAIL);
});

test('检定参数越界要报错', () => {
    assert.throws(() => judgeCheck(0, 40), /检定值必须是 1–100/);
    assert.throws(() => judgeCheck(101, 40), /检定值必须是 1–100/);
    assert.throws(() => judgeCheck(50, 0), /成功率必须是 1–1000/);
    assert.throws(() => judgeCheck(50, 1001), /成功率必须是 1–1000/);
});

test('rollCheck 走完整链路并带判定结论', () => {
    const r = rollCheck({ rate: 40, name: '话术', rng: createSequenceRng([68]) });
    assert.equal(r.kind, 'check');
    assert.equal(r.total, 68);
    assert.equal(r.level, CHECK_LEVEL.FAIL);
    assert.equal(r.label, '失败');
    assert.equal(r.name, '话术');
    assert.equal(r.rate, 40);
    assert.equal(r.rule, 3);
});

test('检定格式化：给内联回执用', () => {
    const r = rollCheck({ rate: 40, name: '话术', rng: createSequenceRng([68]) });
    assert.equal(formatCheckReplacement(r), '【1d100=68 / 话术40 → 失败】');
});

test('所有判定等级都有中文标签', () => {
    for (const level of Object.values(CHECK_LEVEL)) {
        assert.equal(typeof CHECK_LABEL[level], 'string');
        assert.ok(CHECK_LABEL[level].length > 0);
    }
});

// ---------------------------------------------------------------------------
// 轨道 B：孔明式选项骰
// ---------------------------------------------------------------------------

test('孔明式：1–9 直接是选项号', () => {
    for (let option = 1; option <= 9; option += 1) {
        const r = rollKongming({ rng: createSequenceRng([option]) });
        assert.equal(r.kind, 'option');
        assert.equal(r.option, option);
        assert.deepEqual(r.chain, [{ expr: '1d10', value: option }]);
        assert.equal(formatKongmingReplacement(r.chain), `【1d10=${option}】`);
    }
});

test('孔明式：投出 10 → 追加 1D2 定大成功/大失败', () => {
    const good = rollKongming({ rng: createSequenceRng([10, 1, 4]) });
    assert.equal(good.kind, 'critical');
    assert.equal(good.depth, 1);
    assert.equal(good.effectRoll, 4);
    assert.equal(good.label, '大成功');
    assert.equal(formatKongmingReplacement(good.chain), '【1d10=10 → 1d2=1（大成功）→ 1d10=4】');

    const bad = rollKongming({ rng: createSequenceRng([10, 2, 4]) });
    assert.equal(bad.kind, 'fumble');
    assert.equal(bad.label, '大失败');
    assert.equal(formatKongmingReplacement(bad.chain), '【1d10=10 → 1d2=2（大失败）→ 1d10=4】');
});

test('孔明式：效果骰又出 10 —— **翻转**叫逆转、**同向**才叫双重（A+B 定案）', () => {
    // 这条测试原来叫「→ 双重大成功/大失败」并断言 label === '双重大成功' ✗ ——
    // 而它的序列恰好是「大失败 → 大成功」（**翻转**）✓ → 那等于在保护一个错名 ✓
    const flip = rollKongming({ rng: createSequenceRng([10, 2, 10, 1, 5]) });
    assert.equal(flip.depth, 2);
    assert.equal(flip.kind, 'critical');
    assert.equal(flip.polarity, 1);
    assert.equal(flip.reversed, true, '极性翻转过 → 必须标出来');
    assert.equal(flip.label, '逆转大成功');
    assert.equal(formatKongmingReplacement(flip.chain), '【1d10=10 → 1d2=2（大失败）→ 1d10=10 → 1d2=1（大成功）→ 1d10=5】');

    // 同向叠加才是"双重"
    const same = rollKongming({ rng: createSequenceRng([10, 1, 10, 1, 5]) });
    assert.equal(same.reversed, false, '同向不算逆转');
    assert.equal(same.label, '双重大成功');

    // 到上限还在翻转 → 传奇也要标出"逆转"（原来只会说「传奇大失败」✗，看不出翻转过）
    const cap = rollKongming({ rng: createSequenceRng([10, 1, 10, 2, 10]) });
    assert.equal(cap.kind, 'legendary');
    assert.equal(cap.reversed, true);
    assert.equal(cap.label, '传奇逆转大失败');
});

test('孔明式：嵌套到上限还出 10 → 传奇', () => {
    // 这条序列是「大成功 → 大失败」（**翻转**）✓ → 标签必须带"逆转"
    // （原来断言 '传奇大失败' ✗，看不出中间翻转过 —— 又一条在保护旧说法的断言）
    const flipped = rollKongming({ rng: createSequenceRng([10, 1, 10, 2, 10]) });
    assert.equal(flipped.kind, 'legendary');
    assert.equal(flipped.depth, 2);
    assert.equal(flipped.effectRoll, 10);
    assert.equal(flipped.reversed, true);
    assert.equal(flipped.label, '传奇逆转大失败');
    assert.equal(flipped.needEffectTable, true);

    // 同向那种（没翻转）仍然叫「传奇大成功」—— 不能因为改了命名就把这条路漏掉
    const same = rollKongming({ rng: createSequenceRng([10, 1, 10, 1, 10]) });
    assert.equal(same.kind, 'legendary');
    assert.equal(same.reversed, false);
    assert.equal(same.label, '传奇大成功');
});

test('孔明式：resolveEffect=false 时投出大成功就停下等效果表（给 agent 循环用）', () => {
    const r = rollKongming({ resolveEffect: false, rng: createSequenceRng([10, 2]) });
    assert.equal(r.kind, 'fumble');
    assert.equal(r.depth, 1);
    assert.equal(r.effectRoll, null);
    assert.equal(r.needEffectTable, true);
    assert.equal(r.chain.length, 2, '只该投 1d10 和 1d2，不该替 AI 把效果骰也投了');
    assert.equal(formatKongmingReplacement(r.chain), '【1d10=10 → 1d2=2（大失败）】');
});

test('孔明式：选项数可配（不同项数走同一套逻辑）', () => {
    const r = rollKongming({ optionCount: 6, rng: createSequenceRng([4]) });
    assert.equal(r.kind, 'option');
    assert.equal(r.option, 4);
    assert.equal(r.chain[0].expr, '1d6');

    const hitLast = rollKongming({ optionCount: 6, rng: createSequenceRng([6, 1, 3]) });
    assert.equal(hitLast.kind, 'critical');
});

test('孔明式：选项数非法要报错', () => {
    assert.throws(() => rollKongming({ optionCount: 1, rng: createSequenceRng([]) }), /选项数必须是 2/);
    assert.throws(() => rollKongming({ optionCount: 1001, rng: createSequenceRng([]) }), /选项数必须是 2/);
});

test('孔明式：加权靠重复项，由撰写者自己排 —— 引擎只认序号', () => {
    // 这里只验证"序号即选项号"这个契约，加权是排版的事
    const r = rollKongming({ rng: createSequenceRng([3]) });
    assert.equal(r.option, 3);
});
