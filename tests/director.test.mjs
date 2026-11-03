import test from 'node:test';
import assert from 'node:assert/strict';

import { createSequenceRng } from '../src/dice.js';
import { resolveUnit, runDirector, isTransientError, describeError } from '../src/director.js';
import { findDiceUnits } from '../src/inline.js';
import { DIRECTOR_SYSTEM_PROMPT, buildDirectorPrompt, NARRATION_PERSONS } from '../src/prompts.js';

// ---------------------------------------------------------------------------
// 假模型：按剧本依次吐出每一轮的内容，并记下收到的请求
// ---------------------------------------------------------------------------

function makeFakeModel(script) {
    const calls = [];
    let index = 0;
    const generate = async (request) => {
        calls.push({ ...request });
        const text = index < script.length ? script[index] : '';
        index += 1;
        return text;
    };
    return { generate, calls };
}

/** 跑一次导演循环，随机源用固定序列。 */
function run(script, options = {}) {
    const model = makeFakeModel(script);
    const rng = createSequenceRng(options.sequence ?? []);
    const progress = [];
    return runDirector({
        userInput: options.userInput ?? '我去码头打听消息',
        contextBrief: options.contextBrief ?? '',
        generate: model.generate,
        rng,
        maxRounds: options.maxRounds,
        strictCausality: options.strictCausality,
        continuation: options.continuation,
        hitMark: options.hitMark,
        onProgress: (e) => progress.push(e),
        shouldStop: options.shouldStop,
    }).then((result) => ({ ...result, calls: model.calls, progress }));
}

// ---------------------------------------------------------------------------
// 基本流程
// ---------------------------------------------------------------------------

test('一轮就没骰子 → 直接定稿', async () => {
    const r = await run(['我走进酒馆，找了个靠窗的位置坐下。']);
    assert.equal(r.reason, 'done');
    assert.equal(r.rounds, 1);
    assert.equal(r.rolls.length, 0);
    assert.equal(r.outline, '我走进酒馆，找了个靠窗的位置坐下。');
});

test('★ system prompt 收紧了大纲长度（写骨架，不是写正文）', async () => {
    const r = await run(['收尾。']);
    const prompt = r.calls[0].systemPrompt;
    assert.match(prompt, /80 字以内/, '要有硬性字数上限');
    assert.match(prompt, /骨架/, '要点明这是骨架');
    assert.match(prompt, /抢戏/, '要有"别这么写"的对照');
    assert.match(prompt, /不要写\*\*：对话原文、心理活动/, '要明确列出不该写什么');
});

test('第一轮 1d3，第二轮收尾 → 原地替换成【1d3=2】', async () => {
    const r = await run(['水路走了1d3天', '。靠岸时天已经黑了。'], { sequence: [2] });
    assert.equal(r.reason, 'done');
    assert.equal(r.rounds, 2);
    assert.equal(r.outline, '水路走了【1d3=2】天。靠岸时天已经黑了。');
    assert.equal(r.rolls.length, 1);
    assert.equal(r.rolls[0].total, 2);
});

test('默认续写方式：已定稿文本进用户消息，prefill 留空', async () => {
    // 为什么默认不用 prefill：它会变成一条 assistant 消息，而 Gemini 拒绝
    // 「请求以模型回合结尾」（HTTP 400 Requests ending with a model turn are not supported）。
    const r = await run(['走了1d3天', '然后继续。'], { sequence: [2] });
    assert.equal(r.calls[0].prefill, '', '内嵌模式下 prefill 始终为空');
    assert.equal(r.calls[1].prefill, '', '内嵌模式下 prefill 始终为空');
    assert.match(r.calls[1].prompt, /# 已经定稿的部分/, '已定稿要作为一节写进用户消息');
    assert.match(r.calls[1].prompt, /走了【1d3=2】天/);
    assert.match(r.calls[1].prompt, /只输出\*\*新增\*\*的内容/);
    assert.ok(!r.calls[0].prompt.includes('# 已经定稿的部分'), '第一轮没有已定稿，不该出现这一节');
});

test('prefill 模式：已定稿交给 prefill 传出（Gemini 会用不了）', async () => {
    const r = await run(['走了1d3天', '然后继续。'], { sequence: [2], continuation: 'prefill' });
    assert.equal(r.calls[0].prefill, '', '第一轮没有已定稿');
    assert.equal(r.calls[1].prefill, '走了【1d3=2】天', '第二轮把定稿当续写起点');
    assert.ok(!r.calls[1].prompt.includes('# 已经定稿的部分'), 'prefill 模式下不再内嵌');
});

test('内嵌模式：模型整段重抄会被切掉（不产生重复）', async () => {
    const r = await run(
        ['走了1d3天', '走了【1d3=2】天，靠岸时天黑了。'],
        { sequence: [2] },
    );
    assert.equal(r.outline, '走了【1d3=2】天，靠岸时天黑了。');
});

test('一轮多骰：左到右全部结算，文本全保留', async () => {
    const r = await run(['甲好感1d100，乙好感1d100，丙好感1d100', '（生成完毕）'], { sequence: [11, 22, 33] });
    assert.equal(r.rolls.length, 3);
    assert.deepEqual(r.rolls.map((x) => x.total), [11, 22, 33]);
    assert.match(r.outline, /甲好感【1d100=11】，乙好感【1d100=22】，丙好感【1d100=33】/);
});

test('达到轮数上限会用现有定稿收尾，并留下警告', async () => {
    const r = await run(['1d3', '1d3', '1d3'], { sequence: [1, 1, 1], maxRounds: 3 });
    assert.equal(r.reason, 'maxRounds');
    assert.equal(r.rounds, 3);
    assert.ok(r.rolls.length >= 3);
    assert.match(r.warnings.join('\n'), /达到轮数上限/);
});

test('★ 最后一轮会禁止再开新骰子（防止大纲停在一个没解释的结果上）', async () => {
    // 真实跑出来过：一轮一个骰子，轮数打满之后大纲结尾是个光秃秃的 `→ 【1d10=3】`
    const r = await run(['走了1d3天', '收尾文字。'], { sequence: [2], maxRounds: 2 });
    assert.match(r.calls[1].prompt, /这是最后一轮/);
    assert.match(r.calls[1].prompt, /不要再写任何骰子表达式/);
    assert.ok(!r.calls[0].prompt.includes('这是最后一轮'), '非最后一轮不该有这条提醒');
});

test('默认轮数上限是 12（一个回合常要投 3–7 次骰子，一次骰子一轮）', async () => {
    const script = Array.from({ length: 12 }, () => '1d3');
    const r = await run(script, { sequence: Array.from({ length: 12 }, () => 1) });
    assert.equal(r.reason, 'maxRounds');
    assert.equal(r.rounds, 12);
});

test('模型连续空输出 → 判定为卡住，不假装成功', async () => {
    const r = await run(['', '', ''], { maxRounds: 5 });
    assert.equal(r.reason, 'stalled');
    assert.match(r.warnings.join('\n'), /没有输出任何内容/);
});

test('可中断：shouldStop 返回 true 就停', async () => {
    let checks = 0;
    const r = await run(['走了1d3天', '又走了1d3天', '再走了1d3天'], {
        sequence: [1, 1, 1],
        shouldStop: () => { checks += 1; return checks >= 3; },
    });
    assert.equal(r.reason, 'aborted');
    assert.equal(r.rounds, 2, '第三轮开始前就被叫停了');
    assert.match(r.outline, /【1d3=1】/);
});

test('进度回调把每一阶段都报出来（给面板用）', async () => {
    const r = await run(['走了1d3天', '收尾。'], { sequence: [2] });
    assert.deepEqual(r.progress.map((p) => p.phase), ['generating', 'rolled', 'generating', 'done']);
    assert.equal(r.progress[1].rolls.length, 1);
});

// ---------------------------------------------------------------------------
// 检定注解
// ---------------------------------------------------------------------------

test('检定注解 1d100【话术40】→ 整块替换成带结论的回执', async () => {
    const r = await run(['我试探他 → 1d100【话术40】', '他起疑了。'], { sequence: [68] });
    // 表达式前面原有的空格会被保留 —— 替换只覆盖表达式和注解本身
    assert.equal(r.outline, '我试探他 → 【1d100=68 / 话术40 → 失败】他起疑了。');
    assert.equal(r.rolls[0].kind, 'check');
    assert.equal(r.rolls[0].label, '失败');
});

test('检定大成功：骰值 3 落在 1–5', async () => {
    const r = await run(['1d100【话术40】', '收尾'], { sequence: [3] });
    assert.match(r.outline, /【1d100=3 \/ 话术40 → 大成功】/);
});

test('检定注解配错骰子 → 降级成普通投骰并记警告 + 让模型改', async () => {
    const r = await run(['→ 2d6【话术40】', '收尾'], { sequence: [3, 4] });
    assert.match(r.outline, /【2d6=7】/);
    assert.match(r.warnings.join('\n'), /检定注解只能配 1d100/);
    assert.match(r.calls[1].prompt, /检定注解只能配 1d100/, '警告要喂回给模型让它改');
});

// ---------------------------------------------------------------------------
// 选项骰（孔明式）
// ---------------------------------------------------------------------------

test('选项骰投出普通值：只投 1d10，不投效果骰', async () => {
    const r = await run(['→ 1d10【选项】', '收尾'], { sequence: [7] });
    assert.match(r.outline, /→ 【1d10=7】/);
    assert.equal(r.rolls[0].kind, 'kongming');
    assert.equal(r.rolls[0].label, '选项 7');
    assert.equal(r.rolls[0].dice.length, 1);
});

test('选项骰投出 10 → 自动连投 1d2，并停下来等效果表', async () => {
    const r = await run(['→ 1d10【选项】', '大失败效果表：…→ 1d10【选项】', '收尾'], { sequence: [10, 2, 4] });
    assert.match(r.outline, /→ 【1d10=10 → 1d2=2（大失败）】/);
    assert.equal(r.rolls[0].label, '大失败');
    assert.equal(r.rolls[0].needEffectTable, true);
    assert.equal(r.rolls[0].dice.length, 2, '只该投 1d10 和 1d2，不该替模型把效果骰也投了');
});

test('大成功/大失败之后，下一轮 prompt 会催模型给效果表', async () => {
    const r = await run(['→ 1d10【选项】', '（效果表）→ 1d10', '收尾'], { sequence: [10, 1, 5] });
    assert.match(r.calls[1].prompt, /请紧接着给出「大成功效果表」/);
    // 这条断言**改过一次**：原先是 `/双重大成功\/大失败/` ✗ —— 那是在保护一个错名。
    // 导演路径每张表都是独立投骰（`rules.js:172-173` 每次 depth 从 1 起），不存在"同向叠加" ✓。
    assert.match(r.calls[1].prompt, /10 【1D2】大成功\/大失败/);
    assert.ok(!r.calls[1].prompt.includes('双重大成功/大失败'), '不该再出现「双重」这个错名');
    assert.match(r.calls[1].prompt, /逆转/, '极性翻转要有专用说法');
});

test('选项骰的面数来自表达式：1d6【选项】就是六项表', async () => {
    const r = await run(['→ 1d6【选项】', '收尾'], { sequence: [5] });
    assert.match(r.outline, /→ 【1d6=5】/);
});

test('选项注解配错骰子 → 降级 + 警告', async () => {
    const r = await run(['→ 3d6【选项】', '收尾'], { sequence: [1, 1, 1] });
    assert.match(r.outline, /【3d6=3】/);
    assert.match(r.warnings.join('\n'), /【选项】注解只能配 1dN/);
});

// ---------------------------------------------------------------------------
// 选项表命中标注（插件替 AI 干它老忘的事）
// ---------------------------------------------------------------------------

/** 一张标准十项表 + 请求行。 */
const OPTION_TABLE = [
    '先去哪边打听 —— 选项骰十项：',
    '1-3 酒馆',
    '4-6 货栈',
    '7-9 码头管事',
    '10 【1D2】大成功/大失败',
    '→ 1d10【选项】',
].join('\n');

test('★ 选项骰投完后，命中行会被自动打上 ♛', async () => {
    const r = await run([OPTION_TABLE, '我决定去码头管事那里问问。'], { sequence: [7] });
    assert.match(r.outline, /7-9 码头管事 ♛/);
    assert.match(r.outline, /→ 【1d10=7】/, '骰子本身要留着');
    assert.ok(!/1-3 酒馆 ♛/.test(r.outline), '别的行不该被打标');
});

test('打到别的值也标对行', async () => {
    const r = await run([OPTION_TABLE, '收尾'], { sequence: [2] });
    assert.match(r.outline, /1-3 酒馆 ♛/);
});

test('投出最后一项（大成功/大失败）时标在第 10 行', async () => {
    const r = await run([OPTION_TABLE, '（大失败效果表）', '收尾'], { sequence: [10, 2, 4] });
    assert.match(r.outline, /10 【1D2】大成功\/大失败 ♛/);
});

// ---------------------------------------------------------------------------
// 大成功/大失败之后必须投效果表（后果不能由模型自己编）
// ---------------------------------------------------------------------------

/** 一张标准的大失败效果表。 */
const EFFECT_TABLE = [
    '大失败效果 —— 选项骰十项：',
    '1-3 受点小伤，但脱身了',
    '4-6 装备丢失，且被标记',
    '7-9 重伤，被逼入绝境',
    '10 【1D2】大成功/大失败',
    '→ 1d10【选项】',
].join('\n');

test('★ 投出大成功/大失败后不投效果表 → 会被打回去补投', async () => {
    // 真实踩到过：模型投出大失败，然后直接自己编了后果（"暴君级变异体堵在走廊正中"）
    const r = await run(
        [OPTION_TABLE, '你被暴君堵在走廊正中，退路全断了。', EFFECT_TABLE, '收尾。'],
        { sequence: [10, 2, 4] },
    );

    assert.equal(r.calls.length, 4, '中间要插一轮"补投效果表"');
    assert.match(r.calls[2].prompt, /必须.*效果表|效果表.*必须|没有投效果表/s, '第三轮要带上补投要求');
    assert.match(r.outline, /【1d10=10 → 1d2=2（大失败）】/);
    assert.match(r.outline, /【1d10=4】/, '效果表的骰子要投出来');
    assert.ok(r.warnings.some((w) => /没有投效果表，已要求补投/.test(w)));
});

test('★ 最后一轮还欠着效果表 → 额外给一轮，不占轮数预算', async () => {
    // limit 用变量而不是常量，就是为了这件事：大成功/大失败不该被额度掐掉
    const r = await run([OPTION_TABLE, EFFECT_TABLE, '收尾。'], {
        sequence: [10, 2, 5],
        maxRounds: 2,
    });

    assert.equal(r.rounds, 3, 'maxRounds=2 但要多给一轮投效果表');
    assert.equal(r.reason, 'done');
    assert.match(r.outline, /【1d10=5】/);
    assert.ok(r.warnings.some((w) => /额外给第 3 轮/.test(w)));
});

test('效果表投出普通选项之后就还清了，不会一直追加', async () => {
    const r = await run([OPTION_TABLE, EFFECT_TABLE, '收尾。'], { sequence: [10, 2, 5] });
    assert.equal(r.reason, 'done');
    assert.equal(r.rounds, 3, '第 3 轮就没骰子了，正常收');
    assert.ok(!r.warnings.some((w) => /额外给/.test(w)));
});

test('没投过大成功/大失败时不欠效果表（普通收尾不会被拦）', async () => {
    const r = await run([OPTION_TABLE, '收尾。'], { sequence: [7] });
    assert.equal(r.rounds, 2);
    assert.equal(r.calls.length, 2);
});

test('命中符号可以换，也可以关掉', async () => {
    const custom = await run([OPTION_TABLE, '收尾'], { sequence: [7], hitMark: '★' });
    assert.match(custom.outline, /7-9 码头管事 ★/);

    const off = await run([OPTION_TABLE, '收尾'], { sequence: [7], hitMark: '' });
    assert.ok(!off.outline.includes('♛'), '关掉之后不该有任何标记');
    assert.match(off.outline, /7-9 码头管事/, '但列表本身要留着');
});

test('认不出选项表时照常投骰，只是不打标', async () => {
    const r = await run(['他没给选项，直接1d10【选项】', '收尾'], { sequence: [7] });
    assert.match(r.outline, /【1d10=7】/);
    assert.ok(!r.outline.includes('♛'));
});

test('★ 普通投骰（没带【选项】注解）绝不去打标', async () => {
    // 伤害骰也是 1d10、也可能有一张"伤害表"，但它不是选项骰
    const table = '伤害表：\n1-3 轻伤\n4-6 中伤\n7-9 重伤\n10 致命\n→ ';
    const r = await run([`${table}1d10`, '收尾'], { sequence: [7] });
    assert.match(r.outline, /【1d10=7】/);
    assert.ok(!r.outline.includes('♛'), '没有【选项】注解就不该标');
});

// ---------------------------------------------------------------------------
// 生成失败：重试 + 半成品
// ---------------------------------------------------------------------------

test('哪些错误值得重试', () => {
    for (const text of ['429 Too Many Requests', 'rate limit exceeded', '503 Service Unavailable',
        'Request timed out', 'ECONNRESET', 'fetch failed', 'socket hang up',
        'Got response status 429', 'Got response status 503']) {
        assert.equal(isTransientError(new Error(text)), true, `该重试：${text}`);
    }
    for (const text of ['400 Bad Request', 'invalid api key', 'content filter triggered',
        'Requests ending with a model turn are not supported']) {
        assert.equal(isTransientError(new Error(text)), false, `不该重试：${text}`);
    }
    assert.equal(isTransientError(null), false);
    assert.equal(isTransientError(''), false);
    // 词边界：别把 1500 里的 500 当成网关错误
    assert.equal(isTransientError(new Error('max tokens 1500 exceeded')), false);
});

test('对象形态的错误也能读成人话（文本补全那条路径抛的是对象）', () => {
    // 现在会**下探**常见字段（error/response/body…），给出更少嵌套的原话，
    // 所以断言"含有关键信息"而不是精确 JSON —— 精确到字段层级会把改进也锁死。
    assert.match(describeError({ error: { message: 'boom' } }), /boom/);
    assert.equal(describeError(new Error('普通的')), '普通的');
    assert.equal(describeError('裸字符串'), '裸字符串');
    assert.equal(describeError({ message: '有 message' }), '有 message');
    assert.equal(describeError(null), '');
    assert.equal(describeError(undefined), '');
    assert.equal(describeError({}), '（空错误对象）', '空对象也不能吐出 [object Object]');
    // ⚠️ 酒馆会 `throw new Error(data)`（data 是对象）→ message 变成字面量 "[object Object]"，
    // 这种"没信息"的 message 必须继续下探属性，否则用户只看到一句废话（实测撞到过）
    const wrapped = new Error('[object Object]');
    wrapped.error = { message: 'Requests ending with a model turn are not supported.' };
    assert.match(describeError(wrapped), /model turn/);
    // 用描述后的文本判断能否重试
    assert.equal(isTransientError({ error: { code: 429 } }), true);
});

test('★ ST 抛的 "Got response status 429" 会被识别成可重试', async () => {
    let calls = 0;
    const model = makeFakeModel(['收尾。']);
    const result = await runDirector({
        userInput: '我去码头',
        generate: async (request) => {
            calls += 1;
            if (calls === 1) {
                throw new Error('Got response status 429');
            }
            return model.generate(request);
        },
        sleep: async () => {},
        onProgress: () => {},
    });
    assert.equal(result.reason, 'done');
    assert.equal(calls, 2);
});

test('★ 限流这类临时错误会自动重试，而且真的等了一下', async () => {
    const model = makeFakeModel(['走了1d3天', '收尾']);
    let calls = 0;
    const slept = [];

    const result = await runDirector({
        userInput: '我去码头',
        generate: async (request) => {
            calls += 1;
            if (calls === 1) {
                throw new Error('429 Too Many Requests');
            }
            return model.generate(request);
        },
        rng: createSequenceRng([2]),
        sleep: async (ms) => { slept.push(ms); },
        onProgress: () => {},
    });

    assert.equal(result.reason, 'done', '重试之后应该正常跑完');
    assert.deepEqual(slept, [1500], '第一次重试前等 1.5 秒');
    assert.match(result.warnings.join('\n'), /429/);
});

test('★ 参数错误这类永久失败不重试（别浪费时间）', async () => {
    let calls = 0;
    const result = await runDirector({
        userInput: '我去码头',
        generate: async () => {
            calls += 1;
            throw new Error('400 Bad Request: invalid model');
        },
        sleep: async () => { throw new Error('永久失败不该等'); },
        onProgress: () => {},
    });

    assert.equal(calls, 1, '只该调一次');
    assert.equal(result.reason, 'error');
    assert.match(result.error, /400/);
});

test('重试用完还是失败 → reason=error，并且带上最后一次的错误', async () => {
    let calls = 0;
    const slept = [];
    const result = await runDirector({
        userInput: '我去码头',
        generate: async () => {
            calls += 1;
            throw new Error('503 Service Unavailable');
        },
        retryAttempts: 3,
        sleep: async (ms) => { slept.push(ms); },
        onProgress: () => {},
    });

    assert.equal(calls, 3, '试满 3 次');
    assert.deepEqual(slept, [1500, 3000], '退避：1.5s 然后 3s');
    assert.equal(result.reason, 'error');
    assert.equal(result.outline, '', '什么都没有就只能空手');
});

test('★ 第二轮才开始失败 → 交出半成品，而且明确标成 error（不是静默 done）', async () => {
    // 这正是"点一次只推演出第一楼"的真身：第一轮成功、第二轮撞上限流
    const model = makeFakeModel(['走了1d3天']);
    let calls = 0;

    const result = await runDirector({
        userInput: '我去码头',
        generate: async (request) => {
            calls += 1;
            if (calls === 1) {
                return model.generate(request);
            }
            throw new Error('429 rate limit');
        },
        rng: createSequenceRng([2]),
        retryAttempts: 2,
        sleep: async () => {},
        onProgress: () => {},
    });

    assert.equal(result.reason, 'error', '必须是 error，绝不能伪装成 done');
    assert.match(result.outline, /【1d3=2】/, '第一轮的成果要保住');
    assert.match(result.error, /429/);
    assert.ok(result.warnings.some((w) => /第 2 轮生成失败/.test(w)));
});

test('中断时不重试（用户按了停止就别再打 API）', async () => {
    let calls = 0;
    let stop = false;
    const result = await runDirector({
        userInput: '我去码头',
        generate: async () => {
            calls += 1;
            stop = true; // 第一次失败后，用户按了停止
            throw new Error('429 rate limit');
        },
        shouldStop: () => stop,
        sleep: async () => { throw new Error('中断了不该等'); },
        onProgress: () => {},
    });

    assert.equal(calls, 1);
    assert.equal(result.reason, 'error');
});

// ---------------------------------------------------------------------------
// 严格因果模式
// ---------------------------------------------------------------------------


test('严格因果模式：只结算第一个骰子，表达式之后的文字被丢弃（下一轮由模型重写）', async () => {
    const r = await run(['走了1d3天，接着1d10', '（后续）'], {
        sequence: [2, 9],
        strictCausality: true,
    });
    assert.equal(r.rolls.length, 1, '严格模式下第二个骰子该等下一轮');
    assert.equal(r.outline, '走了【1d3=2】（后续）',
        '「天，接着1d10」是在不知道骰值的情况下写的，被丢掉了 —— 模型下一轮会重写');
});

test('非严格模式（默认）保留表达式之后的文字', async () => {
    const r = await run(['走了1d3天，接着1d10', '（后续）'], { sequence: [2, 9] });
    assert.match(r.outline, /走了【1d3=2】天，接着【1d10=9】（后续）/);
    assert.equal(r.rolls.length, 2);
    assert.equal(r.rounds, 2, '一轮就能结算两个');
});

// ---------------------------------------------------------------------------
// 回声与非法片段
// ---------------------------------------------------------------------------

test('模型把已定稿内容抄一遍 → 回声被切掉，不产生重复', async () => {
    const r = await run(['走了1d3天', '走了【1d3=2】天，靠岸时天黑了。'], { sequence: [2] });
    assert.equal(r.outline, '走了【1d3=2】天，靠岸时天黑了。');
});

test('模型抄一整段长文本也能识别（不只认短前缀）', async () => {
    const long = '我把行李寄在旅店，第二天清晨动身去码头。水路走了1d3天，';
    const r = await run(
        [long, '我把行李寄在旅店，第二天清晨动身去码头。水路走了【1d3=2】天，靠岸时天黑了。'],
        { sequence: [2] },
    );
    assert.equal(r.outline, '我把行李寄在旅店，第二天清晨动身去码头。水路走了【1d3=2】天，靠岸时天黑了。');
});

test('解析不了的片段：丢掉那一轮，点名让模型改，改好的才收下', async () => {
    const r = await run(['投3d6k9 试试', '改好了：投3d6k2', '收尾'], { sequence: [1, 1, 1] });
    assert.match(r.warnings.join('\n'), /无法解析的片段：3d6k9/);
    assert.ok(!r.outline.includes('3d6k9'), '带非法片段的那一轮不该被收进大纲');
    assert.match(r.outline, /改好了：投【3d6k2=2】/, '序列 [1,1,1] 取最大两颗 = 2');
    assert.match(r.calls[1].prompt, /3d6k9/, '修正提示要进下一轮 prompt');
});

test('改不动也不能无脑重试：用完重试次数就收下并警告', async () => {
    const r = await run(['投3d6k9', '还是3d6k9', '还是3d6k9'], { sequence: [] });
    assert.match(r.warnings.join('\n'), /无法解析的片段：3d6k9/);
    assert.ok(r.rounds <= 4, `不该无限重试，实际跑了 ${r.rounds} 轮`);
});

// ---------------------------------------------------------------------------
// resolveUnit 单元测试
// ---------------------------------------------------------------------------

test('resolveUnit：纯数值', () => {
    const [unit] = findDiceUnits('走了1d3天');
    const out = resolveUnit(unit, { rng: createSequenceRng([3]) });
    assert.equal(out.replacement, '【1d3=3】');
    assert.equal(out.roll.kind, 'roll');
});

test('resolveUnit：检定走房规3，且记录原始点数', () => {
    const [unit] = findDiceUnits('1d100【图书馆使用65】');
    const out = resolveUnit(unit, { rng: createSequenceRng([4]) });
    assert.equal(out.replacement, '【1d100=4 / 图书馆使用65 → 大成功】');
    assert.equal(out.roll.kind, 'check');
    assert.deepEqual(out.roll.dice, [4]);
});

test('resolveUnit：选项骰的 detail 是完整链条（便于日志复核）', () => {
    const [unit] = findDiceUnits('1d10【选项】');
    const out = resolveUnit(unit, { rng: createSequenceRng([10, 2]) });
    assert.equal(out.roll.detail, '1d10=10 → 1d2=2');
    assert.deepEqual(out.roll.dice, [10, 2]);
});

test('resolveUnit：没有注解的 1d10 就是普通投骰，不触发大成功/大失败', () => {
    const [unit] = findDiceUnits('伤害 1d10');
    const out = resolveUnit(unit, { rng: createSequenceRng([10]) });
    assert.equal(out.replacement, '【1d10=10】');
    assert.equal(out.roll.kind, 'roll');
    assert.equal(out.roll.needEffectTable, undefined);
});

// ---------------------------------------------------------------------------
// 参数校验
// ---------------------------------------------------------------------------

test('没有 generate 回调时立刻报错', async () => {
    await assert.rejects(() => runDirector({ userInput: 'x' }), /需要一个 generate 回调/);
});

test('★ 空输入是合法的 —— 表示"玩家没有再输入，接着前情推演下一幕"', async () => {
    const r = await run(['收尾。'], { userInput: '' });
    assert.equal(r.reason, 'done');
    assert.match(r.calls[0].prompt, /玩家没有输入/, 'prompt 里要说明玩家没输入');
});

test('★ 提示词：大成功/大失败的连投与效果表不占「一回合 1–4 次」的预算', async () => {
    const r = await run(['收尾。']);
    assert.match(r.calls[0].systemPrompt, /不算在这个预算里/);
    assert.match(r.calls[0].systemPrompt, /不许\*\*因为"额度用完了"/);
});

test('轮数上限会被夹在合法区间（0 不能被当成"用默认值"）', async () => {
    const r = await run(['1d3'], { sequence: [1, 1], maxRounds: 0 });
    assert.equal(r.rounds, 1, 'maxRounds=0 应该被夹到 1');
    assert.equal(r.reason, 'maxRounds');
});

test('轮数上限上限被夹到 50', async () => {
    const r = await run(['收尾'], { maxRounds: 9999 });
    assert.equal(r.rounds, 1);
});


/** 造一张合法的十项表 + 请求行。 */
function tenTable(name) {
    return [
        `${name} —— 选项骰十项：`,
        '1 甲', '2 乙', '3 丙', '4 丁', '5 戊', '6 己', '7 庚', '8 辛', '9 壬',
        '10 【1D2】大成功/大失败',
        '→ 1d10【选项】',
    ].join('\n');
}

test('★ 人称规则不能又被 system prompt 顶掉', () => {
    // 用户报"大纲怎么固定第二人称了"，我加了 NARRATION_PERSONS —— 但 system prompt 里
    // 一直留着旧句子「保持第二人称或第一人称一致，跟上下文简报里的叙述人称保持一致」，
    // 它优先级更高、又指向简报里根本不存在的行 → 选第三人称照样被它压回去。
    assert.ok(!DIRECTOR_SYSTEM_PROMPT.includes('保持第二人称或第一人称一致'),
        'system prompt 里不该再有写死人称的旧句子');
    assert.ok(!DIRECTOR_SYSTEM_PROMPT.includes('上下文简报里的叙述人称'),
        '不该让人称去"简报"里找（简报里没有这一行）');
    assert.match(DIRECTOR_SYSTEM_PROMPT, /以用户消息里「# 叙述人称」那一节为准/,
        '要明确把决定权交给每轮注入的那一节');
});

test('★ 插件提醒里的求助行必须带【选项】（漏了会变成普通投骰）', async () => {
    // director.js 里那句"然后请求下一个 → 1d10"以前漏了【选项】：
    // 模型照做就成了普通投骰 —— 不打 ♛、不连投 1d2、零警告。
    const r = await run([tenTable('命运'), '收尾。'], { sequence: [10, 1, 1], maxRounds: 3 });
    const prompts = r.calls.map((c) => c.prompt);
    // ⚠️ 不能只找"效果表"：每轮的「骰点预算」里也提到效果表（"不算在这个预算里"）。
    // 要认出的是那条**提醒**本身，它含"请紧接着给出"。
    const nag = prompts.find((p) => p.includes('请紧接着给出'));
    assert.ok(nag, '投出 10 之后要有效果表提醒');
    assert.match(nag, /→ 1d10【选项】/, '提醒里的请求行必须带【选项】');

    // ★ A+B 定案（用户实跑撞到"名实不符"之后改的）：
    // A：**不许再写「双重」** —— 导演路径每张表都是独立投骰（`rules.js:172-173` 每次 depth 从 1 起），
    //    所以"大成功后又大失败"不是同向叠加 ✗
    assert.ok(!nag.includes('双重大成功/大失败'), '提醒里不该再把第 10 项写成「双重」');
    assert.match(nag, /10 【1D2】大成功\/大失败/, '第 10 项应当就是「大成功/大失败」');
    // B：**极性翻转要有专用说法** —— 否则模型只能自己编名字（实测编成了"双重大失败"✗）
    assert.match(nag, /逆转/, '要告诉模型：极性翻转时叫「逆转」');
});

test('★ 收尾时还欠着效果表 → 必须警告（以前完全静默）', async () => {
    // 投出 10 → 欠效果表；轮数上限只有 1，收尾时仍然欠着 → 模型是自己编的后果，
    // 用户必须被告知（以前 warnings 里一个字都没有）。
    const r = await run([tenTable('命运')], { sequence: [10, 2], maxRounds: 1 });
    assert.ok(r.warnings.some((w) => /仍欠着/.test(w)),
        `要警告效果表没投，实际：${JSON.stringify(r.warnings)}`);
});

test('★ 欠着效果表的那一轮，不能再压「不许写骰子」', async () => {
    // maxRounds=2、连续投出 10 → 额外轮一路给到上限；到第 4 轮时旧代码会同时塞进
    // FINAL_ROUND_NOTE（不许写骰子）和效果表提醒 → 模型听话收尾、效果表永远不投。
    const r = await run([tenTable('一'), tenTable('二'), tenTable('三'), '收尾。'],
        { sequence: [10, 1, 10, 1, 10, 1, 5, 1], maxRounds: 2 });
    const last = r.calls.at(-1).prompt;
    assert.ok(!last.includes('不要再写任何骰子表达式'),
        `欠着效果表时不能压"不许写骰子"，实际最后一轮 prompt：${last.slice(-400)}`);
});

// ---------------------------------------------------------------------------
// 十项表的规范（用户定的走向）与叙述人称
// ---------------------------------------------------------------------------

test('十项表的走向：1-8 可行走向、9 玩梗项、10 crit 位', () => {
    // prompt 里的规则文字是**跨行排版**的（中文句子会在任意处折行），
    // 所以比较前把**所有空白都去掉** —— 否则 `至少要\n有 5 条` 折行后就匹配不上。
    const flat = DIRECTOR_SYSTEM_PROMPT.replace(/\s+/g, '');
    // 用户 2026-11-01 定的**固定映射**（6 行）：
    // 1-2 纯正面 / 3-4 好坏参半 / 5-6 埋伏笔 / 7-8 揭开伏笔 / 9 玩梗超预料 / 10 crit
    assert.match(flat, /只写6行/, '十项表要写明"只写 6 行"');
    assert.match(flat, /1-2.*纯正面事件/, '1-2 是纯正面事件');
    assert.match(flat, /3-4.*好坏参半/, '3-4 是好坏参半');
    assert.match(flat, /5-6.*埋伏笔/, '5-6 是埋伏笔');
    assert.match(flat, /7-8.*揭开伏笔/, '7-8 是揭开伏笔');
    assert.match(flat, /玩梗/, '9 是玩梗/超出预料');
    assert.match(flat, /不属于这个世界观|不属于这个时间点/, '玩梗项的定义');
    assert.match(flat, /六段内容必须互不相同/, '六段内容必须互不相同');
    assert.match(flat, /10【1D2】大成功\/大失败/, '第 10 格固定是 crit 位');
});

test('十项表的范例要从 1 连续铺满到 10（范例会被逐字抄走，必须和规则一致）', () => {
    // 由来：范例曾经写成 1-3 / 4-6 / 7-9 / 10，模型照着写，于是每张"十项表"只有 3 个选项 ✗。
    // 现在的范例是**5 行覆盖 10 格**（1-3 / 4-5 / 6-8 / 9 / 10）—— 省 token ✓ 但格数一个不少 ✓。
    //
    // ⚠️ 断言改过一次：原来是"整份提示词里的号数集合恰好 == 1..10" ✗ ——
    // 加入**背景骰的 4 行范例**（1-25 / 26-50 / 51-75 / 76-100）之后，那条断言就炸了 ✓
    // （它把背景范例的号数也算进来了 ✗）。现在只查**覆盖**：1–10 每个号位都得出现 ✓，
    // 这样别的范例随便加，都不会误伤 ✓。
    const slots = new Set();
    for (const line of DIRECTOR_SYSTEM_PROMPT.split('\n').map((l) => l.trim())) {
        const m = /^(\d+)(?:-(\d+))?\s/.exec(line);
        if (!m) {
            continue;
        }
        const from = Number(m[1]);
        const to = m[2] ? Number(m[2]) : from;
        for (let i = from; i <= to; i += 1) {
            slots.add(i);
        }
    }
    for (let i = 1; i <= 10; i += 1) {
        assert.ok(slots.has(i), `号位 ${i} 在范例里没出现（范例必须从 1 铺满到 10，这是打 ♛ 的前提）`);
    }
});

test('提示词要教两种新骰（是非 / 背景），并且已经停掉检定教学', () => {
    // 用户 2026-10-15 定的规则扩展 ✓
    const flat = DIRECTOR_SYSTEM_PROMPT.replace(/\s+/g, '');
    // 是非骰：写法 + **语义固定**（否则模型自己定 1/2，等于它选结果 ✗）
    assert.match(flat, /1d2【是非】/, '要教 1d2【是非】的写法 ✓');
    assert.match(flat, /纯数值/, '要教纯数值骰 ✓');
    // ⚠️ flat 只去掉空白，**不会去掉 markdown 的 `**`** ✗ ——
    // 所以这里不能写 `/不要自己写/`（提示词里是 `你**不要**自己写` ✓）→ 用 `.` 跳过星号
    assert.match(flat, /1=是\/进行\/成立/, '要写死 1=是 ✓');
    assert.match(flat, /不占预算|不计入骰点预算|不计入这个预算/, '这两类不占预算 ✓');
    // 背景骰：写法 + 4 行递进 + 边界 + 一次定终身
    assert.match(flat, /1d100【背景】/, '要教 1d100【背景】的写法');
    assert.match(flat, /四级递进/, '四行必须是同一尺度的四级递进');
    assert.match(flat, /≤5大失败/, '首行要标出大失败边界');
    assert.match(flat, /≥96大成功/, '末行要标出大成功边界');
    assert.match(flat, /一次定终身/, '背景骰只投一次');
    // 检定停用（只停提示词：命令与数据都留着 ✓）
    assert.match(flat, /属性检定（⚠️本回合不用）|本回合不用/, '要明说检定本回合不用');
    assert.ok(!flat.includes('按房规3判定'), '不该再教房规3 的判定步骤');
    assert.ok(!flat.includes('只写1d100'), '不该再要求"检定只写 1d100"');
    // 第 9 行仍然要是玩梗项示范（这条断言原本挂在上面那条测试里，重写时被我漏在外面 ✗）
    assert.ok(DIRECTOR_SYSTEM_PROMPT.split('\n').some((l) => l.trim().startsWith('9 ')),
        '第 9 行要示范玩梗项');
});

test('★ 骰点预算要跟轮数上限联动（曾经写死 1–4，于是面板上的旋钮等于没用）', () => {
    // 用户报："轮数是 6，只推了 3 轮"。根因：system prompt 里写死"一回合一般 1–4 次骰点就够"，
    // 于是模型投 3 次就收尾 —— 面板上的轮数上限根本没接到模型身上。
    const six = buildDirectorPrompt({ userInput: 'x', maxRounds: 6, round: 1 });
    assert.match(six, /# 骰点预算/);
    assert.match(six, /最多可以投 6 次骰子/, '预算必须是设置里的那个数');
    assert.match(six, /你现在在第 1 轮/);
    assert.match(six, /不等于"早点收尾"/, '要明确禁止提前收尾');

    const twelve = buildDirectorPrompt({ userInput: 'x', maxRounds: 12, round: 3 });
    assert.match(twelve, /最多可以投 12 次骰子/);
    assert.match(twelve, /你现在在第 3 轮/);

    // 脏数据不能把 prompt 写坏
    assert.match(buildDirectorPrompt({ userInput: 'x', maxRounds: 0 }), /最多可以投 1 次骰子/);
    assert.match(buildDirectorPrompt({ userInput: 'x', maxRounds: 9999 }), /最多可以投 50 次骰子/);

    // system prompt 里不该再出现写死的次数
    assert.ok(!DIRECTOR_SYSTEM_PROMPT.includes('一回合一般 1–4 次骰点就够'),
        'system prompt 里不该再有写死的次数');
    assert.match(DIRECTOR_SYSTEM_PROMPT, /骰点预算写在用户消息里/);
});

test('★ 走完整循环时，预算用的是真实轮数上限（runDirector 要把 maxRounds 传下去）', async () => {
    // 忘了给骰子序列会报「确定性随机源用光了」，所以这里给一颗 1d3 用的值
    const r = await run(['走了1d3天', '收尾。'], { maxRounds: 5, sequence: [1] });
    assert.match(r.calls[0].prompt, /最多可以投 5 次骰子/, 'maxRounds 要传到 prompt 里');
});

test('叙述人称规则：四种都能注入，默认沿用前情', () => {
    const auto = buildDirectorPrompt({ userInput: 'x', person: 'auto' });
    assert.match(auto, /# 叙述人称/);
    assert.match(auto, /沿用前情/);
    assert.match(auto, /不要自己把人称固定成第二人称/);

    for (const person of ['first', 'second', 'third']) {
        const text = buildDirectorPrompt({ userInput: 'x', person });
        assert.ok(text.includes(NARRATION_PERSONS[person]), `${person} 规则要注入`);
    }

    // 没传 person 时也必须有规则（不能回到"没人称规则"的状态）
    assert.match(buildDirectorPrompt({ userInput: 'x' }), /# 叙述人称/);
});
// ---------------------------------------------------------------------------
// 上下文简报的"宽度"：用户报过"导演看不到上下文" ✗
// ---------------------------------------------------------------------------

test('★ 上下文简报要带上足够多的最近消息（不是只 6 条 ✗）', async () => {
    const { buildContextBrief } = await import('../src/prompts.js');
    const recent = Array.from({ length: 25 }, (_, i) => ({ name: '角色', mes: `消息${i}`, isUser: i % 2 === 0 }));
    const brief = buildContextBrief({ recentMessages: recent, maxRecent: 20, maxMessageChars: 1200 });

    const kept = brief.split('\n').filter((line) => line.startsWith('  '));
    assert.equal(kept.length, 20, `应当保留 20 条，实际 ${kept.length}`);
    assert.ok(brief.includes('消息24'), '最后一条要在 ✓');
    assert.ok(brief.includes('消息5'), '第 5 条（= 倒数第 20 条）要在 ✓');
    assert.ok(!brief.includes('消息4'), '更早的（第 4 条）不该在 ✗');
});

test('★ 单条消息要截到 1200 字（原来 400 ✗）', async () => {
    const { buildContextBrief } = await import('../src/prompts.js');
    const brief = buildContextBrief({
        recentMessages: [{ name: '角色', mes: '丙'.repeat(5000), isUser: false }],
        maxRecent: 20,
        maxMessageChars: 1200,
    });
    const line = brief.split('\n').find((l) => l.startsWith('  ')) ?? '';
    const body = line.split('：').slice(1).join('：');
    assert.equal(body.length, 1200, `应当刚好截到 1200 字，实际 ${body.length}`);
});

test('★ 前情（storySoFar）要留到 6000 字，而不是 2400', async () => {
    const { buildContextBrief } = await import('../src/prompts.js');
    const story = '乙'.repeat(5000);
    const brief = buildContextBrief({ storySoFar: story });
    assert.ok(brief.includes('乙'.repeat(4000)), '4000 字以内必须保留（2400 的旧实现会截掉 ✗）');
});
test('★ 每轮 prompt 里要带"这回合已投过什么"（它不知道自己投过啥 ✗）', async () => {
    // 由来：实测里模型把"几个武侯 / 刻痕几道 / 会不会"直接写死 ✗，
    // 因为它看不到"自己这一轮已经投过哪几类骰" ✓。这条只做**告知**，不做硬规定 ✓。
    const seen = [];
    await runDirector({
        userInput: '继续',
        contextBrief: '',
        rng: createSequenceRng([5]),
        maxRounds: 3,
        generate: async (request) => {
            seen.push(String(request.prompt ?? ''));
            return seen.length === 1 ? '他推门进去 → 1d10【选项】' : '结束了。';
        },
        sleep: async () => {},
        onProgress: () => {},
        hitMark: '♛',
    });
    assert.ok(seen.length >= 1, '至少要发一次请求 ✓');
    assert.match(seen[0], /到目前为止这一回合投过什么/, '第一轮就要带这一节 ✓');
    assert.match(seen[0], /还没投过任何骰子|纯数值 \/ 是非 还一次都没用/, '没投过时要明说还缺纯数值/是非 ✓');
});
