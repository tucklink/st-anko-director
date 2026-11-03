/**
 * ============================================================================
 *  内联骰子 —— 从自然语言正文里找出未解析的骰子表达式（设计书 §4.3）
 * ============================================================================
 *  规则：
 *    · 裸写：`水路走了1d3天` （不加壳）
 *    · 已经解析过的结果长这样：`【1d3=2】` —— 里面的内容会被**跳过**，不会重复投
 *    · 必须带数量：`1d3` 认，`d3` 不认（避免把正文里的字母 d 当骰子）
 *    · 表达式会向左右贪婪吃：`1d6+1d4+3`、`3d6k2*5` 都算一个表达式
 *    · 遇到不是运算符的字符就停：`1d3天` 只吃 `1d3`
 *
 *  这个模块不依赖酒馆 API，可在 Node 里单测。
 * ============================================================================
 */

import { parseExpression } from './dice.js';

/** 已解析回执的包围符。里面的表达式一律跳过。 */
const BRACKET_PAIR = Object.freeze({ open: '【', close: '】' });

/**
 * 候选起点：必须「数字 d 数字」，这样正文里的 d6、D3、COC7 都不会误伤。
 *
 * ⚠️ **别用这个正则去扫文本** —— 它在「一长串数字」上是 **O(n²)**：
 * 每个起点都要把 `\d+` 吃到结尾，再一位一位回退去找 `d`/`D`。
 * 实测（`_research` 探针）：10 万位数字要 **11.2 秒**、5 万位要 2.8 秒 —— 足够把标签页冻住。
 * 它是"长相"的说明，真正扫描用下面的 `nextDiceCandidate()`（O(n)，结果与它一致）。
 *
 * @deprecated 只作说明用，扫描请走 `nextDiceCandidate()`。
 */
export const DICE_CANDIDATE_RE = /\d+[dD]\d+/g;

/**
 * 从 `from` 开始找下一个「数字 d 数字」候选。
 *
 * 做法是先找 `d`/`D`，再往两侧扩数字 —— 整体 O(n)，没有回溯。
 * 与 `/\d+[dD]\d+/g` 的结果一致：都是"左most 的、以一段数字开头、紧跟 d/D、再接一段数字"。
 *
 * @param {string} text
 * @param {number} from
 * @returns {{start: number, end: number}|null}
 */
export function nextDiceCandidate(text, from = 0) {
    for (let i = from; i < text.length; i += 1) {
        const ch = text[i];
        if (ch !== 'd' && ch !== 'D') {
            continue;
        }
        let start = i;
        while (start > from && isDigit(text[start - 1])) {
            start -= 1;
        }
        if (start === i) {
            continue; // 左边没有数字
        }
        let end = i + 1;
        while (end < text.length && isDigit(text[end])) {
            end += 1;
        }
        if (end === i + 1) {
            continue; // 右边没有数字
        }
        return { start, end };
    }
    return null;
}

const isDigit = (ch) => ch >= '0' && ch <= '9';
const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
const isMulOp = (ch) => ch === '*' || ch === 'x' || ch === 'X';
const isSignOp = (ch) => ch === '+' || ch === '-';

/** 找出所有 【...】 区间，用于跳过已解析结果。 */
function bracketRanges(text) {
    const ranges = [];
    let i = 0;
    while (i < text.length) {
        if (text[i] !== BRACKET_PAIR.open) {
            i += 1;
            continue;
        }
        const close = text.indexOf(BRACKET_PAIR.close, i + 1);
        if (close < 0) {
            break; // 没闭合，后面的内容照常扫描
        }
        ranges.push([i, close + 1]);
        i = close + 1;
    }
    return ranges;
}

const inAnyRange = (ranges, index) => ranges.some(([start, end]) => index >= start && index < end);

function skipSpaces(text, i) {
    let j = i;
    while (j < text.length && isSpace(text[j])) {
        j += 1;
    }
    return j;
}

/** 读一串数字；读不到返回 null。 */
function readDigits(text, i) {
    let j = i;
    while (j < text.length && isDigit(text[j])) {
        j += 1;
    }
    return j > i ? { value: Number(text.slice(i, j)), end: j } : null;
}

/**
 * 从 i 开始读一个 factor：骰子（`NdM[k K]`）或常数。
 * @returns {{end: number, hasDice: boolean}|null}
 */
function readFactor(text, i) {
    const number = readDigits(text, i);
    if (!number) {
        return null;
    }

    const marker = text[number.end];
    if (marker !== 'd' && marker !== 'D') {
        return { end: number.end, hasDice: false };
    }

    const faces = readDigits(text, number.end + 1);
    if (!faces) {
        // 只有 `1d` 这种残缺写法：当成普通数字，让外面的链自己决定要不要吃
        return { end: number.end, hasDice: false };
    }

    let end = faces.end;
    const keepMarker = text[end];
    if (keepMarker === 'k' || keepMarker === 'K') {
        const keep = readDigits(text, end + 1);
        if (keep) {
            end = keep.end;
        }
    }

    return { end, hasDice: true };
}

/** 吃掉一段连续的乘法链，返回新的结束位置。 */
function extendMulChain(text, from) {
    let end = from;
    for (;;) {
        const save = end;
        const opIndex = skipSpaces(text, end);
        if (!isMulOp(text[opIndex])) {
            break;
        }
        const rhs = readFactor(text, skipSpaces(text, opIndex + 1));
        if (!rhs) {
            break;
        }
        end = rhs.end;
        if (end === save) {
            break;
        }
    }
    return end;
}

/**
 * 试着从 index 处匹配一个**以骰子开头**的完整表达式，返回结束下标；失败返回 -1。
 * @param {string} text
 * @param {number} index
 */
export function matchExpressionAt(text, index) {
    const first = readFactor(text, index);
    if (!first || !first.hasDice) {
        return -1;
    }

    let end = extendMulChain(text, first.end);

    // 加减链：每个 term 自己还可能带乘法
    for (;;) {
        const save = end;
        const opIndex = skipSpaces(text, end);
        if (!isSignOp(text[opIndex])) {
            break;
        }
        const rhs = readFactor(text, skipSpaces(text, opIndex + 1));
        if (!rhs) {
            break;
        }
        end = extendMulChain(text, rhs.end);
        if (end === save) {
            break;
        }
    }

    if (end <= index) {
        return -1;
    }

    // 最后用真正的解析器验一遍，保证交给引擎的东西一定合法
    try {
        parseExpression(text.slice(index, end));
    } catch {
        return -1;
    }
    return end;
}

/**
 * 找出正文里所有**未解析**的骰子表达式。
 * @param {string} text
 * @returns {Array<{start: number, end: number, expr: string}>}
 */
export function findExpressions(text) {
    if (typeof text !== 'string' || text.length === 0) {
        return [];
    }

    const ranges = bracketRanges(text);
    const found = [];

    // 线性扫描（理由见 nextDiceCandidate 的注释：正则在这条路上是 O(n²)）
    let cursor = 0;
    for (;;) {
        const candidate = nextDiceCandidate(text, cursor);
        if (!candidate) {
            break;
        }
        const start = candidate.start;
        cursor = candidate.end; // 与正则的 lastIndex 一致：跳过这个候选

        if (inAnyRange(ranges, start)) {
            continue;
        }
        const previous = found[found.length - 1];
        if (previous && start < previous.end) {
            continue;
        }

        const end = matchExpressionAt(text, start);
        if (end > start) {
            found.push({ start, end, expr: text.slice(start, end) });
            cursor = end;
        }
    }

    return found;
}

/** 正文里有没有未解析的骰子表达式。 */
export function hasExpression(text) {
    return findExpressions(text).length > 0;
}

/**
 * 找出「看起来像骰子、但解析不过去」的片段，比如 `3d6k4`（取大超过骰子数）、`1d100/2`。
 *
 * 为什么需要它：mtachExpressionAt 只认合法表达式，所以这类残片不会被投骰，
 * 但也不想让它**静默**留在正文里。上层（agent 循环）拿这个列表去告诉模型改，
 * 比让玩家对着 `3d6k4` 发呆强。
 * @param {string} text
 * @returns {Array<{start: number, end: number, raw: string}>}
 */
export function findInvalidDiceLike(text) {
    if (typeof text !== 'string' || text.length === 0) {
        return [];
    }

    const ranges = bracketRanges(text);
    const valid = findExpressions(text);
    const bad = [];

    let cursor = 0;
    for (;;) {
        const candidate = nextDiceCandidate(text, cursor);
        if (!candidate) {
            break;
        }
        const start = candidate.start;
        cursor = candidate.end;

        if (inAnyRange(ranges, start)) {
            continue;
        }
        if (valid.some((hit) => start >= hit.start && start < hit.end)) {
            continue;
        }
        if (matchExpressionAt(text, start) > start) {
            continue;
        }
        // 尽量把 k 一起带上，报错信息才完整
        let end = candidate.end;
        const keepMatch = /^[kK]\d+/.exec(text.slice(end));
        if (keepMatch) {
            end += keepMatch[0].length;
        }
        bad.push({ start, end, raw: text.slice(start, end) });
    }

    return bad;
}

/**
 * 在**第一个**未解析表达式处切开。给「一轮一骰」的严格因果模式用。
 * @param {string} text
 * @returns {{before: string, expr: string|null, after: string, hit: object|null}}
 */
export function splitAtFirstExpression(text) {
    const hits = findExpressions(text);
    if (hits.length === 0) {
        return { before: text, expr: null, after: '', hit: null };
    }
    const hit = hits[0];
    return { before: text.slice(0, hit.start), expr: hit.expr, after: text.slice(hit.end), hit };
}

/**
 * 把所有未解析表达式原地替换掉。
 * @param {string} text
 * @param {(expr: string, hit: {start: number, end: number}) => (string | {replacement: string, [k: string]: any})} resolver
 *        返回替换文本，或返回 `{replacement, ...}`（多余的字段会原样带进 results，方便挂日志）
 * @returns {{text: string, results: Array<{expr: string, replacement: string, hit: object}>}}
 */
export function resolveExpressions(text, resolver) {
    const hits = findExpressions(text);
    if (hits.length === 0) {
        return { text, results: [] };
    }

    let out = '';
    let cursor = 0;
    const results = [];

    for (const hit of hits) {
        out += text.slice(cursor, hit.start);
        const resolved = resolver(hit.expr, hit);
        const replacement = typeof resolved === 'string' ? resolved : resolved.replacement;
        out += replacement;
        results.push(typeof resolved === 'string'
            ? { expr: hit.expr, replacement, hit }
            : { ...resolved, expr: hit.expr, hit });
        cursor = hit.end;
    }

    out += text.slice(cursor);
    return { text: out, results };
}

/** 纯数值骰的内联回执：`【1d3=2】` */
export function formatRoll(expr, total) {
    return `${BRACKET_PAIR.open}${expr}=${total}${BRACKET_PAIR.close}`;
}

// ---------------------------------------------------------------------------
// 骰子「单元」= 表达式 + 紧跟在它后面的一对方括号注解
// ---------------------------------------------------------------------------
//
//  裸表达式         1d3                        → 纯数值投骰
//  带检定注解       1d100【话术40】             → COC 房规3 检定（⚠️ 用户已定"暂时作废"，只停提示词 ✓）
//  带选项注解       1d10【选项】                → 孔明式选项骰（投出 10 触发大成功/大失败）
//  带是非注解       1d2【是非】                 → 是非骰（1=是/进行，2=否/不进行；语义由插件固定）
//  带背景注解       1d100【背景】               → 背景骰（每 25 一格、四档递进；≤5 大失败、≥96 大成功）
//
//  为什么需要注解：`1d10` 本身分不出是"十项表的选项骰"还是"伤害值"；
//  同理 `1d2` 分不出是"是非骰"还是"伤害"、`1d100` 分不出是"背景骰"还是"检定" ✓。
//  注解和表达式**整块一起被替换**，所以不会留下重复的技能名（这是 M1 踩出来的坑）。

const ANNOTATION_RE = /^【([^】]*)】/;

/**
 * 解析方括号里的注解。
 * @param {string} raw 方括号里的内容
 * @returns {{kind: 'check', name: string, rate: number} | {kind: 'option'} | null}
 */
export function parseAnnotation(raw) {
    const text = String(raw ?? '').trim();
    if (text.length === 0) {
        return null;
    }

    if (/^选项(骰)?$/.test(text)) {
        return { kind: 'option' };
    }

    // 是非骰（1d2）：给"AI 判不了的二选一"用（"他会去滑雪吗"）
    // 语义**由插件固定**（1=是/进行、2=否/不进行）✓ —— 模型只能决定"问什么" ✓
    // 容错几个写法：是非 / 是否 / 判定
    if (/^(是非|是否|判定)$/.test(text)) {
        return { kind: 'yesno' };
    }

    // 背景骰（1d100）：定"世界/角色的既有事实"（"主角家里多有钱"）
    // 每 25 一格、四档递进；≤5 大失败、≥96 大成功；**一次定终身** ✓
    if (/^(背景|背景骰)$/.test(text)) {
        return { kind: 'background' };
    }

    // 「检定 话术 40」「话术40」「图书馆使用 65」
    const match = /^(?:检定)?\s*([^\s\d]+)\s*(\d+)$/.exec(text);
    if (match) {
        const rate = Number(match[2]);
        if (Number.isInteger(rate) && rate >= 1 && rate <= 1000) {
            return { kind: 'check', name: match[1], rate };
        }
    }

    return null;
}

/** 读紧跟在下标 end 之后的注解（如果有）。允许中间夹空格，容错一点。 */
function readAnnotationAfter(text, end) {
    let i = end;
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
        i += 1;
    }
    const match = ANNOTATION_RE.exec(text.slice(i));
    if (!match) {
        return null;
    }
    const parsed = parseAnnotation(match[1]);
    if (!parsed) {
        return null;
    }
    // start 用原始的 end：把中间的空格一起替换掉，免得留下双空格
    return { ...parsed, raw: match[1], start: end, end: i + match[0].length };
}

/**
 * 找出所有骰子单元（表达式 + 可选注解）。
 * @param {string} text
 * @returns {Array<{start: number, end: number, expr: string, annotation: object|null, raw: string}>}
 */
export function findDiceUnits(text) {
    const hits = findExpressions(text);
    const units = [];
    let consumedUntil = -1;

    for (const hit of hits) {
        if (hit.start < consumedUntil) {
            continue;
        }
        const annotation = readAnnotationAfter(text, hit.end);
        const end = annotation ? annotation.end : hit.end;
        units.push({
            start: hit.start,
            end,
            expr: hit.expr,
            annotation,
            raw: text.slice(hit.start, end),
        });
        consumedUntil = end;
    }

    return units;
}

/**
 * 结算所有骰子单元（含注解）。
 * @param {string} text
 * @param {(unit: object) => (string | {replacement: string, [k: string]: any})} resolver
 * @returns {{text: string, results: Array<object>}}
 */
export function resolveDiceUnits(text, resolver) {
    const units = findDiceUnits(text);
    if (units.length === 0) {
        return { text, results: [] };
    }

    let out = '';
    let cursor = 0;
    const results = [];

    for (const unit of units) {
        out += text.slice(cursor, unit.start);
        const resolved = resolver(unit);
        const replacement = typeof resolved === 'string' ? resolved : resolved.replacement;
        out += replacement;
        results.push(typeof resolved === 'string'
            ? { ...unit, replacement }
            : { ...resolved, unit, expr: unit.expr, replacement });
        cursor = unit.end;
    }

    out += text.slice(cursor);
    return { text: out, results };
}

/**
 * 去掉模型「重复已定稿内容」造成的回声。
 *
 * 用 prefill 续写时，模型偶尔会把已定稿的尾巴再抄一遍。抄的部分里如果有
 * `【1d3=2】` 之类的结果，因为被方括号包着所以不会被二次投骰，但正文会出现重复。
 * 这里找出「已定稿的后缀」与「新输出的前缀」的最长重叠并切掉。
 *
 * @param {string} settled 已定稿文本
 * @param {string} raw 本轮新输出
 * @returns {string} 切掉回声之后的文本
 */
export function stripEcho(settled, raw) {
    if (!settled || !raw) {
        return raw;
    }

    // 情况一：整段重抄。内嵌续写模式下（把已定稿放进 user 消息里）这是最常见的翻车方式。
    // 门槛取 8 个字符 —— 再短就可能是巧合了，宁可留着重复也别切掉正文。
    if (settled.length >= 8 && raw.startsWith(settled)) {
        return raw.slice(settled.length);
    }

    const max = Math.min(settled.length, raw.length, 2000);
    // 重叠下限固定 8 个字：不能按已定稿长度缩放 —— 已定稿很长、而模型只重抄了最后一句时，
    // 缩放出来的下限会比实际重叠还大，于是漏检（这是写测试时踩出来的）。
    // 8 个汉字完全相同几乎不可能是巧合；真误伤了也只丢 8 个字，比留下一段重复划算。
    const min = 8;

    for (let length = max; length >= min; length -= 1) {
        if (settled.endsWith(raw.slice(0, length))) {
            return raw.slice(length);
        }
    }

    return raw;
}
