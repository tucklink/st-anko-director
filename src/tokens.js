/**
 * ============================================================================
 *  额度解析 —— 四条生成路径**共用一个**，不许各写各的
 * ============================================================================
 *  为什么单独抽出来（这是踩出来的，不是设计洁癖）：
 *    同一个"空正文"故障，四条路里只有**一条**做了防护 ✗：
 *      A 内置直连（callChatApi）      —— 额度可能 null ✗，无重试 ✗，无诊断 ✗
 *      B 服务端代理（processRequest） —— 额度 ✓ 重试 ✓ 诊断 ✓
 *      C 连接配置（sendRequest）       —— 额度可能 undefined ✗，无重试 ✗，诊断部分 ✓
 *      D generateRaw                  —— 原来**完全没有额度** ✗
 *    根因是我"在哪看到症状就在哪修"✗，没做横向对比 ✓。
 *    所以现在把"额度怎么定"收进一个纯函数 ✓，四条路都必须调它 ✓，
 *    再配一条矩阵测试 ✓ —— 谁要是自己另写一套，测试立刻红 ✓。
 *
 *  依据（官方文档，不是拍数字 ✗）：
 *    https://docs.sillytavern.app/usage/prompts/reasoning/
 *    "…responses are coming back incomplete or empty… For reasoning models, it's typical to
 *     use significantly higher token limits - anywhere from 1024 to 4096 tokens."
 *    推理模型的思考与正文**共用**这个额度，给小了就是 `finish_reason: "length"` + 空正文 ✗
 */

/** 文档建议区间（1024–4096）的上限 ✓，用作"什么都拿不到"时的兜底 */
export const DIRECTOR_FALLBACK_TOKENS = 4096;

/** 文档建议区间的下限 —— 低于它就报警 ✓（我们不改用户设置，只提醒 ✗） */
export const DIRECTOR_WARN_BELOW_TOKENS = 1024;

/**
 * 解析导演这次该给多少额度。
 *
 * 规则：
 *   1. 面板值 ✓ 与镜像值（酒馆自己的 Max Response Length ✓）取**较大**者 ——
 *      比酒馆自己那条线还小必然是坏的 ✓（旧版本我把默认值拍成 2048，比 65535 小 32 倍 ✗）
 *   2. 两个都没有 → 落到 {@link DIRECTOR_FALLBACK_TOKENS} ✓（不是 300 ✗）
 *
 * @param {unknown} panelValue 面板里填的额度（空/null/0 都算没填 ✓）
 * @param {unknown} mirrorValue 酒馆当前 Max Response Length（读不到就传 0 ✓）
 * @returns {number} 一定是**正整数** ✓（调用方不用再判空 ✗）
 */
export function resolveDirectorTokens(panelValue, mirrorValue) {
    const panel = toPositiveInt(panelValue);
    const mirror = toPositiveInt(mirrorValue);
    const best = Math.max(panel, mirror);
    return best > 0 ? best : DIRECTOR_FALLBACK_TOKENS;
}

/**
 * 额度是不是低到该提醒用户。
 *
 * @param {number} tokens
 * @returns {boolean}
 */
export function isTokensSuspiciouslyLow(tokens) {
    return !Number.isFinite(tokens) || tokens < DIRECTOR_WARN_BELOW_TOKENS;
}

function toPositiveInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}
