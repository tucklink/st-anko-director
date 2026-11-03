import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DICE_CANDIDATE_RE,
    findDiceUnits,
    findExpressions,
    findInvalidDiceLike,
    formatRoll,
    hasExpression,
    matchExpressionAt,
    nextDiceCandidate,
    parseAnnotation,
    resolveExpressions,
    splitAtFirstExpression,
    stripEcho,
} from '../src/inline.js';

test('新注解：1d2【是非】与 1d100【背景】都要能被认出来', () => {
    // 用户 2026-10-15 定的两种新骰 ✓
    // 为什么必须要注解：`1d2` 分不出是是非骰还是伤害 ✗、`1d100` 分不出是背景骰还是检定 ✗
    assert.deepEqual(parseAnnotation('是非'), { kind: 'yesno' });
    assert.deepEqual(parseAnnotation('是否'), { kind: 'yesno' }, '容错写法');
    assert.deepEqual(parseAnnotation('判定'), { kind: 'yesno' }, '容错写法');
    assert.deepEqual(parseAnnotation('背景'), { kind: 'background' });
    assert.deepEqual(parseAnnotation('背景骰'), { kind: 'background' }, '容错写法');

    // 而且必须能作为"注解"跟在表达式后被读出来（不能只是 parseAnnotation 单独可用）
    const units = findDiceUnits('他会去滑雪吗 → 1d2【是非】\n主角家里多有钱 → 1d100【背景】');
    assert.equal(units.length, 2);
    assert.equal(units[0].annotation?.kind, 'yesno');
    assert.equal(units[1].annotation?.kind, 'background');
});

test('裸写：从中文正文里认出表达式', () => {
    const hits = findExpressions('我把行李寄在旅店，水路走了1d3天。');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].expr, '1d3');
    assert.equal('我把行李寄在旅店，水路走了1d3天。'.slice(hits[0].start, hits[0].end), '1d3');
});

test('已解析的回执不再重复投', () => {
    assert.deepEqual(findExpressions('水路走了【1d3=2】天。'), []);
    assert.equal(hasExpression('水路走了【1d3=2】天。'), false);
});

test('已解析 + 未解析混在一段里：只认没解析的那个', () => {
    const hits = findExpressions('走了【1d3=2】天，接着投1d10。');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].expr, '1d10');
});

test('贪婪吃掉整条表达式：1d6+1d4+3', () => {
    const hits = findExpressions('伤害是1d6+1d4+3点。');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].expr, '1d6+1d4+3');
});

test('贪婪吃掉乘法与取大：3d6k2*5', () => {
    assert.equal(findExpressions('投3d6k2*5')[0].expr, '3d6k2*5');
});

test('遇到非运算符就停：1d100，话术40 只吃 1d100', () => {
    const hits = findExpressions('话术检定（1d100，话术 40）');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].expr, '1d100');
});

test('一次投多个：一轮多骰的基础', () => {
    const hits = findExpressions('NPC甲好感1d100，NPC乙好感1d100，NPC丙好感1d100');
    assert.equal(hits.length, 3);
    assert.deepEqual(hits.map((h) => h.expr), ['1d100', '1d100', '1d100']);
});

test('不会误伤正文里的字母：d6 / COC7 / 2020d / 3D', () => {
    assert.deepEqual(findExpressions('只要d6就行'), []);
    assert.deepEqual(findExpressions('COC7 版规则'), []);
    assert.deepEqual(findExpressions('2020d 年'), []);
    assert.deepEqual(findExpressions('D3 玻璃'), []);
});

test('数量必填：d100 不认，1d100 认', () => {
    assert.deepEqual(findExpressions('投 d100 决定'), []);
    assert.equal(findExpressions('投 1d100 决定')[0].expr, '1d100');
});

test('残缺的尾巴不会把运算符吃进去', () => {
    assert.equal(findExpressions('加值 1d3+ ')[0].expr, '1d3');
    assert.equal(findExpressions('加值 1d3+')[0].expr, '1d3');
});

test('带空格的表达式能吃下（但不会吃掉后面的句子）', () => {
    assert.equal(findExpressions('投 3d6 + 2 点')[0].expr, '3d6 + 2');
});

test('matchExpressionAt 在非骰子位置返回 -1', () => {
    assert.equal(matchExpressionAt('只要d6就行', 2), -1);
    assert.equal(matchExpressionAt('COC7 版', 0), -1);
    assert.ok(matchExpressionAt('1d100', 0) > 0);
});

test('splitAtFirstExpression：严格因果模式要用的切分', () => {
    const r = splitAtFirstExpression('走了1d3天，接着1d10');
    assert.equal(r.before, '走了');
    assert.equal(r.expr, '1d3');
    assert.equal(r.after, '天，接着1d10');

    const none = splitAtFirstExpression('没有骰子');
    assert.equal(none.expr, null);
    assert.equal(none.before, '没有骰子');
});

test('resolveExpressions：原地替换，且能带上日志字段', () => {
    const { text, results } = resolveExpressions('走了1d3天，又投1d10。', (expr) => {
        const value = expr === '1d3' ? 2 : 7;
        return { replacement: formatRoll(expr, value), value };
    });
    assert.equal(text, '走了【1d3=2】天，又投【1d10=7】。');
    assert.equal(results.length, 2);
    assert.deepEqual(results.map((r) => r.value), [2, 7]);
    assert.equal(results[0].expr, '1d3');
});

test('resolveExpressions：替换结果里含【】也不会被二次解析', () => {
    const first = resolveExpressions('走了1d3天', (expr) => formatRoll(expr, 2));
    const second = resolveExpressions(first.text, () => formatRoll('1d3', 9));
    assert.equal(second.text, '走了【1d3=2】天');
    assert.equal(second.results.length, 0);
});

test('resolveExpressions：没有表达式时原样返回', () => {
    const { text, results } = resolveExpressions('这句话没有骰子', () => 'X');
    assert.equal(text, '这句话没有骰子');
    assert.deepEqual(results, []);
});

test('设计书 §3.2 那段成品大纲：所有表达式都已解析', () => {
    const outline = [
        '行李寄在旅店，第二天清晨动身去码头。水路走了【1d3=2】天。',
        '先去哪边打听 —— 选项骰十项：1-3 酒馆 / 4-6 货栈 / 7-9 码头管事 / 10 大成功·大失败',
        '→【1d10=7】落在 7-9：我找了码头管事。',
        '我试探他 →【1d100=68 / 话术40 → 失败】',
        '管事听出我在套话，手往柜台下面摸。',
        '→【1d10=10 → 1d2=2（大失败）】',
        '大失败效果 →【1d10=4】→ 4-6 区间：身份暴露，消息走漏。',
    ].join('\n');
    assert.deepEqual(findExpressions(outline), [], '成品大纲里不该再有未解析的表达式');
});

test('★ 已知陷阱：表格标题里写了 1d10，成品大纲会永远残留一个"待投骰点"', () => {
    // 「先去哪边打听（1d10）：」这种表头里的 1d10 是标签不是请求，
    // 但扫描器分不出来 —— 所以书写规范要求：表头用文字描述，表达式只写在请求行。
    const badHeader = '先去哪边打听（1d10）：1-3 酒馆 / 10 大成功·大失败\n→【1d10=7】';
    assert.equal(findExpressions(badHeader).length, 1, '表头那个 1d10 会一直被当成待投');

    const goodHeader = '先去哪边打听 —— 选项骰十项：1-3 酒馆 / 10 大成功·大失败\n→【1d10=7】';
    assert.deepEqual(findExpressions(goodHeader), [], '表头改成文字描述就干净了');
});

test('未解析的成品大纲：该认出 3 个待投骰点', () => {
    const draft = [
        '行李寄在旅店，水路走了1d3天。',
        '先去哪边打听 —— 选项骰十项：1-3 酒馆 / 4-6 货栈 / 7-9 码头管事 / 10 大成功·大失败',
        '→ 1d10',
        '我试探他 → 1d100【话术40】',
    ].join('\n');
    const hits = findExpressions(draft);
    assert.deepEqual(hits.map((h) => h.expr), ['1d3', '1d10', '1d100']);
});

test('检定注解写在表达式的【】里时，表达式本身照样能被认出来', () => {
    // 这是推荐的检定写法：1d100【话术40】
    // 注解被 【】 包住 → 不会二次解析；表达式在 【】 之前 → 正常识别
    const hits = findExpressions('我试探他 → 1d100【话术40】');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].expr, '1d100');
});

test('注解前面多一个空格也能认（容错），而且空格会一起被替换掉', () => {
    const option = findDiceUnits('→ 1d10 【选项】');
    assert.equal(option.length, 1);
    assert.equal(option[0].annotation?.kind, 'option');
    assert.equal(option[0].raw, '1d10 【选项】', '中间的空格要一起吃掉，免得替换后留双空格');

    const check = findDiceUnits('1d100 【话术40】');
    assert.equal(check[0].annotation?.kind, 'check');
    assert.equal(check[0].annotation.name, '话术');
});

test('★ 已知陷阱：一次检定写成两个表达式会被投两次', () => {
    // 「（1d100，话术 40）→ 1d100」这种写法里有两个 1d100，插件会各投一次 ——
    // 所以书写规范必须钉死"一次检定只写一个表达式"。
    const hits = findExpressions('我试探他（1d100，话术 40）→ 1d100');
    assert.equal(hits.length, 2, '两个表达式就会被投两次，这是规范要避免的');
});

test('findInvalidDiceLike：像骰子但解析不过去的残片要被抓出来', () => {
    const bad = findInvalidDiceLike('投3d6k4 试试');
    assert.equal(bad.length, 1);
    assert.equal(bad[0].raw, '3d6k4');

    assert.deepEqual(findInvalidDiceLike('投3d6k2 试试'), [], '合法的不该被当成残片');
    assert.deepEqual(findInvalidDiceLike('【3d6k4】'), [], '已解析括号里的不管');
});

test('formatRoll 输出内联回执', () => {
    assert.equal(formatRoll('1d3', 2), '【1d3=2】');
    assert.equal(formatRoll('3d6k2+1', 11), '【3d6k2+1=11】');
});

// ---------------------------------------------------------------------------
// 扫描性能：别退回 O(n²)
// ---------------------------------------------------------------------------

test('★ 一长串数字不会卡死（曾经是 O(n²) 回溯，10 万位要 11 秒）', () => {
    // 病因：用 /\d+[dD]\d+/g 扫文本时，每个起点都要把 \d+ 吃到结尾、
    // 再一位一位回退找 d/D —— 长数字串上就是平方级。改成线性扫描后应低于 500ms。
    const text = '1'.repeat(100000);
    const started = performance.now();
    const found = findExpressions(text);
    const ms = performance.now() - started;

    assert.equal(found.length, 0);
    assert.ok(ms < 500, `10 万位数字耗时 ${ms.toFixed(0)}ms —— 超过 500ms 说明又退回 O(n²) 了`);
});

test('★ 数字 + 结尾 d 也不该卡（另一个平方级形状）', () => {
    const text = `${'1'.repeat(50000)}d`;
    const started = performance.now();
    findExpressions(text);
    findInvalidDiceLike(text);
    const ms = performance.now() - started;
    assert.ok(ms < 500, `耗时 ${ms.toFixed(0)}ms`);
});

test('★ 线性扫描与原来的正则逐字等价（对拍）', () => {
    // 保留这条是为了防止有人"顺手"把扫描换回正则：两者的结果必须一致。
    const byRegex = (text) => {
        const out = [];
        const re = new RegExp(DICE_CANDIDATE_RE.source, 'g');
        let match;
        while ((match = re.exec(text)) !== null) {
            out.push([match.index, match.index + match[0].length]);
        }
        return out;
    };
    const byScanner = (text) => {
        const out = [];
        let cursor = 0;
        for (;;) {
            const candidate = nextDiceCandidate(text, cursor);
            if (!candidate) break;
            out.push([candidate.start, candidate.end]);
            cursor = candidate.end;
        }
        return out;
    };

    const alphabet = '0123456789dD+-kxX abc中文。【】';
    let seed = 20240613;
    const random = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
    };

    for (let i = 0; i < 2000; i += 1) {
        let text = '';
        const length = 1 + Math.floor(random() * 40);
        for (let j = 0; j < length; j += 1) {
            text += alphabet[Math.floor(random() * alphabet.length)];
        }
        assert.deepEqual(byScanner(text), byRegex(text), `不一致的串：${JSON.stringify(text)}`);
    }

    // 几个手写的边界
    for (const text of ['1d6', '1d2d3', 'a1d2', '1d', 'd6', '12d34', '1D6', '1 d 6', '【1d6】', '1d6+1d6']) {
        assert.deepEqual(byScanner(text), byRegex(text), `不一致的串：${JSON.stringify(text)}`);
    }
});



test('stripEcho：整段重抄会被切掉', () => {
    const settled = '走了【1d3=2】天';
    assert.equal(stripEcho(settled, `${settled}，靠岸时天黑了。`), '，靠岸时天黑了。');
});

test('stripEcho：只重抄尾巴也能切掉', () => {
    const settled = '我把行李寄在旅店，第二天清晨动身去码头。水路走了【1d3=2】天';
    const raw = '水路走了【1d3=2】天，靠岸时天黑了。';
    assert.equal(stripEcho(settled, raw), '，靠岸时天黑了。');
});

test('stripEcho：正常的续写不该被动', () => {
    const settled = '走了【1d3=2】天';
    assert.equal(stripEcho(settled, '，靠岸时天黑了。'), '，靠岸时天黑了。');
});

test('stripEcho：已定稿太短时宁可不切（避免误伤正文）', () => {
    assert.equal(stripEcho('天', '天气不错'), '天气不错');
    assert.equal(stripEcho('', '什么都行'), '什么都行');
});

test('stripEcho：已定稿为空时原样返回', () => {
    assert.equal(stripEcho('', '第一段'), '第一段');
});
