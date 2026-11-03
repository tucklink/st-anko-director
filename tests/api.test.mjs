import test from 'node:test';
import assert from 'node:assert/strict';

import {
    API_KINDS,
    buildRequest,
    callChatApi,
    normalizeBaseUrl,
    readGeminiText,
    readOpenAiText,
} from '../src/api.js';

/** 假的 fetch：记下请求，按脚本返回。 */
function fakeFetch(script = {}) {
    const calls = [];
    const impl = async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        const next = Array.isArray(script) ? script[calls.length - 1] : script;
        if (next instanceof Error) {
            throw next;
        }
        const { status = 200, body = '{}' } = next ?? {};
        return {
            ok: status >= 200 && status < 300,
            status,
            statusText: status === 200 ? 'OK' : 'Error',
            text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        };
    };
    impl.calls = calls;
    return impl;
}

test('base URL：去尾斜杠，空了给该接口的官方默认值', () => {
    assert.equal(normalizeBaseUrl('https://a.example/v1/', 'openai'), 'https://a.example/v1');
    assert.equal(normalizeBaseUrl('', 'openai'), API_KINDS.openai.defaultBaseUrl);
    assert.equal(normalizeBaseUrl('', 'gemini'), API_KINDS.gemini.defaultBaseUrl);
});

test('OpenAI 兼容：URL / 请求头 / body 都对', () => {
    const { url, headers, body } = buildRequest({
        kind: 'openai',
        baseUrl: 'https://api.example/v1',
        apiKey: 'sk-test',
        model: 'gpt-x',
        systemPrompt: '你是导演',
        prompt: '玩家去了码头',
        temperature: 0.7,
        maxTokens: 2048,
    });
    assert.equal(url, 'https://api.example/v1/chat/completions');
    assert.equal(headers.Authorization, 'Bearer sk-test');
    assert.equal(body.model, 'gpt-x');
    assert.equal(body.stream, false);
    assert.equal(body.temperature, 0.7);
    assert.equal(body.max_tokens, 2048);
    assert.deepEqual(body.messages, [
        { role: 'system', content: '你是导演' },
        { role: 'user', content: '玩家去了码头' },
    ]);
});

test('OpenAI 兼容：prefill 变成末尾的 assistant 消息', () => {
    const { body } = buildRequest({
        kind: 'openai', apiKey: 'k', model: 'm', prompt: 'p', prefill: '已定稿的开头',
    });
    assert.equal(body.messages.at(-1).role, 'assistant');
    assert.equal(body.messages.at(-1).content, '已定稿的开头');
});

test('Gemini：URL 用 x-goog-api-key，正文走 contents，system 走 systemInstruction', () => {
    const { url, headers, body } = buildRequest({
        kind: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'AIza-test',
        model: 'gemini-2.5-pro',
        systemPrompt: '你是导演',
        prompt: '玩家去了码头',
        temperature: 0.4,
        maxTokens: 1024,
    });
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent');
    assert.equal(headers['x-goog-api-key'], 'AIza-test');
    assert.equal(headers.Authorization, undefined, 'Gemini 不该带 Bearer 头');
    assert.equal(body.systemInstruction.parts[0].text, '你是导演');
    assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: '玩家去了码头' }] }]);
    assert.equal(body.generationConfig.temperature, 0.4);
    assert.equal(body.generationConfig.maxOutputTokens, 1024);
});

test('Gemini：prefill 变成末尾的 model 回合', () => {
    const { body } = buildRequest({
        kind: 'gemini', apiKey: 'k', model: 'm', prompt: 'p', prefill: '开头',
    });
    assert.equal(body.contents.at(-1).role, 'model');
});

test('解析响应：两种形态都取得到正文', () => {
    assert.equal(readOpenAiText({ choices: [{ message: { content: '甲' } }] }), '甲');
    assert.equal(readOpenAiText({ choices: [{ message: { content: [{ type: 'text', text: '乙' }] } }] }), '乙');
    assert.equal(readOpenAiText({}), '');
    assert.equal(readGeminiText({ candidates: [{ content: { parts: [{ text: '丙' }] } }] }), '丙');
    // thinking 部分要跳过
    assert.equal(readGeminiText({
        candidates: [{ content: { parts: [{ text: '想…', thought: true }, { text: '丁' }] } }],
    }), '丁');
    assert.equal(readGeminiText({}), '');
});

test('★ 直连：正常响应返回正文', async () => {
    const fetchImpl = fakeFetch({ body: { choices: [{ message: { content: '大纲来了' } }] } });
    const text = await callChatApi({
        kind: 'openai', baseUrl: 'https://api.example/v1', apiKey: 'k', model: 'm',
        systemPrompt: 's', prompt: 'p', fetchImpl,
    });
    assert.equal(text, '大纲来了');
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, 'https://api.example/v1/chat/completions');
});

test('★ 直连：接口报错时把**服务端原文**带出来（这正是酒馆那条路做不到的）', async () => {
    const fetchImpl = fakeFetch({
        status: 400,
        body: { error: { message: 'Requests ending with a model turn are not supported.' } },
    });
    await assert.rejects(
        () => callChatApi({ apiKey: 'k', model: 'm', prompt: 'p', fetchImpl }),
        /接口返回 400 .*model turn/s,
    );
});

test('★ 直连：CORS / 网络失败要说人话，并指向另一条路', async () => {
    const fetchImpl = fakeFetch(new TypeError('Failed to fetch'));
    await assert.rejects(
        () => callChatApi({ apiKey: 'k', model: 'm', prompt: 'p', fetchImpl }),
        (error) => {
            assert.match(error.message, /请求发不出去/, '要说清是"发不出去"而不是接口报错');
            assert.match(error.message, /CORS/, '要点明 CORS 这个可能');
            assert.match(error.message, /导演走哪个预设/, '要给出退路');
            return true;
        },
    );
});

test('直连：非 JSON 与空正文都有明确报错，不静默', async () => {
    await assert.rejects(
        () => callChatApi({ apiKey: 'k', model: 'm', prompt: 'p', fetchImpl: fakeFetch({ body: '<html>502</html>' }) }),
        /不是 JSON/,
    );
    await assert.rejects(
        () => callChatApi({ apiKey: 'k', model: 'm', prompt: 'p', fetchImpl: fakeFetch({ body: {} }) }),
        /没返回正文/,
    );
});

test('直连：缺 key / 缺模型名时立刻报错，不发请求', async () => {
    const fetchImpl = fakeFetch({});
    await assert.rejects(() => callChatApi({ model: 'm', prompt: 'p', fetchImpl }), /没填 API Key/);
    await assert.rejects(() => callChatApi({ apiKey: 'k', prompt: 'p', fetchImpl }), /没填模型名/);
    assert.equal(fetchImpl.calls.length, 0);
});
