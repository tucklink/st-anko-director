/**
 * ============================================================================
 *  判定规则 —— 双轨（设计书 §5.2）
 * ============================================================================
 *  轨道 A：属性检定，COC 房规 3
 *      1–5        → 大成功
 *      96–100     → 大失败
 *      ≤ 成功率/5 → 极难成功
 *      ≤ 成功率/2 → 困难成功
 *      ≤ 成功率   → 成功
 *      否则       → 失败
 *
 *  轨道 B：选项骰，孔明式
 *      1D10 决定第几项（重复项 = 加权，由撰写者自己排）
 *      投出 10  → 追加 1D2 定大成功(1)/大失败(2)
 *              → 再追加一次 1D10 查「大成功/大失败效果表」
 *              → 效果骰又出 10 → 再 1D2 → **同向**才是"双重大成功/大失败"，
 *                 **翻转**则记「逆转」（A+B 定案：导演路径每张表独立投骰，不是同向叠加 ✓）
 *      最多嵌套 2 层（maxDepth），再往上记为「传奇」
 *
 *  这个模块同样不依赖酒馆 API，可在 Node 里单测。
 * ============================================================================
 */

import { DiceError, LIMITS, defaultRng, rollExpression } from './dice.js';

// ---------------------------------------------------------------------------
// 新增两种骰（用户 2026-10-15 定案）
//
//   轨道 C：**是非骰** `1d2` —— AI 判不了的二选一（"他会去滑雪吗"）
//           语义**由插件固定**：1 = 是/进行，2 = 否/不进行
//   轨道 D：**背景骰** `1d100` —— 定世界/角色的既有事实（"主角家里多有钱"）
//           **每 25 一格、四档递进**；**≤5 大失败、≥96 大成功**（低=坏、高=好）
//           表由模型写 4 行；**一次定终身**
// ---------------------------------------------------------------------------

/**
 * 是非骰（`1d2`）。
 *
 * ⚠️ **语义必须由插件固定，不能交给模型** ✓ —— 用户定案：
 *   1 = 是 / 进行 / 成立
 *   2 = 否 / 不进行 / 不成立
 *
 * 为什么：若让模型自己写「1=去，2=不去」，它想让你去就写「1=去」✗ ——
 * 等于**模型自己选了结果**，骰子白投 ✓。模型只能决定"问什么" ✓，不能决定"哪个算去" ✓。
 *
 * @param {object} [options]
 * @param {Function} [options.rng]
 * @param {string} [options.expression] 只接受 `1d2`（别的面数不是是非骰 ✗）
 * @returns {{kind: string, total: number, yes: boolean, label: string, expr: string, dice: number[], detail: string}}
 */
export function rollYesNo({ rng = defaultRng, expression = '1d2' } = {}) {
    const normalized = String(expression ?? '').replace(/\s+/g, '').toLowerCase();
    if (normalized !== '1d2') {
        throw new DiceError(`是非骰只认 1d2，收到「${expression}」`);
    }
    const roll = rollExpression('1d2', { rng });
    const yes = roll.total === 1;
    return {
        kind: 'yesno',
        total: roll.total,
        yes,
        label: yes ? '是' : '否',
        expr: roll.expr,
        dice: roll.dice,
        detail: roll.detail,
    };
}

/**
 * 背景骰的四档 —— **每 25 一格**（用户定案）✓，**四档是递进关系** ✓。
 *
 * 递进的含义：四行讲的是**同一个尺度的四级**（穷 → 小康 → 富 → 巨富 ✓），
 * 不是四个并列的选项 ✗ —— 所以模型必须写"程度"，不能写"方向" ✓。
 */
export const BACKGROUND_BANDS = Object.freeze([
    { band: 1, from: 1, to: 25 },
    { band: 2, from: 26, to: 50 },
    { band: 3, from: 51, to: 75 },
    { band: 4, from: 76, to: 100 },
]);

/**
 * 背景骰的 crit 边界（用户定案：**低=坏、高=好**）。
 *
 * ⚠️ 注意这与**旧属性检定**的极性**相反** ✗（房规3 是 1–5 大成功、96–100 大失败）——
 * 用户已定"旧的检定极性暂时不要" ✓，所以这里按新极性走 ✓。
 */
export const BACKGROUND_FUMBLE_MAX = 5;
export const BACKGROUND_CRIT_MIN = 96;

/**
 * 背景骰（`1d100`）—— 定"世界/角色的既有事实"。
 *
 * 用户定案：
 *   · **每 25 一格**（1–25 / 26–50 / 51–75 / 76–100）✓，**四档递进** ✓
 *   · **≤5 大失败、≥96 大成功** ✓（低=坏、高=好 ✓）
 *   · **一次定终身** ✓ —— "只投一次"由调用方保证 ✓（引擎不管投没投过 ✓）
 *
 * 四行表由**模型**写 ✓（引擎不知道"家产"还是"武力" ✗），
 * 所以引擎只回答"落在第几档 / 是不是 crit" ✓。
 *
 * @param {object} [options]
 * @param {Function} [options.rng]
 * @param {string} [options.expression] 只接受 `1d100`
 * @returns {{kind: string, total: number, band: number|null, crit: string|null, label: string, needEffectTable: boolean, expr: string, dice: number[], detail: string}}
 */
export function rollBackground({ rng = defaultRng, expression = '1d100' } = {}) {
    const normalized = String(expression ?? '').replace(/\s+/g, '').toLowerCase();
    if (normalized !== '1d100') {
        throw new DiceError(`背景骰只认 1d100，收到「${expression}」`);
    }
    const roll = rollExpression('1d100', { rng });
    const total = roll.total;
    const hit = BACKGROUND_BANDS.find((item) => total >= item.from && total <= item.to) ?? null;

    let crit = null;
    if (total <= BACKGROUND_FUMBLE_MAX) {
        crit = 'fumble';
    } else if (total >= BACKGROUND_CRIT_MIN) {
        crit = 'critical';
    }

    const label = crit === 'fumble'
        ? '大失败'
        : (crit === 'critical' ? '大成功' : `第 ${hit ? hit.band : '?'} 档（共 4 档）`);

    return {
        kind: 'background',
        total,
        band: hit ? hit.band : null,
        crit,
        label,
        // crit 时要按孔明式的老规矩给效果表 ✓（和选项骰一致 ✓）
        needEffectTable: crit !== null,
        expr: roll.expr,
        dice: roll.dice,
        detail: roll.detail,
    };
}

export const CHECK_LEVEL = Object.freeze({
    CRITICAL: 'critical',
    EXTREME: 'extreme',
    HARD: 'hard',
    SUCCESS: 'success',
    FAIL: 'fail',
    FUMBLE: 'fumble',
});

export const CHECK_LABEL = Object.freeze({
    critical: '大成功',
    extreme: '极难成功',
    hard: '困难成功',
    success: '成功',
    fail: '失败',
    fumble: '大失败',
});

/** 房规标识，写进骰点日志，将来加别的房规时用得上。 */
export const RULE_FANGUI_3 = Object.freeze({
    id: 3,
    name: '房规3',
    description: '1–5 大成功，96–100 大失败',
});

/**
 * 按房规 3 判定一次 1D100 检定。
 * @param {number} total 骰值 1–100
 * @param {number} successRate 成功率 1–1000
 * @returns {string} CHECK_LEVEL 之一
 */
export function judgeCheck(total, successRate) {
    if (!Number.isInteger(total) || total < 1 || total > 100) {
        throw new DiceError(`检定值必须是 1–100 的整数，收到 ${total}`, 'bad-check-total');
    }
    if (!Number.isInteger(successRate) || successRate < 1 || successRate > 1000) {
        throw new DiceError(`成功率必须是 1–1000 的整数，收到 ${successRate}`, 'bad-check-rate');
    }

    // 大成功/大失败优先于任何成功率比较 —— 房规 3 就是这么定的
    if (total <= 5) {
        return CHECK_LEVEL.CRITICAL;
    }
    if (total >= 96) {
        return CHECK_LEVEL.FUMBLE;
    }
    if (total <= Math.floor(successRate / 5)) {
        return CHECK_LEVEL.EXTREME;
    }
    if (total <= Math.floor(successRate / 2)) {
        return CHECK_LEVEL.HARD;
    }
    if (total <= successRate) {
        return CHECK_LEVEL.SUCCESS;
    }
    return CHECK_LEVEL.FAIL;
}

/**
 * 投一次属性检定。
 * @param {{rate: number, name?: string, expr?: string, rng?: (faces: number) => number}} options
 */
export function rollCheck({ rate, name = '', expr = '1d100', rng = defaultRng }) {
    const roll = rollExpression(expr, { rng });
    if (roll.total < 1 || roll.total > 100) {
        throw new DiceError(`检定骰必须是 1d100 这种 1–100 的范围，实际投出 ${roll.total}`, 'bad-check-dice');
    }
    const level = judgeCheck(roll.total, rate);
    return {
        ...roll,
        kind: 'check',
        rule: RULE_FANGUI_3.id,
        name,
        rate,
        level,
        label: CHECK_LABEL[level],
    };
}

/** 把检定结果格式化成内联回执：`【1d100=7 / 话术40 → 失败】` */
export function formatCheckReplacement({ expr, total, name = '', rate = null, label }) {
    const who = name ? `${name}${rate ?? ''}` : (rate != null ? String(rate) : '');
    const head = who ? ` / ${who}` : '';
    return `【${expr}=${total}${head} → ${label}】`;
}

// ---------------------------------------------------------------------------
// 孔明式选项骰
// ---------------------------------------------------------------------------

/**
 * 给这一串投骰起名。
 *
 * ⚠️ `reversed` 是 A+B 定案加上的（用户实跑撞到"名实不符"之后改的）：
 * 深层那次 1D2 若**翻转了极性**（大成功→大失败，或反过来），结果就**不是"同向叠加"** ✗ ——
 * 哪怕 depth 已到 2，也不能叫「双重」✓
 *（原实现 `depth === 2` 一律叫「双重大成功/大失败」✗，会把"一次大成功 + 一次大失败"
 *  说成"两次大失败" —— 用户实跑时就是这么被误导的 ✓）
 */
function depthLabel(depth, polarity, reversed = false) {
    const good = polarity === 1;
    if (reversed) {
        // 极性翻转过 → 专用说法「逆转」，并标出**最终落点**
        return good ? '逆转大成功' : '逆转大失败';
    }
    if (depth <= 1) {
        return good ? '大成功' : '大失败';
    }
    if (depth === 2) {
        return good ? '双重大成功' : '双重大失败';
    }
    return good ? `${depth}连大成功` : `${depth}连大失败`;
}

function rollD2(rng, chain) {
    const roll = rollExpression('1d2', { rng });
    const polarity = roll.total;
    chain.push({ expr: roll.expr, value: roll.total, note: polarity === 1 ? '大成功' : '大失败' });
    return polarity;
}

/**
 * 孔明式选项骰。
 *
 * @param {object} [options]
 * @param {number} [options.optionCount] 选项数，默认 10（孔明式就是十项表）
 * @param {(faces: number) => number} [options.rng]
 * @param {boolean} [options.resolveEffect] 是否连效果骰一起投完。
 *        - true（默认，给斜杠命令这种"独立骰子工具"用）：连 1D10 效果骰一起投
 *        - false（给 agent 循环用）：投出大成功/大失败后**停下**，
 *          因为效果表还没写出来 —— 让 agent 先给表，再请求下一个 1D10
 * @param {number} [options.maxDepth] 最多嵌套几层，默认 2（超出记传奇）
 */
export function rollKongming({ optionCount = 10, rng = defaultRng, resolveEffect = true, maxDepth = 2 } = {}) {
    if (!Number.isInteger(optionCount) || optionCount < 2 || optionCount > LIMITS.MAX_FACES) {
        throw new DiceError(`选项数必须是 2–${LIMITS.MAX_FACES} 的整数，收到 ${optionCount}`, 'bad-option-count');
    }

    /** @type {Array<{expr: string, value: number, note?: string}>} */
    const chain = [];
    const at = Date.now();

    const first = rollExpression(`1d${optionCount}`, { rng });
    chain.push({ expr: first.expr, value: first.total });

    if (first.total < optionCount) {
        return {
            kind: 'option',
            option: first.total,
            depth: 0,
            polarity: null,
            effectRoll: null,
            needEffectTable: false,
            label: `选项 ${first.total}`,
            chain,
            at,
        };
    }

    // 命中最后一项 → 大成功 / 大失败
    let depth = 1;
    let polarity = rollD2(rng, chain);
    // 极性有没有被后续那几次 1D2 翻转过（翻转 = "大成功之后又大失败"这种**逆转** ✓）
    let reversed = false;

    if (!resolveEffect) {
        return {
            kind: polarity === 1 ? 'critical' : 'fumble',
            option: null,
            depth,
            polarity,
            reversed, // 永远是 false（这条路径只走到第 1 层就交给模型了 ✓）—— 保持返回形状一致
            effectRoll: null,
            needEffectTable: true,
            label: depthLabel(depth, polarity, reversed),
            chain,
            at,
        };
    }

    for (;;) {
        const effect = rollExpression('1d10', { rng });
        chain.push({ expr: effect.expr, value: effect.total });

        if (effect.total === 10) {
            if (depth < maxDepth) {
                depth += 1;
                const next = rollD2(rng, chain);
                if (next !== polarity) {
                    // 极性翻转 → 这一串不再是"同向叠加" ✓（A+B 定案的核心）
                    reversed = true;
                }
                polarity = next;
                continue;
            }
            return {
                kind: 'legendary',
                option: null,
                depth,
                polarity,
                reversed,
                effectRoll: 10,
                needEffectTable: true,
                // 传奇也带"逆转"信息：到了上限还在翻转，说明这一串极其戏剧化 ✓
                label: reversed
                    ? `传奇逆转${polarity === 1 ? '大成功' : '大失败'}`
                    : `传奇${polarity === 1 ? '大成功' : '大失败'}`,
                chain,
                at,
            };
        }

        return {
            kind: polarity === 1 ? 'critical' : 'fumble',
            option: null,
            depth,
            polarity,
            reversed,
            effectRoll: effect.total,
            needEffectTable: false,
            label: depthLabel(depth, polarity, reversed),
            chain,
            at,
        };
    }
}

/**
 * 把孔明式的投骰链条格式化成内联回执。
 * 选项：`【1d10=7】`；大成功链：`【1d10=10 → 1d2=2（大失败）→ 1d10=4】`
 *
 * 箭头前的空格：中文排版里 `）` 后面不该再空一格，所以前一段以「）」结尾时贴紧，箭头后照常留一格。
 */
export function formatKongmingReplacement(chain) {
    const parts = chain.map((step) => `${step.expr}=${step.value}${step.note ? `（${step.note}）` : ''}`);
    let out = parts[0] ?? '';
    for (let i = 1; i < parts.length; i += 1) {
        const glue = out.endsWith('）') ? '→ ' : ' → ';
        out += `${glue}${parts[i]}`;
    }
    return `【${out}】`;
}
