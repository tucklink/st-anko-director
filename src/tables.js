/**
 * ============================================================================
 *  随机表 / 事件表（设计书 §6.3）
 * ============================================================================
 *  两种写法都支持，因为社区里两种都在用：
 *    · 区间：`[1, 5, '文本']` —— 精确控制每一段的概率
 *    · 均分：直接给一串文本，按骰面数均分
 *
 *  纯逻辑，不碰酒馆 API。
 * ============================================================================
 */

import { DiceError, defaultRng, rollExpression } from './dice.js';

/**
 * 内置表。社群常见的几张，玩家可以覆盖或自建。
 * 区间表用 bands（闭区间），均分表用 texts。
 */
export const BUILTIN_TABLES = Object.freeze({
    随机事件: {
        dice: '1d100',
        bands: [
            [1, 10, '毫无波澜：这一段时间平静地过去了'],
            [11, 20, '小麻烦：一件不致命但很烦的事找上门'],
            [21, 35, '意外收获：捡到或得到一件有用的东西'],
            [36, 50, '新面孔：一个陌生人主动搭话'],
            [51, 65, '旧账：以前埋下的某件事回来了'],
            [66, 75, '误会：有人把主角认成了别人'],
            [76, 85, '坏消息：计划被外力打乱'],
            [86, 92, '机会：出现一条捷径，但有代价'],
            [93, 97, '大变故：局势被一次性改写'],
            [98, 100, '？？？：由导游临场决定，越离谱越好'],
        ],
    },
    随机天气: {
        dice: '1d10',
        texts: ['晴', '多云', '阴', '小雨', '大雨', '雷雨', '雾', '大风', '雪', '极端天气'],
    },
    随机遭遇: {
        dice: '1d100',
        bands: [
            [1, 15, '无害的路人'],
            [16, 30, '盘问身份的人'],
            [31, 45, '和小偷小摸有关的人'],
            [46, 60, '带着明显目的来的陌生人'],
            [61, 75, '旧识，但立场未必一致'],
            [76, 85, '受伤求援的人'],
            [86, 93, '明显打不过的强者'],
            [94, 97, '和主线有关的关键人物'],
            [98, 100, '不该出现在这里的东西'],
        ],
    },
    随机地点: {
        dice: '1d10',
        texts: ['酒馆', '码头', '集市', '旧宅', '山道', '废墟', '神殿', '地窖', '桥下', '无人区'],
    },
    随机物品: {
        dice: '1d10',
        texts: ['一封没署名的信', '一把陌生的钥匙', '半枚钱币', '一张褪色的画像', '一块带刻痕的石头',
            '一瓶不知名的药', '一副旧手套', '一页残破的地图', '一枚印章', '什么都没有，但口袋里有股怪味'],
    },
    随机性格: {
        dice: '1d10',
        texts: ['沉默寡言', '过分热情', '谨慎到多疑', '嘴上不饶人', '固执', '好奇', '悲观', '喜欢赌',
            '对人客气但有距离', '看起来正常，其实什么都在算'],
    },
    随机姓名: {
        dice: '1d20',
        texts: ['沈砚', '陆岐', '柳阑', '祝青', '谢无咎', '薛萤', '裴照', '周檀', '卫长风', '韩濯',
            '苏问梅', '程素', '江砚秋', '傅清', '林觉', '顾淮', '温未寒', '霍遥', '白鹤', '秦叙'],
    },
});

/**
 * 把一张表拍平成 `[{from, to, text}]`，两种写法都认。
 * @param {object} table
 * @param {string} [name] 出错时用
 * @returns {{name: string, dice: string, entries: Array<{from: number, to: number, text: string}>}}
 */
export function normalizeTable(table, name = '未命名') {
    if (!table || typeof table !== 'object') {
        throw new DiceError(`表「${name}」不存在`, 'table-missing');
    }

    const dice = String(table.dice ?? '1d100');
    const faces = /^\s*1\s*[dD]\s*(\d+)\s*$/.exec(dice)?.[1];
    if (!faces) {
        throw new DiceError(`表「${name}」的 dice 必须写成 1dN，收到 ${dice}`, 'table-bad-dice');
    }
    const max = Number(faces);

    let entries = [];

    if (Array.isArray(table.bands) && table.bands.length > 0) {
        entries = table.bands.map((band) => {
            if (!Array.isArray(band) || band.length < 3) {
                throw new DiceError(`表「${name}」的 bands 每项都要是 [下限, 上限, 文本]`, 'table-bad-band');
            }
            return { from: Number(band[0]), to: Number(band[1]), text: String(band[2]) };
        });
    } else if (Array.isArray(table.texts) && table.texts.length > 0) {
        const size = max / table.texts.length;
        entries = table.texts.map((text, index) => ({
            from: Math.floor(index * size) + 1,
            to: index === table.texts.length - 1 ? max : Math.floor((index + 1) * size),
            text: String(text),
        }));
    } else {
        throw new DiceError(`表「${name}」既没有 bands 也没有 texts`, 'table-empty');
    }

    for (const entry of entries) {
        if (!Number.isFinite(entry.from) || !Number.isFinite(entry.to) || entry.from > entry.to) {
            throw new DiceError(`表「${name}」里有非法区间 ${entry.from}-${entry.to}`, 'table-bad-range');
        }
        if (entry.from < 1 || entry.to > max) {
            throw new DiceError(`表「${name}」的区间 ${entry.from}-${entry.to} 超出 ${dice} 的范围`, 'table-out-of-range');
        }
    }

    entries.sort((a, b) => a.from - b.from);
    return { name, dice, entries };
}

/**
 * 投一次表。
 * @param {object} table
 * @param {{name?: string, rng?: Function}} [options]
 * @returns {{total: number, expr: string, entry: object|null, text: string, detail: string}}
 */
export function rollTable(table, { name = '未命名', rng = defaultRng } = {}) {
    const normalized = normalizeTable(table, name);
    const roll = rollExpression(normalized.dice, { rng });
    const entry = normalized.entries.find((item) => roll.total >= item.from && roll.total <= item.to) ?? null;

    return {
        total: roll.total,
        expr: normalized.dice,
        dice: roll.dice,
        entry,
        text: entry ? entry.text : '（这个区间没写内容，由导游临场决定）',
        detail: entry ? `${normalized.dice}=${roll.total} → ${entry.from}-${entry.to} 区间` : `${normalized.dice}=${roll.total}`,
        tableName: normalized.name,
        at: Date.now(),
    };
}

/**
 * 列出所有可用的表（内置 + 自定义，自定义同名时覆盖内置）。
 * @param {Record<string, object>} [customTables]
 */
export function listTables(customTables = {}) {
    const names = new Set([...Object.keys(BUILTIN_TABLES), ...Object.keys(customTables)]);
    return [...names].sort();
}

/**
 * 取一张表（自定义优先）。
 * @param {string} name
 * @param {Record<string, object>} [customTables]
 */
export function getTable(name, customTables = {}) {
    if (Object.hasOwn(customTables, name)) {
        return customTables[name];
    }
    if (Object.hasOwn(BUILTIN_TABLES, name)) {
        return BUILTIN_TABLES[name];
    }
    return null;
}
