import test from 'node:test';
import assert from 'node:assert/strict';

import { createSequenceRng } from '../src/dice.js';
import {
    COMBAT_MAX_ROUNDS,
    GRACEFUL_ENDINGS,
    createCombat,
    createUnit,
    describeCombat,
    hitTarget,
    resolveRound,
    resultLabel,
    rollGracefulEnding,
} from '../src/combat.js';

/** 造一场战斗，并把同一个确定性随机源交给后续结算用。 */
function setup(sequence, self, enemy, maxRounds) {
    const rng = createSequenceRng(sequence);
    const combat = createCombat({ self, enemy, rng, maxRounds });
    return { combat, rng };
}

const STRONG = { name: '我', hp: 20, atk: 60, def: 10 };
const WEAK = { name: '敌人', hp: 15, atk: 40, def: 5 };

test('createUnit：hp 至少 1，atk/def 不为负', () => {
    assert.equal(createUnit({ hp: 0 }).maxHp, 1);
    assert.equal(createUnit({ hp: -5 }).maxHp, 1);
    assert.equal(createUnit({ atk: -3, def: -9 }).atk, 0);
    assert.equal(createUnit({ atk: -3, def: -9 }).def, 0);
});

test('先攻：1d100 + 修正，大的先手', () => {
    const { combat } = setup([50, 30], STRONG, WEAK);
    assert.equal(combat.initiative.self, 50);
    assert.equal(combat.initiative.enemy, 30);
    assert.deepEqual(combat.initiative.order, ['self', 'enemy']);
});

test('先攻：敌方更高时敌方先手', () => {
    const { combat } = setup([10, 80], STRONG, WEAK);
    assert.deepEqual(combat.initiative.order, ['enemy', 'self']);
});

test('先攻平手时我方先手（可预测胜过随机）', () => {
    const { combat } = setup([50, 50], STRONG, WEAK);
    assert.deepEqual(combat.initiative.order, ['self', 'enemy']);
});

test('命中目标值 = atk − def，并夹在 5–95', () => {
    assert.equal(hitTarget(60, 5), 55);
    assert.equal(hitTarget(10, 50), 5, '不该变成必不中');
    assert.equal(hitTarget(200, 0), 95, '不该变成必中');
});

test('一轮：命中造成伤害，未命中不掉血', () => {
    // 先攻 [50, 30] → 我方先手
    // 我方 1d100=20 ≤ 55 命中，1d10=5 → 伤害 5+6=11 → 敌人 15-11=4
    // 敌方 1d100=90 > 30 未命中
    const { combat, rng } = setup([50, 30, 20, 5, 90], STRONG, WEAK);
    const round = resolveRound(combat, { rng });

    assert.equal(round.round, 1);
    assert.equal(round.finished, false);
    assert.equal(round.actions.length, 2);
    assert.equal(round.actions[0].hit, true);
    assert.equal(round.actions[0].damage, 11);
    assert.equal(round.actions[1].hit, false);
    assert.equal(combat.enemy.hp, 4);
    assert.equal(combat.self.hp, 20);
});

test('大成功：命中且伤害翻倍', () => {
    // 我方 1d100=3 → 大成功，1d10=4 → (4+6)*2 = 20 ≥ 敌人 15 → 直接打完
    const { combat, rng } = setup([50, 30, 3, 4], STRONG, WEAK);
    const round = resolveRound(combat, { rng });

    assert.equal(round.actions[0].critical, true);
    assert.equal(round.actions[0].damage, 20);
    assert.equal(round.finished, true);
    assert.equal(round.result, 'selfWin');
    assert.equal(combat.enemy.hp, -5);
});

test('大失败：不命中，自己吃反伤', () => {
    // 我方 1d100=98 → 大失败，1d10=6 → 反伤 ceil((6+6)/2)=6
    // 敌方 1d100=50 > 30 → 未命中
    const { combat, rng } = setup([50, 30, 98, 6, 50], STRONG, WEAK);
    const round = resolveRound(combat, { rng });

    assert.equal(round.actions[0].fumble, true);
    assert.equal(round.actions[0].hit, false);
    assert.equal(round.actions[0].recoil, 6);
    assert.equal(combat.self.hp, 14);
    assert.equal(combat.enemy.hp, 15, '敌人不该掉血');
});

test('打完一轮之后不会再结算', () => {
    const { combat, rng } = setup([50, 30, 3, 4], STRONG, WEAK);
    resolveRound(combat, { rng });
    const again = resolveRound(combat, { rng });
    assert.equal(again.finished, true);
    assert.equal(again.actions.length, 0);
    assert.equal(combat.round, 1, '已结束的战斗不该继续加轮次');
});

test(`第 ${COMBAT_MAX_ROUNDS} 轮打完仍未分胜负 → 强制丝滑收场`, () => {
    // 双方都打不中（骰值恒为 50），5 轮 × 2 次攻击 = 10 次，第 11 个值给收场骰
    const sequence = [50, 30, ...Array(10).fill(50), 7];
    const { combat, rng } = setup(sequence, { ...STRONG, atk: 10, def: 50 }, { ...WEAK, atk: 10, def: 50 });

    let last = null;
    for (let i = 0; i < COMBAT_MAX_ROUNDS; i += 1) {
        last = resolveRound(combat, { rng });
        if (last.finished) {
            break;
        }
    }

    assert.equal(combat.finished, true);
    assert.equal(combat.result, 'graceful');
    assert.equal(combat.round, COMBAT_MAX_ROUNDS);
    assert.ok(last.gracefulEnd, '该带上丝滑收场的结果');
    assert.equal(last.gracefulEnd.option, 7);
    assert.equal(last.gracefulEnd.text, GRACEFUL_ENDINGS[6]);
    assert.match(last.gracefulEnd.replacement, /^【1d10=7】$/);
});

test('丝滑收场：投出 10 → 走大成功/大失败分支', () => {
    const fumble = rollGracefulEnding(createSequenceRng([10, 2, 4]));
    assert.equal(fumble.kind, 'fumble');
    assert.match(fumble.text, /大失败/);
    assert.match(fumble.replacement, /1d10=10 → 1d2=2（大失败）→ 1d10=4/);

    const critical = rollGracefulEnding(createSequenceRng([10, 1, 6]));
    assert.equal(critical.kind, 'critical');
    assert.match(critical.text, /大成功/);
});

test('丝滑收场：嵌套到上限还出 10 → 传奇收场', () => {
    const legendary = rollGracefulEnding(createSequenceRng([10, 1, 10, 2, 10]));
    assert.equal(legendary.kind, 'legendary');
    assert.match(legendary.text, /传奇收场/);
});

test('丝滑收场表本身是十项且第 10 项是大成功/大失败', () => {
    assert.equal(GRACEFUL_ENDINGS.length, 10);
    assert.equal(GRACEFUL_ENDINGS[9], '【1D2】大成功 / 大失败');
});

test('describeCombat 给面板和提示词用', () => {
    const { combat } = setup([50, 30], STRONG, WEAK);
    assert.match(describeCombat(combat), /第 0\/5 轮 · 进行中 · 我 HP 20\/20 · 敌人 HP 15\/15/);
    assert.equal(describeCombat(null), '无战斗');
});

test('战斗结果标签齐全', () => {
    assert.equal(resultLabel('selfWin'), '我方获胜');
    assert.equal(resultLabel('selfDead'), '我方战死');
    assert.equal(resultLabel('graceful'), '丝滑收场');
    assert.equal(resultLabel('ongoing'), '进行中');
    assert.equal(resultLabel('什么鬼'), '进行中', '未知结果不该炸');
});

test('★ 我方 HP 归零 = 真的战死（不是含糊的"打完了"）', () => {
    // 我方 HP 只有 1、ATK 0（打不动人）；敌方 ATK 90 基本必中
    // 先攻 [80, 10] → 我方先手
    // 我方 1d100=50 > 目标值 5 → 未命中
    // 敌方 1d100=30 ≤ 目标值 90 → 命中，1d10=6 → 伤害 6+9=15 ≥ 1
    const { combat, rng } = setup(
        [80, 10, 50, 30, 6],
        { name: '我', hp: 1, atk: 0, def: 0 },
        { name: '敌人', hp: 30, atk: 90, def: 0 },
    );
    const round = resolveRound(combat, { rng });

    assert.equal(round.finished, true);
    assert.equal(round.result, 'selfDead', '我方死就是真死，不是"落败"');
    assert.ok(combat.self.hp < 0, 'HP 允许为负，留给上层显示');
    assert.equal(resultLabel(round.result), '我方战死');
});

test('敌方 HP 归零只是"我方获胜"，生死留给描写', () => {
    const { combat, rng } = setup([80, 10, 3, 4], { name: '我', hp: 20, atk: 60, def: 10 }, WEAK);
    const round = resolveRound(combat, { rng });
    assert.equal(round.result, 'selfWin');
    assert.ok(!JSON.stringify(round).includes('死'), '胜负结果里不该出现"死"字');
});
