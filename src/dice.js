/**
 * ============================================================================
 *  骰子引擎 —— 纯逻辑，不依赖酒馆 API，可在 Node 里直接单测
 * ============================================================================
 *  文法（设计书 §5.1，刻意只做这些）：
 *
 *      expr   := term { ("+" | "-") term }
 *      term   := factor { ("X" | "*") factor }      // 乘法优先于加减、左结合
 *      factor := dice | number
 *      dice   := INT "d" INT [ "k" INT ]            // k = 取最大的 n 颗
 *
 *  明确不做（碰到会给出可读报错，而不是静默忽略）：
 *      #  多轮掷骰      b/p 奖励惩罚骰      h 暗骰      w/ww 骰池
 *      () 括号          / 除法              轮盘骰
 *
 *  随机源可注入（第二个参数 rng），所以测试是确定性的，将来也能做回放。
 * ============================================================================
 */

export const LIMITS = Object.freeze({
    MIN_COUNT: 1,
    MAX_COUNT: 100,
    MIN_FACES: 1,
    MAX_FACES: 1000,
    MAX_KEEP: 100,
});

/** 骰子相关的错误。带 code 方便上层区分处理，带 position 便于在长文本里定位。 */
export class DiceError extends Error {
    /**
     * @param {string} message 给用户看的中文说明
     * @param {string} code 机器可读的错误码
     * @param {number|null} position 在表达式里的字符偏移
     */
    constructor(message, code = 'dice-error', position = null) {
        super(message);
        this.name = 'DiceError';
        this.code = code;
        this.position = position;
    }
}

// ---------------------------------------------------------------------------
// 随机源
// ---------------------------------------------------------------------------

/**
 * 无模偏差地取 [0, n) 的整数。
 * 用 crypto.getRandomValues（浏览器和 Node 都有），**不用 Math.random** ——
 * 骰子是这个插件的立身之本，弱随机等于把"骰子神"降级成"随便编个数字"。
 * @param {number} n 上界（不含）
 * @returns {number} 0 ≤ x < n
 */
export function cryptoRandomInt(n) {
    if (!Number.isInteger(n) || n < 1) {
        throw new DiceError(`随机上界必须是 ≥1 的整数，收到 ${n}`, 'bad-rng-bound');
    }
    if (n === 1) {
        return 0;
    }

    const cryptoObj = globalThis.crypto;
    if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
        throw new DiceError('当前环境没有 crypto.getRandomValues，无法真随机投骰', 'no-crypto');
    }

    // 拒绝采样：把上界裁到 n 的整数倍，舍掉尾部余数，避免取模偏差
    const limit = Math.floor(0x1_0000_0000 / n) * n;
    const buf = new Uint32Array(1);
    let value;
    do {
        cryptoObj.getRandomValues(buf);
        value = buf[0];
    } while (value >= limit);

    return value % n;
}

/** 默认随机源：投一颗 1..faces 的骰子。 */
export const defaultRng = (faces) => cryptoRandomInt(faces) + 1;

// ---------------------------------------------------------------------------
// 词法
// ---------------------------------------------------------------------------

const T = Object.freeze({
    NUMBER: 'number',
    D: 'd',
    K: 'k',
    PLUS: '+',
    MINUS: '-',
    MUL: '*',
    EOF: 'eof',
});

/** 这些字符对应的都是设计书里明确"不做"的语法，单独给报错，别让用户猜。 */
const REJECTED_CHARS = Object.freeze({
    '/': ['不支持除法。乘号请用 * 或 X。', 'no-division'],
    '(': ['不支持括号。', 'no-parens'],
    ')': ['不支持括号。', 'no-parens'],
    '#': ['不支持多轮掷骰 #，一次只投一轮。', 'no-multi-round'],
    'b': ['不支持奖励骰 b。', 'no-bonus-penalty'],
    'B': ['不支持奖励骰 b。', 'no-bonus-penalty'],
    'p': ['不支持惩罚骰 p。', 'no-bonus-penalty'],
    'P': ['不支持惩罚骰 p。', 'no-bonus-penalty'],
    'h': ['不支持暗骰 h。', 'no-hidden'],
    'H': ['不支持暗骰 h。', 'no-hidden'],
    'w': ['不支持骰池 w/ww。', 'no-dice-pool'],
    'W': ['不支持骰池 w/ww。', 'no-dice-pool'],
    ',': ['表达式里不能有逗号。', 'bad-char'],
    '，': ['表达式里不能有全角逗号。', 'bad-char'],
});

const isDigit = (ch) => ch >= '0' && ch <= '9';

/**
 * 把表达式切成 token。
 * @param {string} input
 */
function tokenize(input) {
    /** @type {Array<{type: string, value?: number, raw: string, start: number, end: number}>} */
    const tokens = [];
    let i = 0;

    while (i < input.length) {
        const ch = input[i];

        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            i += 1;
            continue;
        }

        if (isDigit(ch)) {
            let j = i;
            while (j < input.length && isDigit(input[j])) {
                j += 1;
            }
            const raw = input.slice(i, j);
            const value = Number(raw);
            if (!Number.isSafeInteger(value)) {
                throw new DiceError(`数字太大：${raw}`, 'number-too-large', i);
            }
            tokens.push({ type: T.NUMBER, value, raw, start: i, end: j });
            i = j;
            continue;
        }

        if (ch === 'd' || ch === 'D') {
            tokens.push({ type: T.D, raw: ch, start: i, end: i + 1 });
            i += 1;
            continue;
        }
        if (ch === 'k' || ch === 'K') {
            tokens.push({ type: T.K, raw: ch, start: i, end: i + 1 });
            i += 1;
            continue;
        }
        if (ch === '+') {
            tokens.push({ type: T.PLUS, raw: ch, start: i, end: i + 1 });
            i += 1;
            continue;
        }
        if (ch === '-') {
            tokens.push({ type: T.MINUS, raw: ch, start: i, end: i + 1 });
            i += 1;
            continue;
        }
        if (ch === '*' || ch === 'x' || ch === 'X') {
            tokens.push({ type: T.MUL, raw: ch, start: i, end: i + 1 });
            i += 1;
            continue;
        }

        const rejected = REJECTED_CHARS[ch];
        if (rejected) {
            throw new DiceError(rejected[0], rejected[1], i);
        }

        throw new DiceError(`无法识别的字符「${ch}」`, 'bad-char', i);
    }

    tokens.push({ type: T.EOF, raw: '', start: input.length, end: input.length });
    return tokens;
}

// ---------------------------------------------------------------------------
// 语法
// ---------------------------------------------------------------------------

function checkDiceBounds(count, faces, keep, position) {
    if (!Number.isInteger(count) || count < LIMITS.MIN_COUNT || count > LIMITS.MAX_COUNT) {
        throw new DiceError(
            `骰子个数必须在 ${LIMITS.MIN_COUNT}–${LIMITS.MAX_COUNT} 之间，收到 ${count}`,
            'count-out-of-range',
            position,
        );
    }
    if (!Number.isInteger(faces) || faces < LIMITS.MIN_FACES || faces > LIMITS.MAX_FACES) {
        throw new DiceError(
            `骰子面数必须在 ${LIMITS.MIN_FACES}–${LIMITS.MAX_FACES} 之间，收到 ${faces}`,
            'faces-out-of-range',
            position,
        );
    }
    if (keep !== null) {
        if (!Number.isInteger(keep) || keep < 1 || keep > LIMITS.MAX_KEEP) {
            throw new DiceError(`取大数量必须在 1–${LIMITS.MAX_KEEP} 之间，收到 ${keep}`, 'keep-out-of-range', position);
        }
        if (keep > count) {
            throw new DiceError(`取大数量 ${keep} 不能超过骰子个数 ${count}`, 'keep-exceeds-count', position);
        }
    }
}

/**
 * 解析表达式为 AST。失败抛 DiceError。
 * @param {string} input
 * @returns {object} AST
 */
export function parseExpression(input) {
    if (typeof input !== 'string' || input.trim() === '') {
        throw new DiceError('表达式是空的。写个 1d100 试试。', 'empty-expression');
    }

    const tokens = tokenize(input);
    let pos = 0;
    const peek = () => tokens[pos];
    const advance = () => tokens[pos++];

    function parseFactor() {
        const token = peek();

        if (token.type === T.NUMBER) {
            advance();

            if (peek().type === T.D) {
                advance();
                const facesToken = peek();
                if (facesToken.type !== T.NUMBER) {
                    throw new DiceError('d 后面要跟面数，例如 1d100。', 'missing-faces', facesToken.start);
                }
                advance();

                let keep = null;
                if (peek().type === T.K) {
                    advance();
                    const keepToken = peek();
                    if (keepToken.type !== T.NUMBER) {
                        throw new DiceError('k 后面要跟数量，例如 3d6k2。', 'missing-keep', keepToken.start);
                    }
                    advance();
                    keep = keepToken.value;
                }

                checkDiceBounds(token.value, facesToken.value, keep, token.start);
                return { kind: 'dice', count: token.value, faces: facesToken.value, keep };
            }

            return { kind: 'const', value: token.value };
        }

        if (token.type === T.D) {
            throw new DiceError('骰子数量不能省略：写 1d100，不要写 d100。', 'missing-count', token.start);
        }

        throw new DiceError(
            `这里应该是一个数字或骰子，实际看到「${token.raw || '表达式结尾'}」。`,
            'unexpected-token',
            token.start,
        );
    }

    function parseTerm() {
        let node = parseFactor();
        while (peek().type === T.MUL) {
            advance();
            node = { kind: 'bin', op: '*', left: node, right: parseFactor() };
        }
        return node;
    }

    function parseExpr() {
        let node = parseTerm();
        while (peek().type === T.PLUS || peek().type === T.MINUS) {
            const op = advance().type === T.PLUS ? '+' : '-';
            node = { kind: 'bin', op, left: node, right: parseTerm() };
        }
        return node;
    }

    const ast = parseExpr();
    if (peek().type !== T.EOF) {
        throw new DiceError(`表达式之后还有多余内容「${peek().raw}」。`, 'trailing-input', peek().start);
    }
    return ast;
}

/** 表达式是否合法（不抛异常版，给内联扫描器用）。 */
export function isValidExpression(input) {
    try {
        parseExpression(input);
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// 求值
// ---------------------------------------------------------------------------

const OP_SYMBOL = Object.freeze({ '+': '+', '-': '-', '*': '×' });

/**
 * 求值。返回展开后的明细，便于玩家复核。
 * @param {object} ast
 * @param {(faces: number) => number} rng 投一颗骰子返回 1..faces
 */
function evaluate(ast, rng) {
    /** @type {number[]} 所有骰子的原始点数，按投出顺序 */
    const dice = [];

    function walk(node) {
        if (node.kind === 'const') {
            return { value: node.value, text: String(node.value) };
        }

        if (node.kind === 'dice') {
            const rolls = [];
            for (let i = 0; i < node.count; i += 1) {
                const value = rng(node.faces);
                if (!Number.isInteger(value) || value < 1 || value > node.faces) {
                    throw new DiceError(`随机源返回了越界值 ${value}（本应为 1..${node.faces}）`, 'rng-out-of-range');
                }
                rolls.push(value);
                dice.push(value);
            }

            let subtotal = rolls.reduce((sum, v) => sum + v, 0);
            let keptText = '';

            if (node.keep !== null) {
                const kept = rolls
                    .map((value, index) => ({ value, index }))
                    .sort((a, b) => b.value - a.value || a.index - b.index)
                    .slice(0, node.keep)
                    .sort((a, b) => a.index - b.index)
                    .map((x) => x.value);
                subtotal = kept.reduce((sum, v) => sum + v, 0);
                keptText = `→取${kept.join(',')}`;
            }

            const keepLabel = node.keep !== null ? `k${node.keep}` : '';
            return {
                value: subtotal,
                text: `${node.count}d${node.faces}${keepLabel}[${rolls.join(',')}${keptText}]=${subtotal}`,
            };
        }

        const left = walk(node.left);
        const right = walk(node.right);
        const value = node.op === '+' ? left.value + right.value
            : node.op === '-' ? left.value - right.value
                : left.value * right.value;
        return { value, text: `${left.text} ${OP_SYMBOL[node.op]} ${right.text}` };
    }

    const { value, text } = walk(ast);
    return { total: value, detail: text, dice };
}

/**
 * 投骰主入口。
 * @param {string} input 表达式，如 `3d6k2+1`
 * @param {{rng?: (faces: number) => number}} [options]
 * @returns {{expr: string, total: number, detail: string, dice: number[], at: number}}
 */
export function rollExpression(input, { rng = defaultRng } = {}) {
    const expr = String(input ?? '').trim();
    const ast = parseExpression(expr);
    const { total, detail, dice } = evaluate(ast, rng);
    return { expr, total, detail, dice, at: Date.now() };
}

/**
 * 造一个确定性的随机源，仅供测试/回放使用。
 * @param {number[]} sequence 依次返回的点数（1 起）
 */
export function createSequenceRng(sequence) {
    let i = 0;
    return (faces) => {
        if (i >= sequence.length) {
            throw new DiceError(`确定性随机源用光了（第 ${i + 1} 次调用，面数 ${faces}）`, 'rng-exhausted');
        }
        const value = sequence[i++];
        if (!Number.isInteger(value) || value < 1 || value > faces) {
            throw new DiceError(`确定性随机源给出的 ${value} 不在 1..${faces} 内`, 'rng-out-of-range');
        }
        return value;
    };
}
