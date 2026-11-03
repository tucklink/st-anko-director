/**
 * ============================================================================
 *  预设 → 请求参数（把酒馆预设"搬"到导演这条路上）
 * ============================================================================
 *  为什么需要这个模块：
 *    「导演走哪个连接配置」那条路会把 `presetName` 交给酒馆 ✓，但**酒馆对预设的应用程度
 *    随版本变化** ✗：
 *      · ST **1.14.0**：`ChatCompletionService.presetToGeneratePayload` **只取 temperature**
 *        （`custom-request.js:568` 实测 ✓）
 *      · 当前 release 分支：已经改成走 `createGenerationParameters`，整套参数都会带上 ✓
 *    于是同一个插件，在不同酒馆版本上"预设生效多少"完全不同 ✗ —— 用户看到的就是
 *    "我明明绑了预设，怎么没效果" ✓。
 *
 *  所以这里**照抄酒馆自己的映射规则**（`openai.js:264` 的 `settingsToUpdate`）：
 *    预设 JSON 的键 → 请求 payload 的键 ✓
 *  这样实现一次，**两个版本行为一致** ✓，也不再依赖酒馆内部函数有没有导出 ✓。
 *
 *  ⚠️ 只抄**采样参数**，不抄这些 ✗：
 *    · `prompts` / `prompt_order` —— 那是提示词编排 ✓，抄了会把导演自己的系统提示词冲掉 ✗
 *    · `stream_openai` / `openai_max_context` —— 不是采样参数 ✓
 *    · 模型名（`openai_model` 等）—— 连接配置已经带了模型 ✓
 */

/** 所有聊天来源都安全的字段（OpenAI 官方也认这些 ✓） */
const COMMON_FIELDS = Object.freeze({
    temperature: 'temperature',
    top_p: 'top_p',
    frequency_penalty: 'frequency_penalty',
    presence_penalty: 'presence_penalty',
    seed: 'seed',
    n: 'n',
    reasoning_effort: 'reasoning_effort',
});

/** 只有"宽松的"来源才带的字段 —— OpenAI 官方收到这些会 400 ✗ */
const TOLERANT_FIELDS = Object.freeze({
    top_k: 'top_k',
    min_p: 'min_p',
    top_a: 'top_a',
    repetition_penalty: 'repetition_penalty',
});

/** 会容忍额外采样字段的来源（其余来源只取 COMMON_FIELDS ✓） */
const TOLERANT_SOURCES = Object.freeze(new Set([
    'openrouter',
    'custom',
    'mistralai',
    'cohere',
    'perplexity',
]));

/**
 * 把一段预设 JSON 转成"可以直接并进 payload 的字段"。
 *
 * @param {object|null|undefined} preset 酒馆预设对象（`getCompletionPresetByName` 的返回值）
 * @param {object} [options]
 * @param {string} [options.source] 聊天来源（`chat_completion_source`），用来决定要不要带 top_k 这类字段
 * @returns {object} 可直接展开进 payload 的字段表（**只含有值的键** ✓）
 */
export function presetToPayload(preset, { source = '' } = {}) {
    /** @type {Record<string, any>} */
    const out = {};
    if (!preset || typeof preset !== 'object') {
        return out;
    }

    const tolerant = TOLERANT_SOURCES.has(String(source ?? '').trim());
    const map = tolerant ? { ...COMMON_FIELDS, ...TOLERANT_FIELDS } : COMMON_FIELDS;

    for (const [presetKey, payloadKey] of Object.entries(map)) {
        const value = preset[presetKey];
        if (!isUsableNumber(value)) {
            continue;
        }
        out[payloadKey] = Number(value);
    }

    // ⚠️ 预设里的额度字段叫 `openai_max_tokens` ✗，payload 里叫 `max_tokens` ✓
    //    （`openai.js:312` 的映射：`openai_max_tokens → openai_max_tokens`，
    //     再在组装 payload 时变成 `max_tokens` ✓）
    const maxTokens = preset.openai_max_tokens;
    if (isUsableNumber(maxTokens) && Number(maxTokens) > 0) {
        out.max_tokens = Math.trunc(Number(maxTokens));
    }

    // ⚠️ 照抄酒馆的行为：`top_p` 是 0 时改成 Number.EPSILON ✓
    //    （`openai.js:2459`：`generate_data.top_p = generate_data.top_p || Number.EPSILON` ✓）
    //    直接把 0 传下去，很多端点会当成"停用采样"或直接报错 ✗
    if (out.top_p === 0) {
        out.top_p = Number.EPSILON;
    }

    // ⚠️ **绝不抄请求体改写字段** ✗：`custom_include_body` / `custom_exclude_body` /
    // `custom_include_headers` 会**直接改发出去的请求** ✓（服务端：
    // `chat-completions.js:1878` 合并、`:2068` 删键 ✓）。预设里配了 `messages` 之类就会
    // **把整段上下文删掉/覆盖掉** ✗ —— 用户实测症状就是"原文上下文直接没了" ✗。
    // 这些是网络层的 hack，不是采样参数 ✓，不该跟着"预设生效"一起搬 ✓。

    return out;
}

/**
 * 值能不能用：数字 ✓、数字字符串 ✓；`null` / `undefined` / `''` / `NaN` 全部跳过 ✗。
 *
 * 为什么要这么严：预设里 `"top_p": null` 是**很常见的写法** ✓（酒馆自己导出就这样），
 * 原样传下去会变成 `top_p: null` → 端点报错 ✗。
 */
function isUsableNumber(value) {
    if (value === null || value === undefined || value === '') {
        return false;
    }
    const n = Number(value);
    return Number.isFinite(n);
}

/**
 * 把**酒馆的实时设置**（`getContext().chatCompletionSettings` = `oai_settings`）转成 payload 字段 ✓。
 *
 * 为什么用这个而不是自己解析预设 JSON ✗（这是我前面一直没抄对的地方 ✗）：
 *   酒馆的做法是——选中预设时把它**写进 `oai_settings`** ✓，之后每次请求都从这份实时设置取参数 ✓。
 *   所以"抄预设"最忠实的做法是读**同一份实时设置** ✓，而不是自己去找预设对象再映射 ✗
 *   （后者要赌"预设名对得上""字段名一致"，全是多余的失败点 ✗）。
 *
 * 字段名照 `openai.js` 的 `default_settings` ✓（`temp_openai` / `top_p_openai` / `openai_max_tokens` …）；
 * payload 里的名字照酒馆发出去的样子 ✓（`temperature` / `top_p` / `max_tokens` …）。
 *
 * @param {object|null|undefined} settings 酒馆实时设置（`chatCompletionSettings`）
 * @param {object} [options]
 * @param {string} [options.source] 聊天来源，决定要不要带 top_k 这类"宽松来源才认"的字段
 * @returns {object} 可直接展开进 payload 的字段表（只含有值的键 ✓）
 */
export function settingsToPayload(settings, { source = '' } = {}) {
    /** @type {Record<string, any>} */
    const out = {};
    if (!settings || typeof settings !== 'object') {
        return out;
    }

    const tolerant = TOLERANT_SOURCES.has(String(source ?? '').trim());
    const common = {
        temperature: 'temp_openai',
        top_p: 'top_p_openai',
        frequency_penalty: 'freq_pen_openai',
        presence_penalty: 'pres_pen_openai',
        seed: 'seed',
        n: 'n',
    };
    const tolerantMap = {
        top_k: 'top_k_openai',
        min_p: 'min_p_openai',
        top_a: 'top_a_openai',
        repetition_penalty: 'repetition_penalty_openai',
    };
    const map = tolerant ? { ...common, ...tolerantMap } : common;

    for (const [payloadKey, settingsKey] of Object.entries(map)) {
        const value = settings[settingsKey];
        if (!isUsableNumber(value)) {
            continue;
        }
        // `repetition_penalty` 在酒馆里默认 1（= 不惩罚）✓ —— 1 不是"有效值"，传了反而改变行为 ✗
        if (payloadKey === 'repetition_penalty' && Number(value) === 1) {
            continue;
        }
        out[payloadKey] = Number(value);
    }

    const maxTokens = settings.openai_max_tokens;
    if (isUsableNumber(maxTokens) && Number(maxTokens) > 0) {
        out.max_tokens = Math.trunc(Number(maxTokens));
    }

    if (out.top_p === 0) {
        out.top_p = Number.EPSILON;
    }

    // `reasoning_effort` 是**字符串枚举**（low/medium/high/minimal）✗ 不是数字 ✓ ——
    // 按数字过滤会把它整个丢掉 ✗（我就这么丢过一次 ✓）。
    // `auto` = 酒馆的"不发送" ✓（见 ST 文档 Reasoning 那页的 Auto 行 ✓），所以不传 ✓。
    const effort = typeof settings.reasoning_effort === 'string'
        ? settings.reasoning_effort.trim()
        : '';
    if (effort && effort !== 'auto') {
        out.reasoning_effort = effort;
    }

    return out;
}

/**
 * 变量更新类内容（来自 MVU 那类"变量/状态栏"方案 ✓）—— 导演**不需要** ✗。
 *
 * 依据（MVU 教程 ✓，[tutorial.md](https://raw.githubusercontent.com/MagicalAstrogy/MagVarUpdate/master/doc/tutorial.md)）：
 *   · 更新语句块：`<UpdateVariable> … </UpdateVariable>` ✓
 *   · 变量快照块：`<status_current_variable> … </status_current_variable>` ✓
 *   · 更新语法：`_.set('路径', 老, 新); //原因` ✓
 *   · 常见字段/条目名：`stat_data` / `display_data` / `变量` / `UpdateVariable` ✓
 * 这些内容是给"写正文的那一侧"维护状态的 ✓，塞给导演只会让它分心 ✗（而且我们是写大纲的 ✓）。
 */
const VARIABLE_NAME_RE = /变量|variable|stat_data|updatevariable|status_current|display_data/i;
const VARIABLE_BLOCK_RES = [
    /<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi,
    /<status_current_variable>[\s\S]*?<\/status_current_variable>/gi,
    /<%-?\s*SafeGetValue\([\s\S]*?%>/gi,
];
const VARIABLE_LINE_RES = [
    /^\s*_\.set\([^\n]*$/gm,
];

/**
 * 把酒馆预设里的**提示词编排**（`prompts` + `prompt_order`）拼成一段"写作口径" ✓。
 *
 * 为什么需要（用户点破的）：**预设的主体是那几十条 system 指令** ✗ 不是采样参数 ✓。
 * 用户那份预设是 67 条（`prompt_settings_openai = 示例预设` ✓），内容像
 * 「正文要用 <game></game> 包上」✓、「别把玩家当主角」✓、「NSFW 要温柔」✓ ——
 * 只抄 `temperature` 等于**什么都没抄** ✗（我前面就是这么错的 ✓）。
 *
 * 拼法照酒馆：
 *   · 用 `prompt_order` 里**第一个** order 组的顺序 ✓（没有就按 `prompts` 数组顺序 ✓）
 *   · 只取 `enabled !== false` 的条目 ✓
 *   · 跳过 marker（`main` / `worldInfoAfter` / `chatHistory` 这类是**占位符** ✓，
 *     内容由酒馆运行时填 ✓，这里没有内容 ✓）
 *   · 去掉 `{{// …}}` 注释宏（导出预设里常带作者信息 ✓，塞给模型纯属浪费 ✓）
 *   · 按字符数截断 ✓（默认 8000，够放几十条口径 ✓；超了会明确说"已截断" ✓）
 *
 * @param {object|null|undefined} chatSettings 酒馆实时设置（`chatCompletionSettings`）
 * @param {object} [options]
 * @param {number} [options.maxChars]
 * @returns {{text: string, count: number, truncated: boolean}} 空预设时 `text` 为空串 ✓
 */
export function presetGuidanceFromSettings(chatSettings, { maxChars = 8000, stripVariableUpdates = true } = {}) {
    const empty = { text: '', count: 0, truncated: false, removedVariableEntries: 0, removedVariableChars: 0 };
    if (!chatSettings || typeof chatSettings !== 'object') {
        return empty;
    }
    const prompts = Array.isArray(chatSettings.prompts) ? chatSettings.prompts : [];
    if (prompts.length === 0) {
        return empty;
    }

    const byId = new Map();
    for (const prompt of prompts) {
        if (prompt && typeof prompt === 'object' && typeof prompt.identifier === 'string') {
            byId.set(prompt.identifier, prompt);
        }
    }

    // `prompt_order` 是 [{ character_id, order: [{ identifier, enabled }] }, …] ✓
    // 导出的预设里常见 **两个** 组（默认角色 + 群聊 ✓），这里取第一组 ✓（和酒馆"对角色生效"的首要那组一致 ✓）。
    const orderGroup = Array.isArray(chatSettings.prompt_order) ? chatSettings.prompt_order[0] : null;
    const order = Array.isArray(orderGroup?.order) ? orderGroup.order : null;

    const picked = [];
    if (order) {
        for (const entry of order) {
            if (!entry || typeof entry.identifier !== 'string') {
                continue;
            }
            if (entry.enabled === false) {
                continue;
            }
            const prompt = byId.get(entry.identifier);
            if (prompt) {
                picked.push(prompt);
            }
        }
    } else {
        picked.push(...prompts.filter((p) => p && typeof p === 'object' && p.enabled !== false));
    }

    let removedVariableEntries = 0;
    let removedVariableChars = 0;
    const parts = [];
    for (const prompt of picked) {
        // marker 是占位符 ✓（内容由酒馆运行时填 ✓），这里跳过 ✗
        if (prompt.marker === true) {
            continue;
        }
          // 条目名/identifier 命中变量类 -> 整条不要（导演不维护变量）
          if (stripVariableUpdates) {
              const label = String(prompt.name ?? '') + ' ' + String(prompt.identifier ?? '');
              if (VARIABLE_NAME_RE.test(label)) {
                  removedVariableEntries += 1;
                  continue;
              }
          }
        let content = String(prompt.content ?? '');
        if (!content.trim()) {
            continue;
        }
        // `{{// 注释}}` 是注释宏 ✓ —— 预设导出里常带作者/发布地址 ✓，对模型没用 ✗
        content = content.replace(/\{\{\/\/[\s\S]*?\}\}/g, '').trim();

          // 内容里的变量更新块 / _.set 行 -> 删掉（MVU 语法，导演用不到）
          if (stripVariableUpdates) {
              const before = content.length;
              for (const re of VARIABLE_BLOCK_RES) {
                  content = content.replace(re, '');
              }
              for (const re of VARIABLE_LINE_RES) {
                  content = content.replace(re, '');
              }
              content = content.trim();
              if (content.length !== before) {
                  removedVariableChars += before - content.length;
              }
              // 整条只剩变量内容 → 删完之后空了 → 整条也不要 ✗
              if (!content) {
                  removedVariableEntries += 1;
                  continue;
              }
          }
        if (!content) {
            continue;
        }
        parts.push(content);
    }

    let text = parts.join('\n\n');
    let truncated = false;
    if (text.length > maxChars) {
        text = text.slice(0, maxChars);
        truncated = true;
    }
    return { text, count: parts.length, truncated, removedVariableEntries, removedVariableChars };
}

/**
 * 面板值与预设值合并：**面板填了 = 覆盖预设** ✓（用户定的规矩）。
 *
 * @param {object} presetFields `presetToPayload` 的结果
 * @param {object} panelFields 面板里"用户真的填了"的字段（没填的**不要放进来** ✗）
 * @returns {object}
 */
export function mergePanelOverPreset(presetFields, panelFields) {
    const out = { ...(presetFields ?? {}) };
    for (const [key, value] of Object.entries(panelFields ?? {})) {
        if (value === null || value === undefined || value === '') {
            continue;
        }
        out[key] = value;
    }
    return out;
}

/**
 * 从"连接配置"里把预设读出来并转成 payload 字段。
 *
 * 为什么要抽成函数（而不是直接写在 index.js 里）：
 *   `index.js` 里那条路会 `import('../../shared.js')` ✓，在测试环境里**没有这个文件** ✗
 *   → 整条路根本测不到 ✓。所以把"读预设"这部分做成**只依赖传入 ctx 的纯逻辑**，
 *   测试就能用假的 ctx 覆盖它 ✓（含"预设名对不上"这种最容易被静默吞掉的情况 ✓）。
 *
 * @param {object} ctxLike 酒馆上下文（真实是 `ctx()`，测试里可以用假对象 ✓）
 * @param {string} profileId 连接配置 id
 * @returns {{presetName: string, source: string, fields: object, warning: string|null}}
 */
export function resolveProfilePreset(ctxLike, profileId) {
    const empty = { presetName: '', source: '', fields: {}, warning: null };
    const id = String(profileId ?? '').trim();
    if (!id) {
        return empty;
    }

    const profiles = ctxLike?.extensionSettings?.connectionManager?.profiles;
    if (!Array.isArray(profiles)) {
        return empty;
    }
    const profile = profiles.find((item) => String(item?.id ?? '') === id);
    if (!profile) {
        return { ...empty, warning: `找不到连接配置「${id}」，本次只按面板参数跑` };
    }

    const presetName = String(profile.preset ?? '').trim();
    // profile.api 是 **API 类型**（openai/claude/…）✓，
    // 真正的来源要去 CONNECT_API_MAP 里查 ✓（`shared.js:496` validateProfile 同款查法）
    const source = String(ctxLike?.CONNECT_API_MAP?.[profile.api]?.source ?? '').trim();

    if (!presetName) {
        return { presetName: '', source, fields: {}, warning: null };
    }

    let preset;
    try {
        const manager = ctxLike?.getPresetManager?.('openai');
        preset = manager?.getCompletionPresetByName?.(presetName);
    } catch (error) {
        return {
            presetName,
            source,
            fields: {},
            warning: `读预设「${presetName}」失败（${error?.message ?? error}），本次只按面板参数跑`,
        };
    }

    if (!preset) {
        // 最容易被静默吞掉的一种失败：预设被改过名，绑的那条就永远对不上 ✗
        return {
            presetName,
            source,
            fields: {},
            warning: `连接配置绑的预设「${presetName}」在酒馆里找不到（改名了？），本次只按面板参数跑`,
        };
    }

    return { presetName, source, fields: presetToPayload(preset, { source }), warning: null };
}