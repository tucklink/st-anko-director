import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mergePanelOverPreset, presetGuidanceFromSettings, presetToPayload, resolveProfilePreset, settingsToPayload } from '../src/preset.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 造一个假的酒馆上下文（只含 resolveProfilePreset 会碰的东西 ✓） */
function fakeCtx({ profiles = [], presetByName = {}, source = 'openai' } = {}) {
    return {
        extensionSettings: { connectionManager: { profiles } },
        CONNECT_API_MAP: { openai: { source }, claude: { source: 'claude' } },
        getPresetManager: (type) => (type === 'openai'
            ? { getCompletionPresetByName: (name) => presetByName[name] }
            : null),
    };
}

/** 一份接近真实的酒馆预设（含 null、含 0、含 openai_max_tokens） */
function samplePreset() {
    return {
        temperature: 0.8,
        top_p: 0.95,
        top_k: 40,
        min_p: 0.05,
        top_a: 0,
        repetition_penalty: null,
        frequency_penalty: 0.2,
        presence_penalty: null,
        seed: -1,
        n: 1,
        openai_max_tokens: 2048,
        stream_openai: true,
        prompts: [{ name: '不该被抄走', content: 'x' }],
        prompt_order: [{ order: [] }],
        openai_model: 'some-model',
    };
}

test('预设 → payload：只带白名单字段，null 一律跳过', () => {
    const out = presetToPayload(samplePreset(), { source: 'openai' });
    assert.equal(out.temperature, 0.8);
    assert.equal(out.top_p, 0.95);
    assert.equal(out.frequency_penalty, 0.2);
    assert.equal(out.seed, -1);
    assert.equal(out.n, 1);
    assert.ok(!('presence_penalty' in out), 'null 必须跳过 ✗');
    assert.ok(!('repetition_penalty' in out), 'null 必须跳过 ✗');
});

test('预设 → payload：openai_max_tokens 要变成 max_tokens', () => {
    const out = presetToPayload(samplePreset(), { source: 'openai' });
    assert.equal(out.max_tokens, 2048);
    assert.ok(!('openai_max_tokens' in out), '不能把预设原名带出去 ✗');
});

test('预设 → payload：不抄提示词编排 / 模型名 / stream', () => {
    const out = presetToPayload(samplePreset(), { source: 'openai' });
    for (const bad of ['prompts', 'prompt_order', 'openai_model', 'stream_openai']) {
        assert.ok(!(bad in out), `${bad} 不该被抄进请求 ✗`);
    }
});

test('预设 → payload：OpenAI 官方不带 top_k/min_p/top_a（会 400）', () => {
    const out = presetToPayload(samplePreset(), { source: 'openai' });
    assert.ok(!('top_k' in out), 'openai 不认 top_k ✗');
    assert.ok(!('min_p' in out));
    assert.ok(!('top_a' in out));
});

test('预设 → payload：宽松来源（openrouter/custom）才带 top_k 这些', () => {
    for (const source of ['openrouter', 'custom']) {
        const out = presetToPayload(samplePreset(), { source });
        assert.equal(out.top_k, 40, source + ' 应该带 top_k ✓');
        assert.equal(out.min_p, 0.05, source + ' 应该带 min_p ✓');
    }
});

test('预设 → payload：top_p 为 0 要改成 Number.EPSILON（照抄酒馆行为）', () => {
    const out = presetToPayload({ top_p: 0 }, { source: 'openai' });
    assert.equal(out.top_p, Number.EPSILON);
});

test('预设 → payload：**绝不**抄请求体改写字段（会删掉上下文 ✗）', () => {
    // 由来：用户报"原文上下文直接没了" ✗ —— 因为 `custom_exclude_body` 会被服务端
    // `excludeKeysByYaml` 用来**删请求体里的键**（`chat-completions.js:2068` ✓），
    // 预设里配了 `messages` 就等于把整段上下文删干净 ✗。
    const preset = {
        temperature: 0.7,
        custom_include_body: 'messages: []',
        custom_exclude_body: 'messages',
        custom_include_headers: 'X-Foo: bar',
    };
    for (const source of ['custom', 'openrouter', 'openai']) {
        const out = presetToPayload(preset, { source });
        for (const bad of ['custom_include_body', 'custom_exclude_body', 'custom_include_headers']) {
            assert.ok(!(bad in out), `${source} 来源下不该带 ${bad} ✗`);
        }
        assert.equal(out.temperature, 0.7, '采样参数仍然要带 ✓');
    }
});

test('预设 → payload：空/坏输入必须安全返回空对象', () => {
    for (const bad of [null, undefined, {}, 'not an object', 42]) {
        assert.deepEqual(presetToPayload(bad, { source: 'openai' }), {});
    }
    assert.deepEqual(presetToPayload({ temperature: 'abc', top_p: '' }, {}), {});
});

test('面板填了 = 覆盖预设；没填（null/undefined/空串）不动预设', () => {
    const preset = presetToPayload(samplePreset(), { source: 'openai' });
    const merged = mergePanelOverPreset(preset, {
        temperature: 0.3,      // 面板填了 → 覆盖
        max_tokens: 8192,      // 面板填了 → 覆盖
        top_p: null,           // 面板没填 → 保留预设
    });
    assert.equal(merged.temperature, 0.3);
    assert.equal(merged.max_tokens, 8192);
    assert.equal(merged.top_p, 0.95, '面板没填时预设的 top_p 要留着 ✓');
});

test('面板为空时，预设原样通过', () => {
    const preset = presetToPayload(samplePreset(), { source: 'openrouter' });
    const merged = mergePanelOverPreset(preset, {});
    assert.deepEqual(merged, preset);
});

// ---------------------------------------------------------------------------
// resolveProfilePreset：从连接配置里读预设（这一层以前完全没测 ✗）
// ---------------------------------------------------------------------------

test('resolveProfilePreset：能按 profileId 找到预设并转成字段', () => {
    const ctx = fakeCtx({
        profiles: [{ id: 'p1', api: 'openai', preset: '我的预设', model: 'm' }],
        presetByName: { '我的预设': { temperature: 0.2, top_p: 0.9, openai_max_tokens: 1234 } },
        source: 'openrouter',
    });
    const info = resolveProfilePreset(ctx, 'p1');
    assert.equal(info.presetName, '我的预设');
    assert.equal(info.source, 'openrouter', 'source 要从 CONNECT_API_MAP 查，不能用 profile.api ✗');
    assert.equal(info.fields.temperature, 0.2);
    assert.equal(info.fields.top_p, 0.9);
    assert.equal(info.fields.max_tokens, 1234, 'openai_max_tokens 要变成 max_tokens ✓');
    assert.equal(info.warning, null);
});

test('resolveProfilePreset：预设名对不上必须报警（不许静默 ✗）', () => {
    const ctx = fakeCtx({
        profiles: [{ id: 'p1', api: 'openai', preset: '被改过名的预设' }],
        presetByName: {},
    });
    const info = resolveProfilePreset(ctx, 'p1');
    assert.equal(info.presetName, '被改过名的预设');
    assert.deepEqual(info.fields, {});
    assert.match(info.warning ?? '', /找不到/, '必须给出可读的警告 ✓');
});

test('resolveProfilePreset：profileId 不存在 / 没绑预设 / 上下文不完整都要安全', () => {
    const ctx = fakeCtx({ profiles: [{ id: 'p1', api: 'openai', preset: 'x' }], presetByName: { x: { temperature: 1 } } });
    assert.match(resolveProfilePreset(ctx, 'nope').warning ?? '', /找不到连接配置/);
    assert.equal(resolveProfilePreset(ctx, '').presetName, '');
    assert.deepEqual(resolveProfilePreset(null, 'p1').fields, {});
    assert.deepEqual(resolveProfilePreset({}, 'p1').fields, {});

    const noPreset = fakeCtx({ profiles: [{ id: 'p2', api: 'openai' }] });
    const info = resolveProfilePreset(noPreset, 'p2');
    assert.equal(info.presetName, '', '没绑预设不是错误，警告也应该为空 ✓');
    assert.equal(info.warning, null);
});

test('resolveProfilePreset：预设管理器抛异常也不能把推演带崩', () => {
    const ctx = fakeCtx({ profiles: [{ id: 'p1', api: 'openai', preset: 'x' }] });
    ctx.getPresetManager = () => {
        throw new Error('preset manager boom');
    };
    const info = resolveProfilePreset(ctx, 'p1');
    assert.deepEqual(info.fields, {});
    assert.match(info.warning ?? '', /boom/);
});

// ---------------------------------------------------------------------------
// 接线检查：index.js 必须真的用上上面这套（静态检查，防"写好了没接" ✗）
// ---------------------------------------------------------------------------


test('settingsToPayload：字段名照酒馆的 oai_settings（temp_openai → temperature …）', () => {
    const live = {
        temp_openai: 0.7,
        top_p_openai: 0.9,
        freq_pen_openai: 0.1,
        pres_pen_openai: 0.2,
        openai_max_tokens: 2048,
        seed: -1,
        n: 1,
        reasoning_effort: 'low',
        top_k_openai: 40,
    };
    const common = settingsToPayload(live, { source: 'openai' });
    assert.equal(common.temperature, 0.7);
    assert.equal(common.top_p, 0.9);
    assert.equal(common.frequency_penalty, 0.1);
    assert.equal(common.presence_penalty, 0.2);
    assert.equal(common.max_tokens, 2048, 'openai_max_tokens → max_tokens ✓');
    assert.equal(common.reasoning_effort, 'low');
    assert.ok(!('top_k' in common), 'openai 不认 top_k ✗');

    const tolerant = settingsToPayload(live, { source: 'openrouter' });
    assert.equal(tolerant.top_k, 40, '宽松来源才带 top_k ✓');
});

test('settingsToPayload：重复惩罚默认 1 不该发（1 = 不惩罚，发了反而变行为 ✗）', () => {
    assert.ok(!('repetition_penalty' in settingsToPayload({ repetition_penalty_openai: 1 }, { source: 'openrouter' })));
    assert.equal(settingsToPayload({ repetition_penalty_openai: 1.1 }, { source: 'openrouter' }).repetition_penalty, 1.1);
});

test('settingsToPayload：空/脏输入安全；top_p=0 → EPSILON', () => {
    assert.deepEqual(settingsToPayload(null), {});
    assert.deepEqual(settingsToPayload({}), {});
    assert.equal(settingsToPayload({ top_p_openai: 0 }).top_p, Number.EPSILON);
});

// ---------------------------------------------------------------------------
// presetGuidanceFromSettings：预设的"提示词口径"（那 67 条的主体 ✓）
// ---------------------------------------------------------------------------

test('口径拼接：按 prompt_order 的顺序、跳过 disabled 与 marker、去掉注释宏', () => {
    const settings = {
        prompts: [
            { identifier: 'a', content: '第一条口径' },
            { identifier: 'b', content: '第二条口径' },
            { identifier: 'off', content: '被禁用的不该出现' },
            { identifier: 'main', marker: true, content: '' },
            { identifier: 'c', content: '{{// 作者：某人\n发布地址：xxx}}真正的第三条' },
        ],
        prompt_order: [{
            character_id: 100000,
            order: [
                { identifier: 'b', enabled: true },
                { identifier: 'off', enabled: false },
                { identifier: 'main', enabled: true },
                { identifier: 'c', enabled: true },
                { identifier: 'a', enabled: true },
            ],
        }],
    };
    const out = presetGuidanceFromSettings(settings);
    assert.equal(out.count, 3, `应当拼 3 条，实际 ${out.count}`);
    assert.ok(out.text.indexOf('第二条口径') < out.text.indexOf('真正的第三条'), '要按 prompt_order 的顺序 ✓');
    assert.ok(out.text.indexOf('第一条口径') > out.text.indexOf('真正的第三条'), 'order 里 a 在最后 ✓');
    assert.ok(!out.text.includes('被禁用'), 'disabled 的不能进 ✗');
    assert.ok(!out.text.includes('作者：某人'), '注释宏要去掉 ✗');
});

test('口径拼接：没有 prompt_order 就按数组顺序；空预设安全', () => {
    const out = presetGuidanceFromSettings({ prompts: [{ identifier: 'x', content: 'X口径' }] });
    assert.equal(out.text, 'X口径');
    assert.equal(presetGuidanceFromSettings(null).text, '');
    assert.equal(presetGuidanceFromSettings({ prompts: [] }).text, '');
});

test('口径拼接：超长要截断并标记', () => {
    const settings = { prompts: [{ identifier: 'big', content: '字'.repeat(500) }] };
    const out = presetGuidanceFromSettings(settings, { maxChars: 100 });
    assert.equal(out.text.length, 100);
    assert.equal(out.truncated, true);
});

// ---------------------------------------------------------------------------
// 变量更新内容必须从"导演口径"里剔除（MVU 那套语法 ✗）
// ---------------------------------------------------------------------------

test('★ 口径注入要剔掉变量更新：条目名命中 / UpdateVariable 块 / _.set 行', () => {
    const settings = {
        prompts: [
            { identifier: 'main', name: 'Main Prompt', content: '主提示词：写正文' },
            {
                identifier: 'var_rule',
                name: '变量更新规则',
                content: '按条件更新变量',
            },
            {
                identifier: 'style',
                name: '文风',
                content: '用 <game> 包正文。\n<UpdateVariable>\n    <Analysis>\n        好感度: Y\n    </Analysis>\n    _.set(\'好感度\', 1, 2);//原因\n</UpdateVariable>\n结尾保持克制。',
            },
            {
                identifier: 'status',
                name: 'x',
                content: '<status_current_variable>{{get_message_variable::stat_data}}</status_current_variable>',
            },
        ],
        prompt_order: [{ character_id: 100000, order: [
            { identifier: 'main', enabled: true },
            { identifier: 'var_rule', enabled: true },
            { identifier: 'style', enabled: true },
            { identifier: 'status', enabled: true },
        ] }],
    };
    const out = presetGuidanceFromSettings(settings);
    assert.ok(!out.text.includes('变量更新规则'), '条目名命中变量类 → 整条不要 ✗');
    assert.ok(!out.text.includes('<UpdateVariable>'), 'UpdateVariable 块要删掉 ✗');
    assert.ok(!out.text.includes('_.set('), '_.set 行要删掉 ✗');
    assert.ok(!out.text.includes('status_current_variable'), 'status_current_variable 块要删掉 ✗');
    assert.match(out.text, /主提示词：写正文/, '普通条目要留着 ✓');
    assert.match(out.text, /<game>/, '正文里的正常内容要留着 ✓');
    assert.match(out.text, /结尾保持克制/, '块外的内容要留着 ✓');
    assert.ok(out.removedVariableEntries >= 2, `被整条剔掉的条目数，实际 ${out.removedVariableEntries}`);
    assert.ok(out.removedVariableChars > 0, '被删掉的字符数要统计 ✓');
});

test('★ 关掉 stripVariableUpdates 时原样保留（可回退 ✓）', () => {
    const settings = { prompts: [{ identifier: 'a', content: '<UpdateVariable>x</UpdateVariable>保留' }] };
    const out = presetGuidanceFromSettings(settings, { stripVariableUpdates: false });
    assert.match(out.text, /<UpdateVariable>/, '关掉开关就不过滤 ✓');
});

// ---------------------------------------------------------------------------
// 出口剥离：导演输出里不许留 MVU 变量块（用户实测踩到过 ✗）
// ---------------------------------------------------------------------------

test('★ stripVariableUpdateBlocks：变量块 / 状态占位 / _.set 全部剥掉，正常文本保留', async () => {
    const { stripVariableUpdateBlocks } = await import('../src/prompts.js');
    const raw = [
        '他推门进去。',
        '<UpdateVariable>',
        '[{ "op": "add", "path": "/主角", "value": { "姓名": "莹" } }]',
        '</UpdateVariable>',
        '<StatusPlaceHolderImpl/>',
        '_.set(\'主角.境界\', \'凡人\', \'筑基\');',
        '他在门槛上顿了一下。',
    ].join('\n');
    const out = stripVariableUpdateBlocks(raw);
    assert.ok(!out.includes('<UpdateVariable>'), '变量块要剥掉 ✗');
    assert.ok(!out.includes('StatusPlaceHolderImpl'), '状态占位要剥掉 ✗');
    assert.ok(!out.includes('_.set('), '更新语句要剥掉 ✗');
    assert.ok(!out.includes('"op": "add"'), '块里的 JSON 也要一起走 ✗');
    assert.match(out, /他推门进去/, '正文要保留 ✓');
    assert.match(out, /门槛上顿了一下/, '正文要保留 ✓');
    assert.ok(!/\n{3,}/.test(out), '不留成片空行 ✓');
});

test('★ stripVariableUpdateBlocks：没有变量内容时原样返回', async () => {
    const { stripVariableUpdateBlocks } = await import('../src/prompts.js');
    const text = '他一言不发，走了。';
    assert.equal(stripVariableUpdateBlocks(text), text);
});
