/**
 * ============================================================================
 *  战斗轮（设计书 §6.2）
 * ============================================================================
 *  社区对"安科战斗系统"没有公认标准（有一堆征集/讨论帖但没结论），所以这套是自定的，
 *  原则是：**能跑、能看懂、不拖**。
 *
 *  规则：
 *    · 单位：{ name, hp, maxHp, atk, def, initMod }
 *    · 先攻：1d100 + initMod，从大到小（开局投一次）
 *    · 命中：攻方投 1d100，目标值 = clamp(自身 atk − 对方 def, 5, 95)，骰值 ≤ 目标值即命中
 *      - 骰值 1–5   大成功 → 伤害 ×2
 *      - 骰值 96–100 大失败 → 未命中，且自己吃一次反伤
 *    · 伤害：1d10 + floor(atk / 10)
 *    · **我方 HP ≤ 0 = 真的战死**（`result = 'selfDead'`）。上层会把它落成持久的死亡状态，
 *      并且明确告诉 agent「人已经死了，别假装他还活着」。没有保底、没有怜悯。
 *    · 敌方 HP ≤ 0 = 倒下（`result = 'selfWin'`）；敌方是死是活留给描写决定
 *
 *  **硬上限 5 轮**：第 5 轮结束仍未分出结果，强制「丝滑收场」——
 *  改投一次孔明式选项骰，决定这场战斗怎么结束（逃跑/中断/增援/谈判/两败俱伤/大成功大失败）。
 *  安科的战斗本来就不必分出胜负，「打不完就散场」比硬判输赢更有戏。
 *
 *  纯逻辑，不碰酒馆 API，可在 Node 里单测。
 * ============================================================================
 */

import { defaultRng, rollExpression } from './dice.js';
import { formatKongmingReplacement, rollKongming } from './rules.js';

/** 战斗轮数硬上限。 */
export const COMBAT_MAX_ROUNDS = 5;

/** 命中目标值的夹取区间 —— 别让战斗变成必中或必不中。 */
export const HIT_CLAMP = Object.freeze({ min: 5, max: 95 });

/** 丝滑收场表（十项，第 10 项由孔明式的 1D2 决定大成功/大失败）。 */
export const GRACEFUL_ENDINGS = Object.freeze([
    '我方抓住空隙脱身，战斗就此打住',
    '我方抓住空隙脱身，战斗就此打住',
    '敌方主动撤退，留下一句场面话',
    '敌方主动撤退，留下一句场面话',
    '第三方插进来打断了这场架',
    '第三方插进来打断了这场架',
    '双方打到一半开始谈条件，暂时停手',
    '双方打到一半开始谈条件，暂时停手',
    '两败俱伤，各自退开，谁也占不到便宜',
    '【1D2】大成功 / 大失败',
]);

/**
 * 造一个战斗单位。hp 会被夹到 1 以上，atk/def 夹到 0 以上。
 * @param {{name?: string, hp?: number, atk?: number, def?: number, initMod?: number}} input
 */
export function createUnit({ name = '无名', hp = 10, atk = 50, def = 0, initMod = 0 } = {}) {
    const maxHp = Math.max(1, Math.trunc(Number(hp) || 1));
    return {
        name: String(name),
        hp: maxHp,
        maxHp,
        atk: Math.max(0, Math.trunc(Number(atk) || 0)),
        def: Math.max(0, Math.trunc(Number(def) || 0)),
        initMod: Math.trunc(Number(initMod) || 0),
    };
}

/**
 * 开一场战斗。
 * @param {{self: object, enemy: object, maxRounds?: number, rng?: Function}} options
 */
export function createCombat({ self, enemy, maxRounds = COMBAT_MAX_ROUNDS, rng = defaultRng } = {}) {
    const mine = createUnit(self ?? { name: '我方' });
    const theirs = createUnit(enemy ?? { name: '敌方' });

    const selfInit = rollExpression('1d100', { rng });
    const enemyInit = rollExpression('1d100', { rng });

    const selfScore = selfInit.total + mine.initMod;
    const enemyScore = enemyInit.total + theirs.initMod;

    return {
        maxRounds: Math.max(1, Math.trunc(maxRounds) || COMBAT_MAX_ROUNDS),
        round: 0,
        finished: false,
        result: 'ongoing',
        self: mine,
        enemy: theirs,
        initiative: {
            self: selfScore,
            enemy: enemyScore,
            selfRoll: selfInit,
            enemyRoll: enemyInit,
            // 平手时我方先手（简单、可预测）
            order: selfScore >= enemyScore ? ['self', 'enemy'] : ['enemy', 'self'],
        },
        log: [],
    };
}

/** 命中目标值。 */
export function hitTarget(atk, def) {
    return Math.max(HIT_CLAMP.min, Math.min(HIT_CLAMP.max, Math.trunc(atk) - Math.trunc(def)));
}

/**
 * 一次攻击（内部用）。
 * @returns {{roll: object, hit: boolean, critical: boolean, fumble: boolean, damage: number, recoil: number}}
 */
function attack(actor, target, rng) {
    const target_ = hitTarget(actor.atk, target.def);
    const roll = rollExpression('1d100', { rng });

    const critical = roll.total <= 5;
    const fumble = roll.total >= 96;
    const hit = !fumble && (critical || roll.total <= target_);

    let damage = 0;
    let recoil = 0;

    if (hit) {
        const dice = rollExpression('1d10', { rng });
        damage = dice.total + Math.floor(actor.atk / 10);
        if (critical) {
            damage *= 2;
        }
        roll.damageRoll = dice;
    } else if (fumble) {
        const dice = rollExpression('1d10', { rng });
        recoil = Math.max(1, Math.ceil((dice.total + Math.floor(actor.atk / 10)) / 2));
        roll.damageRoll = dice;
    }

    return { roll, target: target_, hit, critical, fumble, damage, recoil };
}

/** 结算一次攻击对双方 HP 的影响。 */
function applyAttack(combat, attackerKey, rng) {
    const defenderKey = attackerKey === 'self' ? 'enemy' : 'self';
    const attacker = combat[attackerKey];
    const defender = combat[defenderKey];

    const outcome = attack(attacker, defender, rng);
    defender.hp -= outcome.damage;
    attacker.hp -= outcome.recoil;

    const entry = {
        actor: attackerKey,
        actorName: attacker.name,
        targetName: defender.name,
        target: outcome.target,
        total: outcome.roll.total,
        hit: outcome.hit,
        critical: outcome.critical,
        fumble: outcome.fumble,
        damage: outcome.damage,
        recoil: outcome.recoil,
        detail: outcome.roll.detail,
        dice: outcome.roll.damageRoll ? [outcome.roll.total, ...outcome.roll.damageRoll.dice] : [outcome.roll.total],
        label: outcome.critical ? '大成功' : outcome.fumble ? '大失败' : outcome.hit ? '命中' : '未命中',
    };

    return entry;
}

/**
 * 结算一轮。
 *
 * 第 5 轮打完仍未分出胜负 → 强制丝滑收场（改投孔明式选项骰决定怎么结束）。
 *
 * @param {object} combat createCombat 的返回值（会被就地修改）
 * @param {{rng?: Function}} [options]
 * @returns {{round: number, actions: object[], finished: boolean, result: string, gracefulEnd?: object}}
 */
export function resolveRound(combat, { rng = defaultRng } = {}) {
    if (combat.finished) {
        return { round: combat.round, actions: [], finished: true, result: combat.result };
    }

    combat.round += 1;
    const actions = [];

    for (const key of combat.initiative.order) {
        if (combat.finished) {
            break;
        }
        const entry = applyAttack(combat, key, rng);
        actions.push(entry);

        // 我方 HP 归零 = 真的战死，上层会落成持久状态并告诉 agent
        if (combat.enemy.hp <= 0) {
            combat.finished = true;
            combat.result = 'selfWin';
        } else if (combat.self.hp <= 0) {
            combat.finished = true;
            combat.result = 'selfDead';
        }
    }

    let gracefulEnd;

    if (!combat.finished && combat.round >= combat.maxRounds) {
        gracefulEnd = rollGracefulEnding(rng);
        combat.finished = true;
        combat.result = 'graceful';
    }

    const summary = { round: combat.round, actions, finished: combat.finished, result: combat.result };
    if (gracefulEnd) {
        summary.gracefulEnd = gracefulEnd;
    }

    combat.log.push(summary);
    return summary;
}

/**
 * 丝滑收场：投一次孔明式选项骰，决定战斗以什么方式结束。
 * @param {(faces: number) => number} rng
 */
export function rollGracefulEnding(rng = defaultRng) {
    const result = rollKongming({ optionCount: 10, rng, resolveEffect: true });

    if (result.kind === 'option') {
        return {
            kind: 'option',
            option: result.option,
            text: GRACEFUL_ENDINGS[result.option - 1],
            chain: result.chain,
            replacement: formatKongmingReplacement(result.chain),
        };
    }

    if (result.kind === 'legendary') {
        return {
            kind: 'legendary',
            option: null,
            text: '传奇收场：这场架以谁都想不到的方式结束，双方都成了传说的一部分',
            label: result.label,
            chain: result.chain,
            replacement: formatKongmingReplacement(result.chain),
        };
    }

    return {
        kind: result.kind,
        option: null,
        text: result.kind === 'critical'
            ? '大成功：战局被彻底逆转，我方占尽上风'
            : '大失败：战斗以最糟的方式收场，局势失控',
        label: result.label,
        chain: result.chain,
        replacement: formatKongmingReplacement(result.chain),
    };
}

/** 战斗状态的一行摘要（给面板和提示词用）。 */
export function describeCombat(combat) {
    if (!combat) {
        return '无战斗';
    }
    const state = combat.finished ? `已结束（${resultLabel(combat.result)}）` : '进行中';
    return `第 ${combat.round}/${combat.maxRounds} 轮 · ${state} · `
        + `${combat.self.name} HP ${Math.max(0, combat.self.hp)}/${combat.self.maxHp} · `
        + `${combat.enemy.name} HP ${Math.max(0, combat.enemy.hp)}/${combat.enemy.maxHp}`;
}

/** 战斗结果的短标签。 */
export function resultLabel(result) {
    switch (result) {
        case 'selfWin': return '我方获胜';
        case 'selfDead': return '我方战死';
        case 'graceful': return '丝滑收场';
        case 'aborted': return '中止';
        default: return '进行中';
    }
}
