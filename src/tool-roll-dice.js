/**
 * 把「投骰」注册成**酒馆核心的函数工具**（function calling）。
 *
 * 这是 P2 的地基：以前导演只能把骰子写成正文（`→ 1d10【选项】`），插件再去正则解析、
 * 投骰、回填、打标 —— 那一整套（十项表校验、♛ 抢标、注解降级、格式约束）都是
 * "模型用自然语言描述一次函数调用"带来的歧义，我们一直在给它打补丁。
 *
 * 换成工具调用之后，这条链变成：
 *
 *   模型写叙述 → 调用 `RollDice({expression:"1d10", label:"选项"})`
 *     → **酒馆核心**把参数交给我们的 `action`（`tool-calling.js:773-783`）
 *     → 我们真投骰，把结果字符串**返回给模型**
 *     → 模型拿着真结果继续写，可以再调工具（核心的 `RECURSE_LIMIT = 5`）
 *
 * 结构化参数 + 结构化返回值，**从根上没有"解析失败"这回事**。
 *
 * ## 契约（照抄酒馆核心的官方范本 `extensions/stable-diffusion/index.js:4597`）
 *
 * ```js
 * ToolManager.registerFunctionTool({
 *     name, displayName, description,
 *     parameters: Object.freeze({ $schema, type: 'object', properties: {...}, required: [...] }),
 *     action: async (args) => string,   // ← 返回值就是回传给模型的结果
 * })
 * ```
 * `getContext()` 直接暴露了 `registerFunctionTool` / `unregisterFunctionTool` /
 * `isToolCallingSupported` / `canPerformToolCalls`（`st-context.js:166-170`），
 * 所以**不需要依赖任何别的扩展**。
 *
 * 并不是所有来源都支持工具调用（`isToolCallingSupported()`），所以这条永远要能
 * 降级回文本协议 —— 本模块只负责"工具这一侧"，降级由调用方决定。
 */

/** 工具名。酒馆核心用它去重（同名会覆盖并告警），所以保持稳定、别乱改。 */
export const ROLL_DICE_TOOL_NAME = 'RollDice';

/**
 * 工具参数（JSON Schema）。
 *
 * ⚠️ 两处是**踩过坑之后**定下来的（依据见规范 §7.0.3）：
 *
 * 1. **不要 `$schema`** —— 它不是 Google `Schema` 类型里的字段（属 unsupported keywords），
 *    而且 OpenRouter 按 **Draft 7** 校验 tools 的 schema（`new Validator(parameters, '7')`）✗。
 *    （酒馆对 Gemini 会自己删掉它 ✓ `chat-completions.js:423-425`，但别的来源会原样发出去 ✗）
 *
 * 2. **不要数组参数（原来的 `options: string[]` 已删）** —— Google 官方论坛原文：
 *    malformed function call "is most common when tool inputs are **arrays of objects or long strings**" ✗。
 *    我们原来让模型通过 `options` 传**十项长中文串**，正好命中这条 ✓ → 实测上游直接返回
 *    `native_finish_reason: "MALFORMED_FUNCTION_CALL"` ✓（整条消息 content/reasoning 全空）。
 *    → 十项表改回**文本协议**那条路去渲染 ♛；工具只接受短参数 ✓
 */
export const ROLL_DICE_PARAMETERS = Object.freeze({
    type: 'object',
    properties: {
        expression: {
            type: 'string',
            description: '要投的骰子表达式，形如 "1d10"、"1d100"、"2d6+3"。只写表达式本身，不要写文字说明。',
        },
        label: {
            type: 'string',
            description: '这次投骰在算什么，例如 "选项"、"话术检定"、"伤害"。会出现在结果回执里。',
        },
        target: {
            type: 'integer',
            description: '属性检定用的目标值（1–100）。只有做检定时才给。',
        },
    },
    required: ['expression'],
});

/**
 * 骰值落在选项表的哪一项上。
 *
 * 支持区间写法（`7-8 庚`）——因为十项表允许把两格合并成一行。
 * 返回 null 表示这一项没写（或者号数没铺满），调用方自己决定怎么提醒模型。
 *
 * @param {string[]} options
 * @param {number} value
 * @returns {{index: number, text: string, from: number, to: number}|null}
 */
export function findOptionRow(options, value) {
    if (!Array.isArray(options)) {
        return null;
    }
    const rows = [];
    options.forEach((raw, index) => {
        const line = String(raw ?? '').trim();
        const match = /^(\d+)\s*(?:[-–~]\s*(\d+))?\s*[.、)）:：]?\s*(.*)$/.exec(line);
        if (!match) {
            // 没有号数前缀的，按顺序当作第 index+1 项
            rows.push({ from: index + 1, to: index + 1, text: line, index });
            return;
        }
        rows.push({
            from: Number(match[1]),
            to: match[2] ? Number(match[2]) : Number(match[1]),
            text: String(match[3] ?? '').trim() || line,
            index,
        });
    });
    const hit = rows.find((row) => value >= row.from && value <= row.to);
    return hit ? { ...hit } : null;
}

/**
 * 把一次选项投骰渲染成人看的文本（工具调用会显示在聊天里）。
 *
 * 这里就是**♛ 的新家**：命中行由我们标，不是模型标 ——
 * 以前"模型抢着标、还标错行"的问题从根上没有了。
 *
 * @param {{label?: string, options?: string[], expression: string, total: number, mark?: string}} input
 */
export function renderOptionTable({ label, options, expression, total, mark = '♛' }) {
    const head = label ? `${label}` : '选项';
    const lines = [`${head}：投 ${expression} = ${total}`];
    const hit = findOptionRow(options, total);
    (options ?? []).forEach((raw, index) => {
        const line = String(raw ?? '').trim();
        const row = (() => {
            if (!hit) {
                return null;
            }
            return hit.index === index ? hit : null;
        })();
        lines.push(row ? `${line} ${mark}` : line);
    });
    if (lines.length === 1) {
        return `${expression} = ${total}`;
    }
    return lines.join('\n');
}

/**
 * 造工具定义。
 *
 * @param {object} options
 * @param {(expression: string, context: {label?: string}) => {expr: string, total: number, detail?: string}} options.roll
 *   真投骰。由调用方注入（这样这个模块不依赖骰子引擎，也好测）。
 * @param {(event: object) => void} [options.onRoll] 每投一次的回调（记日志、刷新面板用）
 * @param {() => string} [options.mark] 当前命中符号（可配置，可能为空串）
 * @param {boolean} [options.verbose] 是否把整张选项表渲染进聊天（默认 true）
 * @returns {object} 可直接交给 `ctx().registerFunctionTool(...)`
 */
export function buildRollDiceTool({ roll, onRoll, mark = () => '♛', verbose = true }) {
    if (typeof roll !== 'function') {
        throw new TypeError('buildRollDiceTool 需要一个 roll 函数');
    }

    return {
        name: ROLL_DICE_TOOL_NAME,
        displayName: '投骰',
        description: [
            '投一次骰子，结果由本插件真实随机产生（不可预测、不可改）。',
            '需要决定剧情走向、判定成败、判定选项、算伤害时调用它。',
            '如果这次投骰是在决定一张选项表，请把整张表通过 options 传进来（按号数顺序），',
            '这样插件会把表原样展示并标出命中项。',
            '一次回复里可以调用多次（核心最多递归 5 次）。',
        ].join(' '),
        parameters: ROLL_DICE_PARAMETERS,
        stealth: false,
        action: async (args) => {
            const expression = String(args?.expression ?? '').trim();
            if (!expression) {
                throw new Error('缺少 expression（例如 "1d10"）');
            }
            const label = String(args?.label ?? '').trim() || undefined;
            const result = roll(expression, { label });
            const total = Number(result?.total);
            if (!Number.isFinite(total)) {
                throw new Error(`骰子引擎没有给出结果：${expression}`);
            }

            const options = Array.isArray(args?.options) ? args.options.map((item) => String(item)) : undefined;
            if (typeof onRoll === 'function') {
                onRoll({
                    expression,
                    label,
                    total,
                    options,
                    target: Number.isFinite(Number(args?.target)) ? Number(args.target) : undefined,
                    roll: result,
                });
            }

            // 返回给模型的是**短回执**（它不需要看整张表，表在我们这边渲染给人看）
            const hit = findOptionRow(options, total);
            const head = label ? `${label}：` : '';
            const tail = hit ? `　命中第 ${hit.from}${hit.to !== hit.from ? `-${hit.to}` : ''} 项：${hit.text}` : '';
            return `【${result.expr ?? expression}=${total}】${head ? `（${head.replace(/：$/, '')}）` : ''}${tail}`;
        },
        formatMessage: (args) => {
            const expression = String(args?.expression ?? '').trim();
            const label = String(args?.label ?? '').trim();
            const options = Array.isArray(args?.options) ? args.options.map((item) => String(item)) : undefined;
            if (!verbose || !options || options.length === 0) {
                return label ? `投骰：${expression}（${label}）` : `投骰：${expression}`;
            }
            // 这里没有总点数（formatMessage 拿不到 action 的返回值），所以只渲染表头 + 表体；
            // 命中标记由 action 阶段记在 rollLog 里，渲染时由调用方补上（见 index.js 的注入器）。
            const lines = [label ? `${label}：投 ${expression}` : `投 ${expression}`];
            const hitRow = findOptionRow(options, Number(args?.total));
            options.forEach((raw, index) => {
                const line = String(raw ?? '').trim();
                lines.push(hitRow && hitRow.index === index ? `${line} ${mark()}`.trimEnd() : line);
            });
            return lines.join('\n');
        },
    };
}

/**
 * 能不能用工具调用。
 *
 * 酒馆核心给了 `isToolCallingSupported()`（`st-context.js:168`）—— 但它是**按当前 API 来源**
 * 判断的，所以既要在注册前问一次，也要在来源变化时重新问（见 index.js 的监听）。
 *
 * @param {object} context `getContext()` 的返回值
 * @returns {boolean}
 */
export function canUseDiceTool(context) {
    try {
        if (typeof context?.isToolCallingSupported !== 'function') {
            return false;
        }
        return Boolean(context.isToolCallingSupported());
    } catch {
        return false;
    }
}
