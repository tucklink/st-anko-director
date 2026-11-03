/**
 * ============================================================================
 *  导演循环 —— 截断续写 + 内联骰子（设计书 §4.2）
 * ============================================================================
 *  这个模块**不碰酒馆 API**：生成靠注入的 generate 回调，随机靠注入的 rng。
 *  所以在 Node 里可以用一个"假模型"把整个循环跑一遍，逐轮验证。
 *
 *  循环长这样：
 *      调模型（prefill = 已定稿）
 *        → 没有骰子表达式？  → 本轮即定稿，结束
 *        → 有？              → 左到右全部结算、原地替换、文本保留
 *        → 回上面
 *
 *  上限轮数、连续无进展跳出、非法片段回喂、可中断，都有。
 * ============================================================================
 */

import { defaultRng, rollExpression } from './dice.js';
import {
    formatCheckReplacement,
    formatKongmingReplacement,
    rollBackground,
    rollCheck,
    rollKongming,
    rollYesNo,
} from './rules.js';
import {
    findDiceUnits,
    findInvalidDiceLike,
    formatRoll,
    stripEcho,
} from './inline.js';
import { DEFAULT_HIT_MARK, markOptionHits } from './option-table.js';
import { DIRECTOR_SYSTEM_PROMPT, buildDirectorPrompt } from './prompts.js';

/** 连续多少轮「已定稿长度没增加」就放弃。 */
const MAX_STALL = 2;

/** 一轮里出现非法骰子片段时，最多让它重写几次。 */
const MAX_FIX_ATTEMPTS = 2;

/** 默认轮数上限。一个回合常常要投 3–7 次骰子，一次骰子就是一轮，所以别设太小。 */
const DEFAULT_MAX_ROUNDS = 12;

/**
 * 大成功/大失败欠下的效果表，最多额外给这么多轮。
 *
 * 用户的规矩：**大成功/大失败的连投与效果表不占"一回合 1–4 次骰点"的预算**。
 * 所以它也不该占轮数预算 —— 否则额度一满，效果表就投不出来了。
 */
const MAX_EFFECT_BONUS = 2;
/**
 * 十项表的合规线（用户在面板外定的规矩）：
 * 铺满 1–10、至少有 5 条互不相同的走向。
 * 只用来**回喂**（进 corrections 让模型下一轮改），不阻止推演。
 */
const TEN_SLOTS = 10;
const MIN_DISTINCT_OPTIONS = 5;

/** 生成失败时的默认重试配置。 */
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1500;

/**
 * 这个错误是不是「请求不能以模型回合结尾」。
 *
 * Google AI Studio（Gemini）会这么拒：`Requests ending with a model turn are not supported.`。
 * 成因就是我们用 `prefill` 续写 —— 酒馆会把它作为**一条 assistant 消息追加在末尾**
 * （`script.js:3604`）。认出来之后**自动回退到内嵌续写**，别让用户自己撞。
 */
export function isModelTurnError(error) {
    return /model turn|ending with a model/i.test(describeError(error));
}

/**
 * 把各种形态的错误弄成一句人话。
 *
 * 必要：酒馆不同路径抛的东西不一样 —— Chat Completion 抛 `Error('Got response status 429')`，
 * 而文本补全那条路径会 `throw await response.json()`，抛的是**一个对象**。
 * 直接 `String(error)` 会得到 `[object Object]`，既没法看、也没法判断该不该重试。
 * @param {unknown} error
 * @returns {string}
 */
export function describeError(error) {
    if (error === null || error === undefined) {
        return '';
    }
    if (typeof error === 'string') {
        return error;
    }
    if (error instanceof Error) {
        const message = String(error.message ?? '');
        // ⚠️ 酒馆有些路径会 `throw new Error(data)`（`data` 是对象）——
        // 于是 `message` 变成**字面量** "[object Object]"，原文全丢（规范 B22 记过）。
        // 遇到这种"没信息"的 message，就下探错误自己的属性去找原文。
        if (message && message !== '[object Object]') {
            return message;
        }
        return describeThrownObject(error) || message || String(error);
    }
    if (typeof error.message === 'string' && error.message) {
        return error.message;
    }
    const dug = describeThrownObject(error);
    if (dug) {
        return dug;
    }
    try {
        const json = JSON.stringify(error);
        // 空对象序列化出来就是 `{}`，没有任何信息量 —— 但总比 `[object Object]` 强
        return !json || json === '{}' ? '（空错误对象）' : json;
    } catch {
        return String(error);
    }
}

/**
 * 从一个"被抛出来的对象"里挖出能看的信息。
 *
 * 酒馆经常不是在抛 `Error`，而是 `throw await response.json()` 之类 —— 抛的是**对象**，
 * 直接 `String()` 只会得到 `[object Object]`。这里按常见字段名下探，最后退化成 JSON。
 *
 * @param {unknown} value
 * @returns {string} 挖不到就返回空串
 */
function describeThrownObject(value) {
    if (!value || typeof value !== 'object') {
        return '';
    }
    for (const key of ['error', 'response', 'body', 'data', 'detail', 'cause']) {
        const inner = value[key];
        if (inner === undefined || inner === null) {
            continue;
        }
        if (typeof inner === 'string' && inner.trim()) {
            return inner.trim().slice(0, 400);
        }
        try {
            const text = JSON.stringify(inner);
            if (text && text !== '{}') {
                return text.slice(0, 400);
            }
        } catch {
            // 循环引用之类，换下一个字段
        }
    }
    try {
        const plain = {};
        for (const [key, item] of Object.entries(value)) {
            if (key !== 'stack') {
                plain[key] = item;
            }
        }
        const text = JSON.stringify(plain);
        return text && text !== '{}' ? text.slice(0, 400) : '';
    } catch {
        return '';
    }
}

/**
 * 这个错误值不值得重试。
 *
 * 限流（429）、网关错误、超时、连接被掐 —— 这些都是**等一下再来就好**的。
 * 而 400 参数错误、内容审核拒绝这类，重试一万次也一样，纯属浪费。
 *
 * 这条是实跑踩出来的：一轮一个骰子、连着生成十几次，很容易撞上限流；
 * 不重试的话第二轮就断，用户看到的就变成"只推演了第一楼"。
 *
 * 状态码用词边界框住，免得 `1500 tokens` 里的 `500` 被误判成网关错误。
 */
export function isTransientError(error) {
    const text = describeError(error).toLowerCase();
    if (!text) {
        return false;
    }
    return /rate\s?limit|too many requests|overload|temporarily|try again|timed? ?out|timeout|econnreset|etimedout|econnrefused|network|fetch failed|socket hang up|\b(429|500|502|503|504)\b/.test(text);
}

/**
 * 最后一轮塞给模型的提醒。
 *
 * 不塞的话会出现这种收尾：`→ 【1d10=3】` 然后**没了** —— 骰子投了却没轮次解释。
 * （这是真实跑出来的问题：一轮一个骰子，8 轮很快打满。）
 */
const FINAL_ROUND_NOTE = '这是最后一轮：**不要再写任何骰子表达式**，'
    + '把已经投出的结果解释清楚、把这一回合写完收尾。';

/** 轮数上限的合法区间。 */
const MIN_ROUNDS = 1;
const MAX_ROUNDS = 50;

/** `1dN` 这种单骰表达式取出面数；不匹配返回 null。 */
function singleDieFaces(expr) {
    const match = /^\s*1\s*[dD]\s*(\d+)\s*$/.exec(String(expr ?? ''));
    return match ? Number(match[1]) : null;
}

/** 把外部传进来的轮数夹到合法区间。注意别用 `|| 默认值` —— 0 是 falsy，会被吃掉。 */
function clampRounds(value, fallback = DEFAULT_MAX_ROUNDS) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }
    return Math.max(MIN_ROUNDS, Math.min(MAX_ROUNDS, Math.trunc(number)));
}

/**
 * 结算一个骰子单元（表达式 + 可选注解）。
 *
 * 注解决定用哪条轨道：
 *   · `【选项】`      → 孔明式（resolveEffect=false：投出大成功/大失败就停下，等模型给效果表）
 *   · `【技能名40】`  → COC 房规3 检定（只认 1d100）
 *   · 无注解          → 纯数值
 *
 * 注解用错骰子时**不抛异常**，而是降级成普通投骰 + 给一条 warning ——
 * 因为在循环里让模型改比重开一次便宜得多。
 *
 * @param {object} unit
 * @param {{rng: Function}} options
 *   （项数不在这里定：它是模型写的骰子面数 1dN 决定的，singleDieFaces() 取的就是它）
 * @returns {{replacement: string, roll: object, note?: string, warning?: string}}
 */
export function resolveUnit(unit, { rng = defaultRng } = {}) {
    const annotation = unit.annotation;

    // --- 是非骰（1d2）---
    // 语义**由插件固定**（1 = 是/进行，2 = 否/不进行）✓ —— 模型只能决定"问什么" ✓
    // 面数不对时不抛异常，降级成普通投骰 + 警告（与选项骰同一个容错策略 ✓）
    if (annotation?.kind === 'yesno') {
        if (String(unit.expr).replace(/\s+/g, '').toLowerCase() !== '1d2') {
            const roll = rollExpression(unit.expr, { rng });
            return {
                replacement: formatRoll(unit.expr, roll.total),
                roll: { ...roll, kind: 'roll' },
                warning: `【是非】注解只能配 1d2，「${unit.expr}」不对，只能按普通投骰处理`,
            };
        }
        const result = rollYesNo({ rng });
        return {
            replacement: `【1d2=${result.total} / 是非 → ${result.label}】`,
            roll: {
                kind: 'yesno',
                expr: unit.expr,
                total: result.total,
                detail: result.detail,
                dice: result.dice,
                label: result.label,
                yes: result.yes,
                needEffectTable: false,
            },
        };
    }

    // --- 背景骰（1d100）---
    // 每 25 一格、四档递进；≤5 大失败、≥96 大成功（**低=坏、高=好**，与旧检定相反 ✓）
    // 表（4 行）由模型写 ✓；crit 时要按老规矩给效果表 ✓
    if (annotation?.kind === 'background') {
        if (String(unit.expr).replace(/\s+/g, '').toLowerCase() !== '1d100') {
            const roll = rollExpression(unit.expr, { rng });
            return {
                replacement: formatRoll(unit.expr, roll.total),
                roll: { ...roll, kind: 'roll' },
                warning: `【背景】注解只能配 1d100，「${unit.expr}」不对，只能按普通投骰处理`,
            };
        }
        const result = rollBackground({ rng });
        return {
            replacement: `【1d100=${result.total} / 背景 → ${result.label}】`,
            roll: {
                kind: 'background',
                expr: unit.expr,
                total: result.total,
                detail: result.detail,
                dice: result.dice,
                label: result.label,
                band: result.band,
                crit: result.crit,
                needEffectTable: result.needEffectTable,
            },
            note: result.needEffectTable
                ? `刚才的背景骰投出了${result.label}。请紧接着给出「${result.label}效果表」`
                    + '（五行：`1-3` / `4-5` / `6-8` / `9` / `10`，第 10 格写 `10 【1D2】大成功/大失败`），'
                    + '然后请求下一个 `→ 1d10【选项】`。'
                : undefined,
        };
    }

    // --- 选项骰 ---
    if (annotation?.kind === 'option') {
        const faces = singleDieFaces(unit.expr);
        if (faces === null || faces < 2) {
            const roll = rollExpression(unit.expr, { rng });
            return {
                replacement: formatRoll(unit.expr, roll.total),
                roll: { ...roll, kind: 'roll' },
                warning: `【选项】注解只能配 1dN（N≥2），「${unit.expr}」不对，只能按普通投骰处理`,
            };
        }

        const result = rollKongming({ optionCount: faces, rng, resolveEffect: false });
        const last = result.chain[result.chain.length - 1];

        return {
            replacement: formatKongmingReplacement(result.chain),
            roll: {
                kind: 'kongming',
                expr: unit.expr,
                total: last.value,
                detail: result.chain.map((c) => `${c.expr}=${c.value}`).join(' → '),
                dice: result.chain.map((c) => c.value),
                label: result.label,
                needEffectTable: result.needEffectTable,
                at: result.at,
            },
            note: result.needEffectTable
                ? `刚才的选项骰投出了${result.label}。请紧接着给出「${result.label}效果表」`
                    + '（十项，第 10 项写 `10 【1D2】大成功/大失败`），然后请求下一个 `→ 1d10【选项】`。'
                    // ⚠️ 这里原先是「双重大成功/大失败」✗ —— 那是**错的命名**：
                    // 导演路径里每张表都是**独立投骰**（`rules.js:172-173` 每次调用 depth 都从 1 开始），
                    // 所以"大成功之后又大失败"不是同一件事叠两次，而是**两件先后发生的事** ✓。
                    // 用户实跑时就撞到了名实不符：表里承诺「双重」，引擎给的是"第二次独立判定" ✗。
                    // 现在按 A+B 定案：**改掉错名**（A）＋**给极性翻转一个专用说法「逆转」**（B）。
                    + '★ 若这张表的第 10 项投出的极性**与刚才相反**（大成功→大失败，或反过来），'
                    + '那这次结果叫「**逆转**」：请写成「逆转带来的连锁反应」，**不要写"双重"**。'
                    + '原因：每一次投骰都是独立的一次，不存在"同向叠加"。'
                : undefined,
        };
    }

    // --- 属性检定 ---
    if (annotation?.kind === 'check') {
        if (unit.expr.replace(/\s+/g, '').toLowerCase() !== '1d100') {
            const roll = rollExpression(unit.expr, { rng });
            return {
                replacement: formatRoll(unit.expr, roll.total),
                roll: { ...roll, kind: 'roll' },
                warning: `检定注解只能配 1d100，「${unit.expr}」不对，只能按普通投骰处理`,
            };
        }

        const roll = rollCheck({ rate: annotation.rate, name: annotation.name, expr: unit.expr, rng });
        return {
            replacement: formatCheckReplacement(roll),
            roll: { ...roll, kind: 'check' },
        };
    }

    // --- 纯数值 ---
    const roll = rollExpression(unit.expr, { rng });
    return { replacement: formatRoll(unit.expr, roll.total), roll: { ...roll, kind: 'roll' } };
}

/**
 * 跑一次导演循环。
 *
 * @param {object} options
 * @param {string} options.userInput 玩家输入
 * @param {string} [options.contextBrief] 上下文简报
 * @param {(req: {systemPrompt: string, prompt: string, prefill: string}) => Promise<string>} options.generate
 *        生成回调。酒馆里传 `generateRaw`，测试里传假模型。
 * @param {(faces: number) => number} [options.rng]
 * @param {number} [options.maxRounds] 轮数上限（1–50，默认 12）
 * @param {boolean} [options.strictCausality] 严格因果模式：强制一轮一骰，丢掉表达式之后的文字
 * @param {'prompt'|'prefill'} [options.continuation] 续写方式：
 *        `prompt`（默认）把已定稿文本放进用户消息 —— 所有 API 都能跑；
 *        `prefill` 交给酒馆的 `prefill`，它会变成一条 assistant 消息 —— **Gemini 会 400**
 *        （`Requests ending with a model turn are not supported`），所以不是默认。
 * @param {string} [options.hitMark] 选项骰命中那一行后面打的符号，默认 `♛`；传空串关掉打标
 * @param {'auto'|'first'|'second'|'third'} [options.person] 叙述人称，见 prompts.js 的 NARRATION_PERSONS
 * @param {number} [options.retryAttempts] 单轮生成失败时最多试几次（默认 3）
 * @param {number} [options.retryDelayMs] 重试的基准等待时间，第 n 次等 `n × 这个值`（默认 1500ms）
 * @param {(ms: number) => Promise<void>} [options.sleep] 注入等待实现，方便测试
 * @param {string} [options.systemPrompt]
 * @param {(event: object) => void} [options.onProgress] 进度回调，用来把过程显示给玩家
 * @param {() => boolean} [options.shouldStop] 返回 true 就中断（接 loader 的停止按钮）
 * @returns {Promise<{outline: string, rolls: object[], rounds: number, reason: string, warnings: string[], transcript: object[]}>}
 */
export async function runDirector({
    userInput,
    contextBrief = '',
    generate,
    rng = defaultRng,
    maxRounds = DEFAULT_MAX_ROUNDS,
    strictCausality = false,
    continuation = 'prompt',
    hitMark = DEFAULT_HIT_MARK,
    person = 'auto',
    retryAttempts = DEFAULT_RETRY_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    systemPrompt = DIRECTOR_SYSTEM_PROMPT,
    onProgress = () => {},
    shouldStop = () => false,
} = {}) {
    if (typeof generate !== 'function') {
        throw new Error('runDirector 需要一个 generate 回调');
    }
    const input = String(userInput ?? '').trim();
    // 空输入是**合法**的：表示"玩家没有再输入，接着前情往下推演一幕"。
    // （prompt 里会写成「（玩家没有输入，请你推进剧情）」）

    const totalRounds = clampRounds(maxRounds);
    // 注意是 `let`：撞上「不能以模型回合结尾」时会当场回退到内嵌续写（见下面的 catch）
    let usePrefill = continuation === 'prefill';
    /** 这一趟里有没有因为 API 拒绝而把 prefill 回退掉（上层据此关掉那个开关）。 */
    let prefillFallback = false;

    let settled = '';
    const rolls = [];
    const warnings = [];
    const transcript = [];
    /** 下一轮要带上的修正提示。 */
    let corrections = [];
    /** 本轮的额外提示（比如"该给大失败效果表了"），每轮重建。 */
    const notes = [];
    let stalled = 0;
    let fixAttempts = 0;
    /**
     * 上一轮投出了大成功/大失败，还**欠一张效果表**。
     *
     * 实跑踩到的：模型投出大失败之后，直接自己编了个后果（"暴君级变异体堵在走廊正中"），
     * 没有按规矩投效果表 —— 于是"后果有多严重"变成了模型说了算，骰子白投了。
     * 孔明式的规矩是：进了第 10 项就得再投一张十项效果表，由骰子决定后果。
     */
    let owedEffectTable = '';

    const finish = (reason) => {
        // 保底：定稿里还剩"像骰子但解析不过去"的片段就明说。
        // 以前这只写进控制台，用户看到的是一段带着 `3d6k4` 的大纲，不知道为什么没投。
        const leftovers = findInvalidDiceLike(settled);
        if (leftovers.length > 0) {
            warnings.push(`定稿里还有 ${leftovers.length} 处无法解析的骰子片段：`
                + leftovers.map((item) => item.raw).join('、'));
        }

        // 收尾时还欠着效果表 → 必须说出来。
        // 这时候模型是**自己编了后果**（不是骰子决定的），而以前这里是完全静默的：
        // 用户拿到一份"大失败的具体后果由 AI 凭空写"的大纲，却以为骰子决定过。
        if (owedEffectTable) {
            warnings.push(`收尾时仍欠着「${owedEffectTable}效果表」—— 这次的效果是模型自己写的，不是骰子投出来的`
                + '（想补投可以把它改写成 `→ 1d10【选项】` 再推一次，或把轮数上限调大）');
        }

        return {
            outline: settled.trim(),
            rolls,
            rounds: transcript.length,
            reason,
            warnings,
            transcript,
            prefillFallback,
        };
    };

    /**
     * 当前这一轮的轮数上限。欠着效果表时会**临时放宽**（见下）。
     * 之所以用变量而不是 `totalRounds`：`for` 的终止条件每轮都会重新求值，
     * 所以轮内改这个变量就能把循环延长 —— 这正是"效果表不占轮数预算"需要的。
     */
    let limit = totalRounds;

    for (let round = 1; round <= limit; round += 1) {
        if (shouldStop()) {
            onProgress({ phase: 'aborted', round });
            return finish('aborted');
        }

        // 还欠着效果表，却已经到最后一轮了 → 额外给一轮（不占轮数预算）。
        // 大成功/大失败是骰子自己要求的，不该被"额度用完了"掐掉。
        if (round === limit && owedEffectTable && limit < totalRounds + MAX_EFFECT_BONUS) {
            limit += 1;
            warnings.push(`欠着${owedEffectTable}效果表，额外给第 ${limit} 轮（不占轮数预算）`);
        }

        // 最后一轮只收尾，不许再开新骰子 —— 否则大纲会停在一个没解释的结果上。
        //
        // ⚠️ 但**欠着效果表的时候不能压这一条**：上面刚可能为了效果表额外给了一轮，
        // 那一轮的 prompt 里如果同时出现「不要再写任何骰子表达式」和「请给出大失败效果表」，
        // 模型会听前者 → 效果表永远不投 → 模型自己编后果，
        // 而 `round < limit` 的补救条件此时又不成立 → **完全静默**（用户实测过）。
        // 所以欠着效果表时，这一条不推，让那一轮去投表。
        if (round === limit && !owedEffectTable) {
            notes.push(FINAL_ROUND_NOTE);
        }

        const prompt = buildDirectorPrompt({
            rolled: {
                option: rolls.filter((r) => r.kind === 'option' || r.kind === 'legendary').length,
                numeric: rolls.filter((r) => r.kind === 'roll').length,
                yesno: rolls.filter((r) => r.kind === 'yesno').length,
                background: rolls.filter((r) => r.kind === 'background').length,
            },
            userInput: input,
            contextBrief,
            corrections,
            notes,
            round,
            settled: usePrefill ? '' : settled,
            person,
            // 轮数上限要传下去：prompt 里的「骰点预算」就是它（见 D55）
            maxRounds: totalRounds,
        });

        onProgress({ phase: 'generating', round, maxRounds: totalRounds, promptChars: prompt.length });

        let output;
        let lastError = null;
        for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
            try {
                output = await generate({
                    systemPrompt,
                    prompt,
                    prefill: usePrefill ? settled : '',
                });
                lastError = null;
                break;
            } catch (error) {
                lastError = error;
                const message = describeError(error);

                // 「请求不能以模型回合结尾」= prefill 的锅。当场回退到内嵌续写再试一次，
                // 而不是把这个坑丢给用户（他只会看到"每轮续写都失败"，也就是"只推演了第一轮"）。
                if (usePrefill && isModelTurnError(error) && !shouldStop()) {
                    usePrefill = false;
                    prefillFallback = true;
                    warnings.push(`这个 API 不接受以模型回合结尾的请求（${message}）`
                        + '，已自动改用内嵌续写重试');
                    onProgress({ phase: 'prefill-fallback', round, message });
                    attempt -= 1; // 这次不计入重试次数：不是又失败了一次，而是换了种正确的方式
                    lastError = null;
                    continue;
                }

                const canRetry = isTransientError(error)
                    && attempt < retryAttempts
                    && !shouldStop();
                warnings.push(`第 ${round} 轮生成失败（第 ${attempt}/${retryAttempts} 次）：${message}`);
                onProgress({
                    phase: 'error',
                    round,
                    message,
                    attempt,
                    willRetry: canRetry,
                    // 请求体积 —— 排除"是不是太长被拒"用
                    promptChars: prompt.length,
                    systemPromptChars: systemPrompt.length,
                    prefillChars: usePrefill ? settled.length : 0,
                });
                if (!canRetry) {
                    break;
                }
                await sleep(retryDelayMs * attempt);
            }
        }

        if (lastError) {
            // 生成失败也要把已经定稿的部分交出去 —— 半份大纲比什么都没有有用
            return { ...finish('error'), error: describeError(lastError) };
        }

        const raw = stripEcho(settled, String(output ?? ''));

        transcript.push({ round, chars: raw.length, settledBefore: settled.length });

        // 模型什么都没吐：别当成"定稿完成"，那是静默失败
        if (raw.trim().length === 0) {
            stalled += 1;
            warnings.push(`第 ${round} 轮模型没有输出任何内容`);
            if (stalled >= MAX_STALL) {
                return finish('stalled');
            }
            continue;
        }

        // 每轮重建提醒；problem 收集本轮的问题（非法片段 + 结算时发现的注解误用）
        notes.length = 0;
        const problems = [];
        for (const item of findInvalidDiceLike(raw)) {
            problems.push(`无法解析的骰子片段「${item.raw}」，请改用合法写法重写那一处`);
            warnings.push(`第 ${round} 轮出现无法解析的片段：${item.raw}`);
        }

        const units = findDiceUnits(raw);

        // 整轮没有一个能投的骰子、却有非法片段 → 丢掉这一轮，带着修正提示重写
        if (units.length === 0 && problems.length > 0 && fixAttempts < MAX_FIX_ATTEMPTS && round < limit) {
            fixAttempts += 1;
            corrections = problems;
            continue;
        }

        // 欠着一张效果表却没投 → 打回去让它补上，不许自己编后果
        if (units.length === 0 && owedEffectTable && fixAttempts < MAX_FIX_ATTEMPTS && round < limit) {
            fixAttempts += 1;
            corrections = [
                `你上一步投出了${owedEffectTable}，但**没有投效果表就自己写了后果**。`
                + `孔明式的规矩是：进了第 10 项就必须再给一张十项效果表，`
                + `用 → 1d10【选项】 让骰子决定后果有多严重（第 10 项写 10 【1D2】大成功/大失败；`
                + `若极性翻转就记作「逆转」，不要写"双重"）。`
                + `不许自己决定后果。现在补上这张效果表并请求投骰。`,
            ];
            warnings.push(`第 ${round} 轮：投出${owedEffectTable}之后没有投效果表，已要求补投`);
            continue;
        }
        fixAttempts = 0;

        if (units.length === 0) {
            settled += raw;
            corrections = [];
            onProgress({ phase: 'done', round, text: raw, rolls: [] });
            return finish('done');
        }

        const before = settled.length;
        const list = strictCausality ? units.slice(0, 1) : units;
        const roundRolls = [];
        /** 选项骰的结果位置，等这一轮拼完再统一给命中行打符号。 */
        const optionHits = [];
        let cursor = 0;
        let piece = '';

        for (const unit of list) {
            piece += raw.slice(cursor, unit.start);
            const outcome = resolveUnit(unit, { rng });
            const replacementAt = piece.length;
            piece += outcome.replacement;
            cursor = unit.end;

            rolls.push(outcome.roll);
            roundRolls.push(outcome.roll);

            // 选项骰：记下"结果在正文里的位置"和"投出的是几"，供打标用
            if (outcome.roll.kind === 'kongming' && Number.isFinite(outcome.roll.dice?.[0])) {
                optionHits.push({
                    replacement: outcome.replacement,
                    value: outcome.roll.dice[0],
                    at: before + replacementAt,
                });
            }

            if (outcome.note) {
                notes.push(outcome.note);
            }
            if (outcome.warning) {
                warnings.push(`第 ${round} 轮：${outcome.warning}`);
                problems.push(outcome.warning);
            }
        }

        // 严格因果模式：表达式之后的文字是在不知道骰值的情况下写的，只能丢掉
        if (!strictCausality) {
            piece += raw.slice(cursor);
        }

        settled += piece;

        // 把选项表里被投中的那一行标出来。这一步纯粹是"插件替 AI 干它老忘的事"：
        // 谁投的骰子谁负责标结果，不指望模型自己对着数字找行。
        if (optionHits.length > 0 && hitMark) {
            const applied = markOptionHits(settled, optionHits, { mark: hitMark });
            if (applied.marked > 0) {
                settled = applied.text;
            }
            // 模型抢着打标，而且标错了行 → 我们擦掉并改正。这不是错误，是常态，报一句就够。
            if ((applied.corrected ?? 0) > 0) {
                warnings.push(`模型自己打了 ${applied.corrected} 处标记而且行不对，已按骰值改正`);
            }
            // 保底：认不出来也要**说出来**，不能默默少一个 ♛ 就完事
            // （注意"命中行本来就标着"算标上了，不会走到这里 —— 那以前会误报成"表格排版不对"）
            if (applied.marked < optionHits.length) {
                warnings.push(`有 ${optionHits.length - applied.marked} 张选项表没能认出命中行`
                    + '（多半是表格没写成"每项独占一行"），那几处只有骰子没有标记');
            }

            // 表格形态**回喂**：这些是"用户定的规矩"（十项表 = 十格、至少 5 条不同走向），
            // 以前只在 prompt 里要求、没有任何检查与纠正，模型写三行也没人管。
            const shape = applied.shape;
            const shapeProblems = [];
            if (shape && Number.isFinite(shape.slots) && shape.slots > 0 && shape.slots < TEN_SLOTS) {
                shapeProblems.push(`选项表只有 ${shape.slots} 格，十项表要铺满 1–10`);
            }
            if (shape && Number.isFinite(shape.distinct) && shape.distinct > 0 && shape.distinct < MIN_DISTINCT_OPTIONS) {
                shapeProblems.push(`整张表只有 ${shape.distinct} 条不同走向，至少要 ${MIN_DISTINCT_OPTIONS} 条`);
            }
            if (shape && shape.critMismatch > 0) {
                shapeProblems.push(`有 ${shape.critMismatch} 张表投中了最后一项，但那一项没写成`
                    + '「10 【1D2】大成功/大失败」—— 骰子已经按大成功/大失败走了 1d2 连投，'
                    + '表里那行却写着别的走向，前后矛盾');
            }
            if (shapeProblems.length > 0) {
                warnings.push(`选项表不合规：${shapeProblems.join('；')}`);
                // 回喂给下一轮（corrections 会被拼进下一轮的 prompt，模型有机会改）
                problems.push(`上一轮的选项表不合规：${shapeProblems.join('；')}。`
                    + '请按十项表的规矩重写：十行铺满 1–10、至少 5 条互不相同的走向、'
                    + '第 10 项固定写「10 【1D2】大成功/大失败」。');
            }
        } else if (optionHits.length > 0 && !hitMark) {
            // 用户把标记符号留空了 —— 这是有意为之，不报警告
        }

        corrections = problems;

        // 看这一轮**最后**投出的那颗骰子：还欠效果表就记下来
        // （只看最后一颗 —— 前面那些的后果早就写完了）
        //
        // ⚠️ 这里必须用 `needEffectTable` 而不是 `kind`：`resolveUnit` 会把 kind 统一
        // 覆盖成 'kongming'（给日志用），所以 `kind === 'critical'` 永远不成立 —— 写测试时踩到了。
        const lastRoll = roundRolls.at(-1);
        owedEffectTable = lastRoll?.needEffectTable ? String(lastRoll.label ?? '大成功/大失败') : '';

        onProgress({ phase: 'rolled', round, text: piece, rolls: roundRolls });

        if (settled.length <= before) {
            stalled += 1;
            if (stalled >= MAX_STALL) {
                warnings.push('连续多轮没有进展，已提前结束');
                return finish('stalled');
            }
        } else {
            stalled = 0;
        }
    }

    warnings.push(`达到轮数上限（${totalRounds}），已用现有定稿收尾`);
    return finish('maxRounds');
}
