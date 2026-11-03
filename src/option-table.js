/**
 * ============================================================================
 *  选项表命中标注
 * ============================================================================
 *  孔明式的选项骰投完之后，读者最想知道的是"投中了哪一行"。AI 经常忘了标，
 *  或者标错行 —— 所以这件事交给插件做：**谁投的骰子，谁负责标结果**。
 *
 *  做法：从骰子结果的位置**往回**读若干行，认出选项表，算出骰值落在哪一段，
 *  在那一行末尾打上特殊符号（默认 ♛）。
 *
 *  输出形如：
 *      先去哪边打听 —— 选项骰十项：
 *        1-3 酒馆
 *        4-6 货栈
 *        7-9 码头管事 ♛
 *        10 【1D2】大成功·大失败
 *      →【1d10=7】
 *
 *  认不出来就**什么都不做** —— 宁可不标，也别把正文改坏。
 *  纯逻辑，不碰酒馆 API，可在 Node 里单测。
 * ============================================================================
 */

/** 默认的命中符号。 */
export const DEFAULT_HIT_MARK = '♛';

/** 区间行：`1-3 酒馆`、`1 – 3 酒馆`、`1～3 酒馆`、`1-3. 酒馆` */
const RANGE_ROW_RE = /^(\s*)(\d+)\s*[-–—~〜～]\s*(\d+)\s*[.、,:：)）]?\s*(\S.*)$/;

/** 单值行：`10 大成功/大失败`、`1. 酒馆`、`3、码头`、`5）甲板` */
const SINGLE_ROW_RE = /^(\s*)(\d+)(?:\s*[.、,:：)）]\s*|\s+)(\S.*)$/;

/** 只由箭头和标点组成的"请求行"，往回读的时候要允许跳过它 */
const CONNECTOR_RE = /^[→←\-–—>:：\s]+$/;

/** 表头常见的字样 */
const HEADER_WORD_RE = /(选项|骰|表|项)/;

/** 行数到这么多，就算没表头也认（正文里很难凭空出现 5 行以上的连续编号） */
const ROWS_WITHOUT_HEADER = 5;

/**
 * 这一行像不像"给表格开的头"。
 *
 * 这是**防误伤的第二道闸**：正文里出现
 *     他给了三条路让我选。
 *     1 走吧
 *     2 留下
 * 这种形状时，光靠"编号从 1 连续铺满"是分不出来的，得再看它上面那行是不是表头。
 * @param {string} line
 */
export function isHeaderLike(line) {
    const text = String(line ?? '').trim();
    if (text === '') {
        return false;
    }
    if (HEADER_WORD_RE.test(text)) {
        return true;
    }
    // 以冒号结尾的短行，像是"给列表开的头"
    return /[：:]\s*$/.test(text) && text.length <= 40 && !/[。！？!?]/.test(text);
}

/**
 * 解析一行选项。
 * @param {string} line
 * @returns {{from: number, to: number, text: string} | null}
 */
export function parseOptionRow(line) {
    if (typeof line !== 'string') {
        return null;
    }

    const range = RANGE_ROW_RE.exec(line);
    if (range) {
        const from = Number(range[2]);
        const to = Number(range[3]);
        if (from <= to) {
            return { from, to, text: range[4] };
        }
        return null;
    }

    const single = SINGLE_ROW_RE.exec(line);
    if (single) {
        const value = Number(single[2]);
        return { from: value, to: value, text: single[3] };
    }

    return null;
}

/**
 * 这些行是不是恰好把 1..N 铺满、没有洞也没有重叠。
 *
 * 这是**防误伤的关键**：正文里随便一段带编号的列表（`1 走吧` / `2 留下`）也符合行的形状，
 * 但只有"从 1 开始、连续铺满"才可能是孔明式的选项表。不满足就宁可不标。
 * @param {Array<{from: number, to: number}>} rows
 */
export function coversFromOne(rows) {
    if (rows.length === 0) {
        return false;
    }
    const sorted = [...rows].sort((a, b) => a.from - b.from);
    if (sorted[0].from !== 1) {
        return false;
    }
    let expected = 1;
    for (const row of sorted) {
        if (row.from !== expected) {
            return false;
        }
        expected = row.to + 1;
    }
    return true;
}

/**
 * 从 `text` 里第 `resultIndex` 个字符处往回找选项表，给命中行打上符号。
 *
 * 返回**对象**而不是字符串，因为"没改动"有好几种含义，调用方需要区分：
 *   · `marked`    —— 这次打上了
 *   · `already`   —— 命中行本来就标着（模型自己标对了）
 *   · 返回 `null` —— 真正没认出这张表（这才该报警告）
 * `corrected` 是被我们擦掉的"抢标"行数（模型标错了行）。
 *
 * @param {string} text 完整文本
 * @param {number} resultIndex 骰子结果（`【1d10=7】`）在 text 里的起点
 * @param {number} value 骰值
 * @param {{mark?: string}} [options]
 * @returns {{text: string, status: string, corrected: number, slots: number, distinct: number, critMismatch: boolean}|null}
 */
export function markRowBefore(text, resultIndex, value, { mark = DEFAULT_HIT_MARK } = {}) {
    if (!mark || resultIndex <= 0 || resultIndex > text.length) {
        return null;
    }

    const before = text.slice(0, resultIndex);
    const lines = before.split('\n');

    /** @type {Array<{index: number, from: number, to: number, text: string}>} */
    const rows = [];
    let phase = 'tail';
    let headerLike = false;
    let reachedTop = true;

    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        const trimmed = line.trim();

        if (trimmed === '') {
            // 表里的空行、或者请求行前后的空行，都跳过
            continue;
        }
        if (phase === 'tail' && CONNECTOR_RE.test(trimmed)) {
            // 形如 `→ ` 的请求行
            continue;
        }

        const parsed = parseOptionRow(line);
        if (parsed) {
            rows.unshift({ index: i, ...parsed });
            phase = 'rows';
            continue;
        }

        // 碰到不认识的行就收手，并记下它像不像表头
        headerLike = isHeaderLike(trimmed);
        reachedTop = false;
        break;
    }

    if (!coversFromOne(rows)) {
        return null;
    }
    // 第二道闸：铺满 1..N 还不够 —— 正文里也能出现连续编号。
    // 要么上面那行像表头，要么已经读到正文开头，要么行数多到不像巧合。
    if (!headerLike && !reachedTop && rows.length < ROWS_WITHOUT_HEADER) {
        return null;
    }

    const hit = rows.find((row) => value >= row.from && value <= row.to);
    if (!hit) {
        return null;
    }

    // 表格形态诊断（用来回喂给模型）：
    //   · slots   覆盖到的号位数（十项表应该是 10）
    //   · distinct 互不相同的走向数（一条占满八格就等于只有一个选项）
    //   · critSlot 命中行是不是最后一项、且那行写的是大成功/大失败
    // 最后一条能抓到一个自相矛盾的产物：第 10 项写着「去赌场」，骰子却按 crit 走了
    // 1d2 连投、还把那行标了命中 —— 表在说一件事，回执在说另一件。
    const rowsByNumber = new Map();
    for (const row of rows) {
        for (let n = row.from; n <= row.to; n += 1) {
            rowsByNumber.set(n, row);
        }
    }
    const slots = rowsByNumber.size;
    const distinct = new Set(rows.map((row) => String(row.text ?? '').trim())).size;
    const maxSlot = Math.max(...rowsByNumber.keys());
    const hitIsLastSlot = value === maxSlot;
    const hitText = String(rowsByNumber.get(value)?.text ?? '');
    const critSlot = /【\s*1\s*[dD]\s*2\s*】|1\s*[dD]\s*2|大成功|大失败/.test(hitText);

    const original = lines[hit.index];
    /** 去掉行尾的标记（模型自己打错行时要擦掉）。 */
    const stripMark = (line) => (line.trimEnd().endsWith(mark)
        ? line.trimEnd().slice(0, -mark.length).replace(/\s+$/, '')
        : null);

    // 模型抢着打标是常见事，而且**经常打错行**（它不擅长"结果落在哪一段"）。
    // 谁投的骰子谁负责标 —— 所以：命中行已经标了就认下（不要叠第二个），
    // 别的行上那份**擦掉**（不然一张表两个 ♛，读者根本不知道该信哪个）。
    let corrected = 0;
    for (const row of rows) {
        if (row.index === hit.index) {
            continue;
        }
        const stripped = stripMark(lines[row.index]);
        if (stripped !== null) {
            lines[row.index] = stripped;
            corrected += 1;
        }
    }

    if (stripMark(original) !== null) {
        // 命中行本来就标着（模型标对了）—— 只需把上面擦掉的改动写回去；
        // 没改动也返回原文（调用方会原样赋值回来，幂等），**不能返回 null** ——
        // null 的含义是"没认出这张表"，那会让调用方把结果丢掉。
        return {
            text: corrected > 0 ? lines.join('\n') + text.slice(resultIndex) : text,
            status: 'already',
            corrected,
            slots,
            distinct,
            critMismatch: hitIsLastSlot && !critSlot,
        };
    }

    lines[hit.index] = `${original.replace(/\s+$/, '')} ${mark}`;
    return {
        text: lines.join('\n') + text.slice(resultIndex),
        status: 'marked',
        corrected,
        slots,
        distinct,
        critMismatch: hitIsLastSlot && !critSlot,
    };
}

/**
 * 批量标注。
 *
 * `hits` 按出现顺序给出，每项 `{ replacement, value, at? }`：
 *   · `replacement` 是已经写进正文的骰子结果文本（如 `【1d10=7】`）
 *   · `value` 是骰值
 *   · `at` 是它在**最终文本**里的起始下标（有就用它，最精确）
 *
 * 有 `at` 时从后往前打标 —— 打标是在结果之前插入字符，倒着来才不会影响前面的下标。
 *
 * @param {string} text
 * @param {Array<{replacement: string, value: number, at?: number}>} hits
 * @param {{mark?: string}} [options]
 * @returns {{text: string, marked: number, corrected: number}}
 *   `marked` 含"命中行本来就标着"的情况（模型自己标对了也算标上了）；
 *   `corrected` 是**被别人抢标、还被我们擦掉**的行数。
 */
export function markOptionHits(text, hits, { mark = DEFAULT_HIT_MARK } = {}) {
    if (!mark || !Array.isArray(hits) || hits.length === 0) {
        return { text, marked: 0, corrected: 0, shape: { slots: 0, distinct: 0, critMismatch: 0 } };
    }

    const usable = hits.filter((hit) => hit?.replacement && Number.isFinite(hit.value));
    if (usable.length === 0) {
        return { text, marked: 0, corrected: 0, shape: { slots: 0, distinct: 0, critMismatch: 0 } };
    }

    // 诊断聚合：整段里最"薄"的那张表决定要不要回喂（十项表应 10 格/≥5 条不同走向）
    const shape = { slots: Infinity, distinct: Infinity, critMismatch: 0 };
    const absorb = (u) => {
        if (!u) { return; }
        shape.slots = Math.min(shape.slots, Number(u.slots) || 0);
        shape.distinct = Math.min(shape.distinct, Number(u.distinct) || 0);
        if (u.critMismatch) { shape.critMismatch += 1; }
    };

    // 优先用精确下标，从后往前
    if (usable.every((hit) => Number.isFinite(hit.at))) {
        let current = text;
        let marked = 0;
        let corrected = 0;
        for (const hit of [...usable].sort((a, b) => b.at - a.at)) {
            const updated = markRowBefore(current, hit.at, hit.value, { mark });
            if (updated) {
                current = updated.text;
                marked += 1;
                corrected += updated.corrected ?? 0;
                absorb(updated);
            }
        }
        return { text: current, marked, corrected, shape };
    }

    // 退路：按顺序用 indexOf 找
    let current = text;
    let cursor = 0;
    let marked = 0;
    let corrected = 0;

    for (const hit of usable) {
        const index = current.indexOf(hit.replacement, cursor);
        if (index < 0) {
            continue;
        }

        const updated = markRowBefore(current, index, hit.value, { mark });
        if (!updated) {
            cursor = index + hit.replacement.length;
            continue;
        }

        marked += 1;
        corrected += updated.corrected ?? 0;
        absorb(updated);
        cursor = index + (updated.text.length - current.length) + hit.replacement.length;
        current = updated.text;
    }

    return { text: current, marked, corrected, shape };
}
