/**
 * ============================================================================
 *  骰点日志 —— 记每颗骰子的原始值，便于玩家复核（设计书 §5.3 / D12）
 * ============================================================================
 *  为什么留这个：骰子值是这个插件唯一不能被质疑的东西。玩家问「你刚才真投了吗」，
 *  唯一能给的答复就是把原始点数和时间摆出来。所以哪怕只做最小版，也要记明细。
 *
 *  纯逻辑，可在 Node 里单测；落盘由上层（chatMetadata）负责。
 * ============================================================================
 */

/**
 * @typedef {object} RollLogEntry
 * @property {number} seq 自增序号
 * @property {number} at 时间戳
 * @property {string} kind 'roll' | 'check' | 'kongming'
 * @property {string} expr 表达式（kongming 时为首个骰子）
 * @property {number} total 结果
 * @property {string} [detail] 展开明细
 * @property {number[]} [dice] 每颗骰子的原始点数
 * @property {string} [label] 判定结论，如「大失败」
 * @property {string} [target] 判定目标，如「话术40」—— 没有它，`1d100 = 58 → 失败` 是没法验的
 * @property {string} [context] 谁投的、为什么投
 */

const KIND_LABEL = Object.freeze({ roll: '投骰', check: '检定', kongming: '选项骰' });

/**
 * 落盘（写进 chatMetadata）时最多留多少条。
 * 内存里可以有 500 条，但跟着聊天文件存的那份要小 —— 见 toJSON 的注释。
 */
export const PERSIST_LIMIT = 100;

/**
 * 造一个骰点日志。
 * @param {{limit?: number}} [options] limit 超出后丢最旧的
 */
export function createRollLog({ limit = 500 } = {}) {
    /** @type {RollLogEntry[]} */
    let entries = [];
    let seq = 0;

    return {
        /**
         * 追加一条。
         * @param {object} roll 引擎或规则模块的返回值
         * @param {{kind?: string, context?: string, expr?: string, total?: number, label?: string}} [meta]
         * @returns {RollLogEntry}
         */
        add(roll, meta = {}) {
            seq += 1;
            /** @type {RollLogEntry} */
            const entry = {
                seq,
                at: roll?.at ?? Date.now(),
                kind: meta.kind ?? roll?.kind ?? 'roll',
                expr: meta.expr ?? roll?.expr ?? '',
                total: Number(meta.total ?? roll?.total ?? 0),
                detail: roll?.detail ?? '',
                dice: Array.isArray(roll?.dice) ? [...roll.dice] : [],
                label: meta.label ?? roll?.label ?? '',
                // 检定要记下目标值：只写「58 → 失败」的话，玩家没法复核（万一是「话术70」呢）
                target: meta.target ?? (roll?.rate != null ? `${roll?.name ?? ''}${roll.rate}` : ''),
                context: meta.context ?? '',
            };
            entries.push(entry);
            if (entries.length > limit) {
                entries = entries.slice(entries.length - limit);
            }
            return entry;
        },

        /** 全部条目（副本）。 */
        all() {
            return entries.map((e) => ({ ...e }));
        },

        /** 最近 n 条。 */
        last(n = 10) {
            return entries.slice(Math.max(0, entries.length - n)).map((e) => ({ ...e }));
        },

        /** 条数。 */
        size() {
            return entries.length;
        },

        clear() {
            entries = [];
            seq = 0;
        },

        /**
         * 导出为可 JSON 序列化的结构（塞进 chatMetadata）。
         *
         * ⚠️ **只落最后 `PERSIST_LIMIT` 条**：这份数据会跟着聊天文件一起存，
         * 每条约 130 字节，500 条就是 **65 KB**（实测）—— 对聊天文件来说太重了。
         * 内存里仍然留 `limit` 条（面板能查一整个会话），落盘只留最近的。
         */
        toJSON() {
            return {
                seq,
                entries: entries.slice(Math.max(0, entries.length - PERSIST_LIMIT)).map((e) => ({ ...e })),
            };
        },

        /** 从 JSON 恢复。 */
        hydrate(data) {
            const source = Array.isArray(data?.entries) ? data.entries : [];
            entries = source.map((e) => ({
                seq: Number(e?.seq) || 0,
                at: Number(e?.at) || 0,
                kind: String(e?.kind ?? 'roll'),
                expr: String(e?.expr ?? ''),
                total: Number(e?.total) || 0,
                detail: String(e?.detail ?? ''),
                dice: Array.isArray(e?.dice) ? e.dice.map(Number) : [],
                label: String(e?.label ?? ''),
                target: String(e?.target ?? ''),
                context: String(e?.context ?? ''),
            }));
            seq = Number(data?.seq) || entries.reduce((max, e) => Math.max(max, e.seq), 0);
            return this;
        },

        /** 单条的可读文本。 */
        format(entry) {
            const time = new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false });
            const head = `#${entry.seq} ${time} [${KIND_LABEL[entry.kind] ?? entry.kind}]`;
            const expr = entry.expr ? `${entry.expr} = ${entry.total}` : String(entry.total);
            const verdict = entry.label ? ` → ${entry.label}` : '';
            const target = entry.target ? `（${entry.target}）` : '';
            const raw = entry.dice?.length ? `  原始点数[${entry.dice.join(',')}]` : '';
            const why = entry.context ? `  （${entry.context}）` : '';
            return `${head} ${expr}${verdict}${target}${raw}${why}`;
        },

        /** 最近 n 条的可读文本，多行。 */
        formatLast(n = 10) {
            const list = this.last(n);
            if (list.length === 0) {
                return '（还没有投过骰子）';
            }
            return list.map((e) => this.format(e)).join('\n');
        },
    };
}
