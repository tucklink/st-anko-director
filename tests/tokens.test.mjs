import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DIRECTOR_FALLBACK_TOKENS,
    DIRECTOR_WARN_BELOW_TOKENS,
    isTokensSuspiciouslyLow,
    resolveDirectorTokens,
} from '../src/tokens.js';

test('额度解析：面板与镜像取较大者（比酒馆自己还小必然是坏的）', () => {
    assert.equal(resolveDirectorTokens(2048, 65535), 65535, '镜像更大 → 用镜像 ✓');
    assert.equal(resolveDirectorTokens(8192, 300), 8192, '面板更大 → 用面板 ✓');
    assert.equal(resolveDirectorTokens(0, 65535), 65535, '面板没填 → 用镜像 ✓');
    assert.equal(resolveDirectorTokens(null, 4096), 4096);
});

test('额度解析：两个都没有时必须兜到文档建议的上限，而不是 0/undefined', () => {
    assert.equal(resolveDirectorTokens(0, 0), DIRECTOR_FALLBACK_TOKENS);
    assert.equal(resolveDirectorTokens(null, null), DIRECTOR_FALLBACK_TOKENS);
    assert.equal(resolveDirectorTokens(undefined, undefined), DIRECTOR_FALLBACK_TOKENS);
    assert.equal(resolveDirectorTokens('', ''), DIRECTOR_FALLBACK_TOKENS);
    // 关键：返回值必须是正整数，调用方不需要再判空 ✓
    for (const v of [resolveDirectorTokens(0, 0), resolveDirectorTokens(null, null)]) {
        assert.ok(Number.isInteger(v) && v > 0, `必须是正整数，实际 ${v}`);
    }
});

test('额度解析：脏输入不能变成 NaN / 负数', () => {
    for (const bad of ['abc', {}, [], NaN, Infinity, -1, -0.5]) {
        const v = resolveDirectorTokens(bad, bad);
        assert.ok(Number.isInteger(v) && v > 0, `输入 ${String(bad)} 得到 ${v}`);
    }
});

test('额度解析：小数要取整（端点不收 2048.5）', () => {
    assert.equal(resolveDirectorTokens(2048.7, 0), 2048);
    assert.equal(resolveDirectorTokens(0, 4096.9), 4096);
});

test('文档下限常量：低于 1024 要报警（依据 ST 文档的 1024–4096 建议）', () => {
    assert.equal(DIRECTOR_WARN_BELOW_TOKENS, 1024);
    assert.equal(isTokensSuspiciouslyLow(300), true, 'ST 默认 300 必须被判定为可疑 ✓');
    assert.equal(isTokensSuspiciouslyLow(1023), true);
    assert.equal(isTokensSuspiciouslyLow(1024), false);
    assert.equal(isTokensSuspiciouslyLow(4096), false);
    assert.equal(isTokensSuspiciouslyLow(undefined), true, '拿不到值也算可疑 ✓');
});
