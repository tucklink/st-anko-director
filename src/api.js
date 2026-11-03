/**
 * 内置 API 调用 —— **完全不走酒馆**。
 *
 * 为什么要有这个：酒馆那条路（`generateRaw` / 连接配置）总是被酒馆的设置、
 * 预设、提示词组装牵着走，而且**服务端的错误原文经常传不出来**
 * （见规范 B22：`throw new Error(data)` 会把 `.message` 变成 "[object Object]"）。
 * 自己发请求就自由了：模型、温度、token 上限都归插件管，
 * **错误信息也是我们自己解析的原文**，不用猜。
 *
 * ⚠️ 最大的现实约束是 **CORS**：浏览器直连第三方接口，对方必须允许跨源。
 * - 允许：OpenRouter、Google Gemini、本地 Ollama / LM Studio（通常要开 OLLAMA_ORIGINS）
 * - 需要额外请求头：Anthropic（`anthropic-dangerous-direct-browser-access: true`）
 * - 直接拒绝：一部分自建网关
 * 所以把"发不出去"和"接口报错"分成两种错误，第一种明确提示是 CORS。
 *
 * ⚠️ API Key 会存在酒馆的设置里（`extension_settings`），也就是**明文存在你的
 * 设置文件里**。酒馆自己的 key 也是这样存的，但你要知道这件事。
 */

/** 支持的接口形态。 */
export const API_KINDS = Object.freeze({
    openai: {
        label: 'OpenAI 兼容（/chat/completions）',
        defaultBaseUrl: 'https://api.openai.com/v1',
    },
    gemini: {
        label: 'Google Gemini（generateContent）',
        defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    },
});

/** 把错误正文截短，别把一整个 HTML 错误页糊到提示上。 */
function shorten(text, limit = 400) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** 去掉尾部斜杠；空的话给该接口的官方默认地址。 */
export function normalizeBaseUrl(baseUrl, kind = 'openai') {
    const raw = String(baseUrl ?? '').trim() || (API_KINDS[kind]?.defaultBaseUrl ?? '');
    return raw.replace(/\/+$/, '');
}

/** OpenAI 兼容响应里取正文。 */
export function readOpenAiText(data) {
    const message = data?.choices?.[0]?.message;
    if (!message) {
        return '';
    }
    // 有的推理模型把正文放在 content、思考放在 reasoning_content
    if (typeof message.content === 'string' && message.content.trim()) {
        return message.content;
    }
    if (Array.isArray(message.content)) {
        // 有些实现把 content 做成 [{type:'text',text:'…'}]
        return message.content
            .map((part) => (typeof part === 'string' ? part : String(part?.text ?? '')))
            .join('')
            .trim();
    }
    return '';
}

/** Gemini 响应里取正文（跳过 thinking 部分）。 */
export function readGeminiText(data) {
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) {
        return '';
    }
    return parts
        .filter((part) => part && !part.thought)
        .map((part) => String(part.text ?? ''))
        .join('')
        .trim();
}

/** 拼请求（单独导出，好让测试直接检查 URL / 请求头 / body）。 */
export function buildRequest({
    kind = 'openai',
    baseUrl = '',
    apiKey = '',
    model = '',
    systemPrompt = '',
    prompt = '',
    prefill = '',
    temperature = null,
    maxTokens = null,
} = {}) {
    const base = normalizeBaseUrl(baseUrl, kind);
    const headers = { 'Content-Type': 'application/json' };
    let url = '';
    let body = {};

    const hasTemperature = Number.isFinite(temperature);
    const hasMaxTokens = Number.isFinite(maxTokens) && maxTokens > 0;

    if (kind === 'gemini') {
        url = `${base}/models/${encodeURIComponent(model)}:generateContent`;
        headers['x-goog-api-key'] = apiKey;
        const contents = [{ role: 'user', parts: [{ text: prompt }] }];
        if (prefill) {
            contents.push({ role: 'model', parts: [{ text: prefill }] });
        }
        body = {
            contents,
            ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
            ...(hasTemperature || hasMaxTokens
                ? {
                    generationConfig: {
                        ...(hasTemperature ? { temperature } : {}),
                        ...(hasMaxTokens ? { maxOutputTokens: maxTokens } : {}),
                    },
                }
                : {}),
        };
    } else {
        url = `${base}/chat/completions`;
        headers.Authorization = `Bearer ${apiKey}`;
        const messages = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push({ role: 'user', content: prompt });
        if (prefill) {
            messages.push({ role: 'assistant', content: prefill });
        }
        body = {
            model,
            messages,
            stream: false,
            ...(hasTemperature ? { temperature } : {}),
            ...(hasMaxTokens ? { max_tokens: maxTokens } : {}),
        };
    }

    return { url, headers, body };
}

/**
 * 发一次请求，返回正文。
 *
 * @param {object} options
 * @param {'openai'|'gemini'} [options.kind]
 * @param {string} options.baseUrl
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {string} [options.systemPrompt]
 * @param {string} [options.prompt]
 * @param {string} [options.prefill]
 * @param {number} [options.temperature]
 * @param {number} [options.maxTokens]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.fetchImpl] 注入用（测试里换成假的）
 * @returns {Promise<string>}
 */
export async function callChatApi(options = {}) {
    const kind = API_KINDS[options.kind] ? options.kind : 'openai';
    const apiKey = String(options.apiKey ?? '').trim();
    const model = String(options.model ?? '').trim();

    if (!apiKey) {
        throw new Error('内置 API：没填 API Key');
    }
    if (!model) {
        throw new Error('内置 API：没填模型名');
    }

    const { url, headers, body } = buildRequest({ ...options, kind, apiKey, model });
    const doFetch = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) {
        throw new Error('这个环境没有 fetch，没法直连接口');
    }

    let response;
    try {
        response = await doFetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: options.signal ?? undefined,
        });
    } catch (error) {
        // 这里最常见的不是网络断，而是 CORS —— 明确说出来，别让人去查网络
        throw new Error(`请求发不出去（${error?.message ?? error}）。`
            + '如果提示 Failed to fetch / NetworkError，多半是这个接口**不允许浏览器直接调用**（CORS）——'
            + '那就改用「导演走哪个预设」那条路（酒馆服务端代发）。');
    }

    const raw = await response.text();
    if (!response.ok) {
        throw new Error(`接口返回 ${response.status} ${response.statusText ?? ''}：${shorten(raw)}`);
    }

    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        throw new Error(`接口返回的不是 JSON：${shorten(raw)}`);
    }

    const content = kind === 'gemini' ? readGeminiText(data) : readOpenAiText(data);
    if (!content) {
        // 有些安全过滤/空响应会走到这里，把原文带上
        throw new Error(`接口没返回正文：${shorten(raw)}`);
    }
    return content;
}
