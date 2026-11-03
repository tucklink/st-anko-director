/**
 * ============================================================================
 *  每聊天的状态：属性 / 战斗 / 自定义表 / 安价池 / 剧情摘要
 * ============================================================================
 *  纯数据 + 纯函数，不碰酒馆 API。落盘由上层塞进 `chatMetadata`
 *  （跟着聊天存档走，切聊天时重新装载）—— 参考规范文档 §7-B18：
 *  切聊天前必须 `saveMetadata()` 立即存，因为防抖版发现聊天变了会**放弃保存**。
 * ============================================================================
 */

import { DiceError, defaultRng, rollExpression } from './dice.js';

export const STATE_VERSION = 1;

/** 车卡默认属性名（COC 风格的九项，去掉体型教育之类只留好用的）。 */
export const DEFAULT_ATTRIBUTE_NAMES = Object.freeze([
    '力量', '敏捷', '体质', '智力', '意志', '外貌', '教育', '幸运',
]);

/** 属性的硬上限（COC 惯例 99）。 */
export const ATTRIBUTE_CAP = 99;

/** 造一份空状态。 */
/** 记住最近几份大纲 —— 这是「连续推演」的记忆。 */
export const MAX_RECENT_OUTLINES = 3;

/** 每份大纲在简报里最多带这么多字（从**结尾**截，因为接续点在结尾）。 */
export const OUTLINE_BRIEF_CHARS = 1200;

export function createState() {
    return {
        version: STATE_VERSION,
        attributes: {},
        combat: null,
        customTables: {},
        bid: { title: '', options: [] },
        /**
         * 最近几份推演出来的大纲。
         *
         * ⚠️ 这个字段的存在理由（实跑踩出来的）：大纲只写在**输入框**里，
         * 玩家没发送的话聊天记录里就没有这一回合 —— 那么下一次推演的上下文简报
         * 完全不知道上一回合发生过什么，于是**每次都从头推演开场**。
         * 用户的原话是"推演本回合，它下一个也只推演第一楼"。
         */
        recentOutlines: [],
        storySoFar: '',
        /** 玩家角色是否已战死。死了就是真死了，会明确告诉 agent。 */
        dead: false,
        /** 死亡原因（哪一场、第几轮、被谁打的）。 */
        deathNote: '',
    };
}

/**
 * 记一份新大纲（最新的在后面）。
 * @param {object} state
 * @param {string} text
 */
export function pushOutline(state, text) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) {
        return { added: false, count: state.recentOutlines?.length ?? 0 };
    }
    if (!Array.isArray(state.recentOutlines)) {
        state.recentOutlines = [];
    }
    // 同一份连着推两次就别存两遍了
    if (state.recentOutlines.at(-1) === trimmed) {
        return { added: false, count: state.recentOutlines.length };
    }
    state.recentOutlines.push(trimmed);
    while (state.recentOutlines.length > MAX_RECENT_OUTLINES) {
        state.recentOutlines.shift();
    }
    return { added: true, count: state.recentOutlines.length };
}

/** 忘掉前情（想重新开局时用）。 */
export function clearOutlines(state) {
    const count = state.recentOutlines?.length ?? 0;
    state.recentOutlines = [];
    state.storySoFar = '';
    return { cleared: count };
}

/**
 * 拼给模型看的「前情」文本。
 *
 * 从**结尾**截断：接续点在结尾，开头丢了顶多少点背景，结尾丢了就直接接不上。
 * @param {object} state
 * @param {number} [limit]
 */
export function formatOutlines(state, limit = OUTLINE_BRIEF_CHARS) {
    if (!Array.isArray(state.recentOutlines) || state.recentOutlines.length === 0) {
        return '';
    }
    return state.recentOutlines
        .map((text) => {
            const body = String(text);
            return body.length > limit ? `…（前略）${body.slice(-limit)}` : body;
        })
        .join('\n\n——— 下一次推演从这里接 ———\n\n');
}

/**
 * 把外部数据（可能来自旧版本、可能被手改坏）规整成合法状态。
 * 找不到就给一份新的 —— 宁可丢状态也不要让扩展崩。
 * @param {unknown} raw
 */
/**
 * 这份战斗状态还能用吗。
 * 要求 `self`/`enemy` 都是带数字 HP 的对象 —— 不满足就当"无战斗"，
 * 免得面板与 /anko combat 出现在一堆 `undefined`/`NaN` 上。
 */
function isUsableCombat(combat) {
    if (!combat || typeof combat !== 'object') {
        return false;
    }
    const ok = (unit) => unit && typeof unit === 'object' && Number.isFinite(Number(unit.hp));
    return ok(combat.self) && ok(combat.enemy);
}
export function migrateState(raw) {
    const base = createState();
    if (!raw || typeof raw !== 'object') {
        return base;
    }

    const attributes = {};
    if (raw.attributes && typeof raw.attributes === 'object') {
        for (const [key, value] of Object.entries(raw.attributes)) {
            const number = Number(value);
            if (key.trim() && Number.isFinite(number)) {
                attributes[key] = Math.trunc(number);
            }
        }
    }

    const options = Array.isArray(raw.bid?.options)
        ? raw.bid.options.map((text) => String(text)).filter((text) => text.trim().length > 0)
        : [];

    const customTables = {};
    if (raw.customTables && typeof raw.customTables === 'object') {
        for (const [key, value] of Object.entries(raw.customTables)) {
            if (value && typeof value === 'object') {
                customTables[key] = value;
            }
        }
    }

    // 前情：新格式是数组；老存档里可能只有一个 storySoFar 字符串，当成第一份补上
    const recentOutlines = Array.isArray(raw.recentOutlines)
        ? raw.recentOutlines.filter((item) => typeof item === 'string' && item.trim()).slice(-MAX_RECENT_OUTLINES)
        : [];
    const legacyStory = String(raw.storySoFar ?? '').trim();
    if (recentOutlines.length === 0 && legacyStory) {
        recentOutlines.push(legacyStory);
    }

    return {
        version: STATE_VERSION,
        attributes,
        // combat 也要校验结构：其它字段都做了清洗，唯独这个以前"只要是对象就原样用" ——
        // 存档被改坏时面板会显示 "第 undefined/undefined 轮 · undefined HP NaN"，
        // 而不是像其它字段那样安静降级成"无战斗"。
        combat: isUsableCombat(raw.combat) ? raw.combat : null,
        customTables,
        bid: {
            title: String(raw.bid?.title ?? ''),
            options,
        },
        recentOutlines,
        storySoFar: String(raw.storySoFar ?? ''),
        dead: raw.dead === true,
        deathNote: String(raw.deathNote ?? ''),
    };
}

/**
 * 标记玩家角色已战死。
 * 这是**真死**：状态会持久化，并且明确写进给 agent 的上下文简报里。
 * @param {object} state
 * @param {string} [note] 死亡原因
 */
export function markDead(state, note = '') {
    state.dead = true;
    state.deathNote = String(note ?? '').trim();
    if (Object.hasOwn(state.attributes, ATTR_HP_NAME)) {
        state.attributes[ATTR_HP_NAME] = 0;
    }
    return { dead: true, note: state.deathNote };
}

/** 撤销死亡（复活 / 读档 / 你只是想反悔）。 */
export function revive(state) {
    const was = state.dead;
    state.dead = false;
    state.deathNote = '';
    return { was, changed: was };
}

/** 死亡状态的 HP 属性名，和 index.js 里的 ATTR_HP 保持一致。 */
const ATTR_HP_NAME = 'HP';

// ---------------------------------------------------------------------------
// 属性
// ---------------------------------------------------------------------------

/**
 * 设置属性。
 * @param {object} state
 * @param {string} name
 * @param {number} value
 */
export function setAttribute(state, name, value) {
    const key = String(name ?? '').trim();
    if (!key) {
        throw new DiceError('属性名不能为空', 'attr-no-name');
    }
    const number = Number(value);
    if (!Number.isFinite(number)) {
        throw new DiceError(`属性值必须是数字，收到「${value}」`, 'attr-bad-value');
    }
    state.attributes[key] = Math.trunc(number);
    return { name: key, value: state.attributes[key] };
}

/**
 * 增减属性（`hp-1` 这种）。
 * @returns {{name: string, before: number, after: number, delta: number}}
 */
export function adjustAttribute(state, name, delta) {
    const key = String(name ?? '').trim();
    if (!Object.hasOwn(state.attributes, key)) {
        throw new DiceError(`没有这个属性：${key}。先用 /anko attr set 建一个。`, 'attr-missing');
    }
    const step = Number(delta);
    if (!Number.isFinite(step)) {
        throw new DiceError(`增减量必须是数字，收到「${delta}」`, 'attr-bad-delta');
    }
    const before = state.attributes[key];
    state.attributes[key] = before + Math.trunc(step);
    return { name: key, before, after: state.attributes[key], delta: Math.trunc(step) };
}

/** 删掉一个属性。 */
export function removeAttribute(state, name) {
    const key = String(name ?? '').trim();
    if (!Object.hasOwn(state.attributes, key)) {
        throw new DiceError(`没有这个属性：${key}`, 'attr-missing');
    }
    const value = state.attributes[key];
    delete state.attributes[key];
    return { name: key, value };
}

/** 属性表拍成一行行文本。 */
export function formatAttributes(state) {
    const entries = Object.entries(state.attributes);
    if (entries.length === 0) {
        return '（还没有属性。用 /anko attr sheet 车卡，或 /anko attr set 话术 40）';
    }
    return entries.map(([name, value]) => `${name} ${value}`).join('　');
}

/**
 * 车卡：按给定属性名各投一次。
 * @param {{rng?: Function, names?: string[], expr?: string, target?: object}} options
 * @returns {{expr: string, values: Record<string, number>}}
 */
export function rollAttributeSheet({
    rng = defaultRng,
    names = DEFAULT_ATTRIBUTE_NAMES,
    expr = '1d100',
    target = null,
} = {}) {
    const values = {};
    for (const name of names) {
        values[name] = rollExpression(expr, { rng }).total;
    }
    if (target) {
        Object.assign(target.attributes, values);
    }
    return { expr, values };
}

/**
 * 成长检定（COC 式）：投 1d100，超过当前值或超过 95 就算成长，涨 1d10。
 * @param {object} state
 * @param {string} name
 * @param {{rng?: Function}} [options]
 */
export function growthCheck(state, name, { rng = defaultRng } = {}) {
    const key = String(name ?? '').trim();
    if (!Object.hasOwn(state.attributes, key)) {
        throw new DiceError(`没有这个属性：${key}`, 'attr-missing');
    }

    const before = state.attributes[key];
    const roll = rollExpression('1d100', { rng });
    const grown = roll.total > before || roll.total > 95;

    let gain = 0;
    if (grown) {
        gain = rollExpression('1d10', { rng }).total;
        state.attributes[key] = Math.min(ATTRIBUTE_CAP, before + gain);
    }

    return {
        name: key,
        before,
        after: state.attributes[key],
        roll,
        grown,
        gain,
        capped: grown && before + gain > ATTRIBUTE_CAP,
        label: grown ? '成长' : '没长进',
    };
}

// ---------------------------------------------------------------------------
// 安价池
// ---------------------------------------------------------------------------

/** 设置本轮安价的标题。 */
export function bidSetTitle(state, title) {
    state.bid.title = String(title ?? '').trim();
    return state.bid.title;
}

/**
 * 追加选项。`texts` 里可以带 `|` 一次加多个。
 * @returns {{added: string[], total: number}}
 */
export function bidAdd(state, texts) {
    const list = [];
    const push = (text) => {
        const clean = String(text ?? '').trim();
        if (clean) {
            list.push(clean);
        }
    };

    if (Array.isArray(texts)) {
        for (const text of texts) {
            String(text ?? '').split('|').forEach(push);
        }
    } else {
        String(texts ?? '').split('|').forEach(push);
    }

    if (list.length === 0) {
        throw new DiceError('没有可添加的选项', 'bid-empty-add');
    }

    state.bid.options.push(...list);
    return { added: list, total: state.bid.options.length };
}

/**
 * 按序号移除选项（1 起）。
 * @returns {{removed: string, total: number}}
 */
export function bidRemove(state, index) {
    const position = Math.trunc(Number(index));
    if (!Number.isFinite(position) || position < 1 || position > state.bid.options.length) {
        throw new DiceError(`选项序号要在 1–${state.bid.options.length} 之间，收到「${index}」`, 'bid-bad-index');
    }
    const [removed] = state.bid.options.splice(position - 1, 1);
    return { removed, total: state.bid.options.length };
}

/** 清空安价池。 */
export function bidClear(state) {
    const count = state.bid.options.length;
    state.bid.options = [];
    state.bid.title = '';
    return { cleared: count };
}

/**
 * 抽出本轮结果（均等随机），抽完清空。
 * @param {object} state
 * @param {{rng?: Function}} [options]
 */
export function bidDraw(state, { rng = defaultRng } = {}) {
    const options = state.bid.options;
    if (options.length === 0) {
        throw new DiceError('安价池是空的，先用 /anko bid add 加选项', 'bid-empty');
    }

    const roll = rollExpression(`1d${options.length}`, { rng });
    const index = roll.total;
    const option = options[index - 1];
    const title = state.bid.title;

    state.bid.options = [];
    state.bid.title = '';

    return { title, index, option, roll, total: options.length };
}

/** 安价池的可读列表。 */
export function formatBid(state) {
    if (state.bid.options.length === 0) {
        return '（安价池是空的。用 /anko bid add 选项1|选项2 添加）';
    }
    const head = state.bid.title ? `【${state.bid.title}】` : '';
    const lines = state.bid.options.map((text, index) => `  ${index + 1}. ${text}`);
    return [`${head}共 ${state.bid.options.length} 项：`, ...lines].join('\n');
}
