/**
 * 集成测试：用一个**假的酒馆**把 index.js 真正加载起来。
 *
 * 验证的是"接线"是否正确 —— 命令注册、参数解析、导演循环接 generateRaw、
 * 面板渲染与事件绑定、发送前自动推演、提示词注入、状态落盘。
 * 不用开酒馆，也不用点鼠标。
 */

import test, { before } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// 假酒馆
// ---------------------------------------------------------------------------

const registeredCommands = new Map();
const debugFunctions = new Map();
const eventHandlers = new Map();
const valueWrites = new Map();
const domAppends = [];
const loadedMessages = [];

/** 测试可以改这个来换模型行为。 */
const scenario = {
    /** generateRaw 的剧本，按调用次数依次返回 */
    script: [],
    calls: [],
    /** 是否让 generateRaw 抛错 */
    fail: false,
};

function resetScenario(script = []) {
    scenario.script = script;
    scenario.calls = [];
    scenario.fail = false;
}

/** 所有 DOM 节点的状态共用一个表，这样 `$('#x')` 两次拿到的是"同一个节点"。 */
const nodeStore = new Map();

function nodeOf(selector) {
    if (!nodeStore.has(selector)) {
        nodeStore.set(selector, {
            props: {},
            handlers: {},
            text: '',
            value: '',
            visible: true,
            length: selector === '#anko_panel' ? 0 : 1,
        });
    }
    return nodeStore.get(selector);
}

function fakeJQuery(selector) {
    // 真 jQuery 支持 $(element)，事件回调里传的就是元素本身 —— 这里也要认
    if (selector && typeof selector === 'object' && typeof selector.val === 'function' && selector.selector) {
        return selector;
    }
    const state = nodeOf(selector);
    return {
        selector,
        get length() {
            return state.length;
        },
        append(child) {
            domAppends.push([selector, child]);
            return this;
        },
        appendTo(target) {
            const to = typeof target === 'string' ? target : target?.selector;
            state.appendedTo = to;
            domAppends.push([to, selector]);
            return this;
        },
        attr(name, value) {
            state.attrs = state.attrs ?? {};
            if (value === undefined) {
                return state.attrs[name];
            }
            state.attrs[name] = String(value);
            return this;
        },
        css(prop, value) {            state.css = state.css ?? {};
            if (prop && typeof prop === 'object') {
                Object.assign(state.css, prop);
                return this;
            }
            if (value === undefined) {
                return state.css[prop];
            }
            state.css[prop] = value;
            return this;
        },
        replaceWith() { return this; },
        remove() { return this; },
        html(value) {
            if (value === undefined) {
                return state.html ?? '';
            }
            state.html = String(value);
            return this;
        },
        empty() {
            state.html = '';
            return this;
        },
        text(value) {
            if (value === undefined) {
                return state.text;
            }
            state.text = String(value);
            return this;
        },
        val(value) {
            if (value === undefined) {
                return selector === '#send_textarea' ? (valueWrites.get(selector) ?? '') : state.value;
            }
            valueWrites.set(selector, String(value));
            state.value = String(value);
            return this;
        },
        prop(key, value) {
            if (value === undefined) {
                return state.props[key];
            }
            state.props[key] = value;
            return this;
        },
        on(event, handler) {
            state.handlers[event] = handler;
            return this;
        },
        trigger(event) {
            loadedMessages.push(['trigger', selector, event]);
            return this;
        },
        toggle(show) {
            state.visible = typeof show === 'boolean' ? show : !state.visible;
            return this;
        },
        toggleClass(name, on) {
            state.classes = state.classes ?? new Set();
            if (on) {
                state.classes.add(name);
            } else {
                state.classes.delete(name);
            }
            return this;
        },
        hasClass(name) {
            return Boolean(state.classes?.has(name));
        },
    };
}

function makeStubContext() {
    const context = {
        extensionSettings: {},
        chatMetadata: {},
        chat: [],
        characters: [{ description: '一个精瘦的码头管事' }],
        characterId: 0,
        name1: '玩家',
        name2: '旁白',
        saveSettingsDebounced() {},
        saveMetadata() { context._metadataSaved = (context._metadataSaved ?? 0) + 1; },
        saveMetadataDebounced() {},
        setExtensionPrompt(key, value, position, depth, scan, role, filter) {
            context._injections = context._injections ?? [];
            context._injections.push({ key, value, position, depth, scan, role, filter });
        },
        /** 世界书：假装当前激活了这些条目。顺便记下调用参数，供测试检查。 */
        getWorldInfoPrompt(chat, maxContext, isDryRun, globalScanData) {
            context._wiArgs = { chat, maxContext, isDryRun, globalScanData };
            return Promise.resolve({
                worldInfoString: '【设定】这个世界的魔法必须咏唱，无咏唱是传说。',
                worldInfoBefore: '',
                worldInfoAfter: '',
                worldInfoDepth: [{ content: '【深度条目】王都的名字叫亚尔提。' }],
                worldInfoExamples: [],
            });
        },
        updateMessageBlock(index, message) {
            context._updated = { index, message };
        },
        renderExtensionTemplateAsync(name, template, data) {
            context._template = { name, template, data };
            return '<div id="anko_panel"></div>';
        },
        registerDebugFunction(id, name, description, fn) {
            debugFunctions.set(id, { name, description, fn });
        },
        generateRaw(request) {
            scenario.calls.push({ ...request });
            if (scenario.fail) {
                return Promise.reject(new Error('模拟的 API 故障'));
            }
            const index = scenario.calls.length - 1;
            return Promise.resolve(index < scenario.script.length ? scenario.script[index] : '');
        },
        loader: {
            show(options) {
                context._loader = options;
                return { hide: async () => { context._loaderHidden = true; } };
            },
        },
        SlashCommandParser: {
            addCommandObject(command) {
                if (registeredCommands.has(command.name)) {
                    throw new Error(`Duplicate slash command: ${command.name}`);
                }
                registeredCommands.set(command.name, command);
            },
        },
        SlashCommand: { fromProps: (props) => props },
        SlashCommandArgument: { fromProps: (props) => props },
        ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean' },
        eventTypes: {
            APP_READY: 'app_ready',
            CHAT_CHANGED: 'chat_id_changed',
            MESSAGE_SENT: 'MESSAGE_SENT',
            MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
            GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
        },
        eventSource: {
            on(type, handler) {
                const list = eventHandlers.get(type) ?? [];
                list.push(handler);
                eventHandlers.set(type, list);
            },
            removeListener(type, handler) {
                const list = eventHandlers.get(type) ?? [];
                eventHandlers.set(type, list.filter((item) => item !== handler));
            },
            /** 真酒馆会 await 监听器，所以这里也 await —— 这正是自动推演正确性的关键 */
            async emit(type, ...args) {
                for (const handler of eventHandlers.get(type) ?? []) {
                    await handler(...args);
                }
            },
        },
    };
    return context;
}

let stub = makeStubContext();

globalThis.SillyTavern = { getContext: () => stub, libs: {} };
globalThis.$ = fakeJQuery;
globalThis.toastr = {
    info: (m, t) => loadedMessages.push(['info', t, m]),
    success: (m, t) => loadedMessages.push(['success', t, m]),
    warning: (m, t) => loadedMessages.push(['warning', t, m]),
    error: (m, t) => loadedMessages.push(['error', t, m]),
};

/** 弹窗计数：断言"只弹一次"必须数次数，只记最后一次是抓不到重复的。 */
const popupCalls = [];
const fakePopup = (...args) => {
    popupCalls.push(args);
    stub._popup = args; // 兼容只看最后一次的老断言
    return Promise.resolve(1);
};
stub.callGenericPopup = fakePopup;
stub.POPUP_TYPE = { TEXT: 1 };

// 静音加载期的日志，别把测试输出淹了。
// 注意：**整个测试文件期间都保持静音**，因为后面有测试要断言警告内容。
const realLog = console.log;
const realError = console.error;
const realWarn = console.warn;
const muted = [];
console.log = (...a) => muted.push(['log', a]);
console.error = (...a) => muted.push(['error', a]);
console.warn = (...a) => muted.push(['warn', a]);

await import('../index.js');

const call = (name, args) => registeredCommands.get(name).callback({}, args);
const fire = (type, ...args) => stub.eventSource.emit(type, ...args);

/** 把每聊天状态清空（等价于换到一个空聊天）。 */
async function resetState() {
    stub.chatMetadata = {};
    await fire('chat_id_changed');
}

/** 面板上某个控件注册的 input 处理器。 */
const handlerOf = (selector, event = 'input') => nodeOf(selector).handlers[event];

/**
 * 点一次「推演本回合」并等它跑完。
 *
 * ⚠️ `index.js` 里按钮的处理器是 `() => void handleDirectorButton()` —— jQuery 不 await
 * 事件回调，所以直接 `await handler(...)` 会立刻返回，断言就跑在推演结束之前。
 * 推演结束时总会弹一条 toastr，这里就等那条。
 */
async function clickRun() {
    const before = loadedMessages.length;
    handlerOf('#anko_run', 'click')();
    for (let i = 0; i < 200; i += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        const fresh = loadedMessages.slice(before).filter(([kind]) => kind !== 'trigger');
        if (fresh.length > 0) {
            return;
        }
    }
    throw new Error('点了「推演本回合」但推演一直没结束');
}

// ---------------------------------------------------------------------------
// 注册与加载
// ---------------------------------------------------------------------------

// 【前置】挂面板：index.js 的控件绑定是在 APP_READY 里做的 ✓。
// ⚠️ 这原本靠某条测试顺带触发 ✗，我删那条测试时把这条公共前置一起删了 ✗ → 33 条连锁失败 ✓。
// 现在用 before 钩子显式保证 ✓，不再依赖"某条测试恰好先跑"✗。
before(async () => {
    await fire('app_ready');
});
test('所有斜杠命令都注册成功', () => {
    assert.deepEqual([...registeredCommands.keys()].sort(), [
        'anko', 'anko-attr', 'anko-bid', 'anko-check', 'anko-combat', 'anko-continue',
        'anko-debug', 'anko-die', 'anko-direct', 'anko-export', 'anko-float', 'anko-growth',
        'anko-import', 'anko-inline', 'anko-last', 'anko-log', 'anko-option', 'anko-prev',
        'anko-revive', 'anko-roll', 'anko-story', 'anko-table',
    ]);
});

test('加载期间没有报错', () => {
    const errors = muted.filter(([level]) => level === 'error');
    assert.deepEqual(errors, [], `加载时报错：${JSON.stringify(errors).slice(0, 600)}`);
});

test('注册了 Debug 函数', () => {
    assert.ok(debugFunctions.has('anko_dump'));
});

// ---------------------------------------------------------------------------
// 面板
// ---------------------------------------------------------------------------

test('APP_READY 之后面板会被渲染并挂到右栏', async () => {
    await fire('app_ready');
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(stub._template.name, 'third-party/st-anko-director');
    assert.equal(stub._template.template, 'settings');
    assert.equal(stub._template.data.maxRounds, 12);
    assert.ok(
        domAppends.some(([selector]) => selector === '#extensions_settings2'),
        '面板要挂到右栏 #extensions_settings2',
    );
});




test('推演时挂了 loader，结束后会收起来', async () => {
    resetScenario(['收尾。']);
    await call('anko-direct', '随便写点');
    assert.ok(stub._loader, '要显示加载遮罩');
    assert.match(stub._loader.message, /导演推演中/);
    assert.equal(stub._loaderHidden, true, '结束后要收起来');
});

test('★ 1.14.0 没有 action-loader 时回退到 showLoader/hideLoader', async () => {
    // 实测：SillyTavern 1.14.0 的 getContext() 只有已废弃的 showLoader/hideLoader，
    // 没有 loader。不回退的话多轮推演会"什么提示都没有"，看起来像卡死。
    const savedLoader = stub.loader;
    const calls = [];
    stub.loader = undefined;
    stub.showLoader = () => calls.push('show');
    stub.hideLoader = () => calls.push('hide');

    resetScenario(['收尾。']);
    try {
        await call('anko-direct', '试试');
    } finally {
        stub.loader = savedLoader;
        delete stub.showLoader;
        delete stub.hideLoader;
    }

    assert.deepEqual(calls, ['show', 'hide'], '要成对调用');
});

test('★ 停止按钮能真正中断推演，并保留已写好的部分', async () => {
    resetScenario(['走了1d3天', '第二段', '第三段']);

    const originalGenerate = stub.generateRaw;
    let count = 0;
    stub.generateRaw = (request) => {
        count += 1;
        if (count === 1) {
            // 第一轮生成期间玩家点了停止
            const stop = handlerOf('#anko_stop', 'click');
            assert.ok(stop, '停止按钮要绑 click 事件');
            stop();
        }
        return originalGenerate(request);
    };

    loadedMessages.length = 0;
    let outline = '';
    try {
        await call('anko-direct', '我去码头');
        outline = valueWrites.get('#send_textarea') ?? '';
    } finally {
        stub.generateRaw = originalGenerate;
    }

    assert.match(outline, /【1d3=\d】/, '第一轮定稿要保留下来');
    assert.ok(
        loadedMessages.some(([, , msg]) => String(msg).includes('被中断')),
        `要提示被中断，实际提示：${JSON.stringify(loadedMessages)}`,
    );
});

test('模型报错时不崩，返回半成品并提示', async () => {
    resetScenario([]);
    scenario.fail = true;
    const out = await call('anko-direct', '试试');
    assert.match(out, /推演没有产出内容|大纲已写进输入框/);
    assert.ok(muted.some(([level, args]) => level === 'warn' && JSON.stringify(args).includes('生成失败')));
});

test('输入框为空且没给参数时给用法提示', async () => {
    valueWrites.set('#send_textarea', '');
    assert.match(await call('anko-direct', ''), /用法：\/anko direct/);
});

test('/anko direct 走统一入口也能用', async () => {
    resetScenario(['没有骰子的一段。']);
    assert.match(await call('anko', 'direct 走一趟'), /大纲已写进输入框/);
});

test('生成的上下文简报里带上了属性与最近对话', async () => {
    resetScenario(['收尾。']);
    call('anko-attr', 'set 话术 40');
    stub.chat = [{ is_user: true, mes: '先前的对话', name: '玩家' }];
    await call('anko-direct', '继续');
    assert.match(scenario.calls[0].prompt, /话术 40/);
    assert.match(scenario.calls[0].prompt, /先前的对话/);
});

// ---------------------------------------------------------------------------
// 发送前自动推演
//
// ⚠️ 挂的是 MESSAGE_SENT，不是 GENERATION_AFTER_COMMANDS ——
// 用户消息是在 sendMessageAsUser 里才进 chat 的，而 GENERATION_AFTER_COMMANDS 发得更早
// （那时最后一条还是角色的上一句回复）。所以这里全按 MESSAGE_SENT 的实参来测。
// ---------------------------------------------------------------------------

test('★ autoDirector 打开后，发送时会用大纲替换用户消息', async () => {
    await resetState();
    resetScenario(['哦对了，路上1d3天', '收尾']);
    stub.extensionSettings.anko_director.autoDirector = true;
    stub.chat = [{ is_user: true, mes: '我去码头', name: '玩家' }];

    try {
        await fire('MESSAGE_SENT', 0);

        assert.match(stub.chat[0].mes, /【1d3=\d】/, '用户消息应被替换成大纲');
        assert.ok(stub._updated, '要重绘那条消息');
        assert.equal(stub._updated.index, 0);
    } finally {
        stub.extensionSettings.anko_director.autoDirector = false;
    }
});

test('★ 用消息下标定位那条消息（插在中间的也认）', async () => {
    await resetState();
    resetScenario(['走了1d3天', '收尾']);
    stub.extensionSettings.anko_director.autoDirector = true;
    stub.chat = [
        { is_user: false, mes: '角色的开场白' },
        { is_user: true, mes: '我去码头' },
        { is_user: false, mes: '角色的新回复' },
    ];

    try {
        // 消息在中间（插入式发送）—— 光看"最后一条"会认错
        await fire('MESSAGE_SENT', 1);
        assert.match(stub.chat[1].mes, /【1d3=\d】/, '应该改下标 1 那条');
        assert.equal(stub.chat[2].mes, '角色的新回复', '别的消息不能动');
    } finally {
        stub.extensionSettings.anko_director.autoDirector = false;
    }
});

test('非用户消息（比如系统消息）不触发', async () => {
    await resetState();
    resetScenario(['1d3', '收尾']);
    stub.extensionSettings.anko_director.autoDirector = true;
    stub.chat = [{ is_user: false, mes: '角色的上一句话', name: '旁白' }];

    try {
        await fire('MESSAGE_SENT', 0);
        assert.equal(stub.chat[0].mes, '角色的上一句话');
    } finally {
        stub.extensionSettings.anko_director.autoDirector = false;
    }
});

test('★ 发出去的本身就是一份大纲时，不重复推演', async () => {
    // 正常流程是「推演 → 发送 → 演员写正文」。这一步要是又被自动推演一遍，
    // 就会推出"大纲的大纲"。
    await resetState();
    resetScenario(['走了1d3天', '收尾']);
    await call('anko-direct', '我去码头');
    const outline = valueWrites.get('#send_textarea');
    assert.ok(outline);

    stub.extensionSettings.anko_director.autoDirector = true;
    stub.chat = [{ is_user: true, mes: outline, name: '玩家' }];
    resetScenario(['这份剧本根本不该被用上']);
    try {
        await fire('MESSAGE_SENT', 0);
        assert.equal(scenario.calls.length, 0, '不该再推演一遍');
        assert.equal(stub.chat[0].mes, outline, '消息不该被动过');
    } finally {
        stub.extensionSettings.anko_director.autoDirector = false;
    }
});

test('关掉自动推演就完全不触发', async () => {
    await resetState();
    stub.extensionSettings.anko_director.autoDirector = false;
    resetScenario(['1d3', '收尾']);
    stub.chat = [{ is_user: true, mes: '原始输入', name: '玩家' }];
    await fire('MESSAGE_SENT', 0);
    assert.equal(stub.chat[0].mes, '原始输入');
});

test('★ 自动推演失败时会报出来，不再静默什么都不做', async () => {
    // 之前 quiet:true 把失败提示也一起吞了 —— 用户勾了开关、它失败了、却什么都看不到
    const settings = stub.extensionSettings.anko_director;
    settings.autoDirector = true;
    const original = stub.generateRaw;
    try {
        stub.chat = [{ is_user: true, mes: '我去码头', name: '玩家' }];
        // 400 是永久失败，不会重试，测试跑得快
        stub.generateRaw = async () => { throw new Error('400 Bad Request: bad model'); };
        loadedMessages.length = 0;

        await fire('MESSAGE_SENT', 0);

        assert.ok(
            loadedMessages.some(([, , msg]) => /没有产出内容|半成品/.test(String(msg))),
            `失败必须报出来，实际提示：${JSON.stringify(loadedMessages)}`,
        );
        assert.equal(stub.chat[0].mes, '我去码头', '失败时不要动用户消息');
    } finally {
        stub.generateRaw = original;
        settings.autoDirector = false;
    }
});

test('/anko last 能看到最近一次推演发生了什么', async () => {
    resetScenario(['走了1d3天', '收尾']);
    await call('anko-direct', '我去码头');

    const out = call('anko', 'last');
    assert.match(out, /结束原因：done/);
    assert.match(out, /骰子：1 次/);
    assert.match(out, /逐轮记录/);
    assert.match(out, /第 2 轮/);
});

// ---------------------------------------------------------------------------
// 自动推演钩子的排障痕迹
// ---------------------------------------------------------------------------

test('★ /anko debug：没触发过就直说，不让人瞎猜', () => {
    const out = call('anko', 'debug');
    assert.match(out, /事件监听器：已挂（MESSAGE_SENT）/);
    assert.match(out, /MESSAGE_SENT 触发次数：\d+/);
    // 这个测试跑在别的自动推演测试之后，所以两种分支都可能出现
    assert.match(out, /(钩子从来没有被触发过|最近一次钩子触发)/);
});

test('★ /anko debug：被守卫挡掉时会写明是哪一条挡的', async () => {
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = settings.autoDirector;
    settings.autoDirector = false;
    try {
        stub.chat = [{ is_user: true, mes: '我去码头' }];
        await fire('MESSAGE_SENT', 0);
        const out = call('anko', 'debug');
        assert.match(out, /消息下标=0/, '要记下实参');
        assert.match(out, /当时开关=关/);
        assert.match(out, /判定：跳过：面板里的「发送前自动推演」没开/);
    } finally {
        settings.autoDirector = saved;
    }
});

test('★ /anko debug：不是用户消息时也写得清清楚楚', async () => {
    await resetState();
    stub.extensionSettings.anko_director.autoDirector = true;
    stub.chat = [{ is_user: false, mes: '角色的上一句话' }];
    try {
        await fire('MESSAGE_SENT', 0);
        const out = call('anko', 'debug');
        assert.match(out, /这条是用户消息=false/);
        assert.match(out, /判定：跳过：这条不是用户消息/);
    } finally {
        stub.extensionSettings.anko_director.autoDirector = false;
    }
});

test('★ /anko debug：跑成功时记下"已替换"', async () => {
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = settings.autoDirector;
    settings.autoDirector = true;
    try {
        resetScenario(['走了1d3天', '收尾。']);
        stub.chat = [{ is_user: true, mes: '我去码头' }];
        await fire('MESSAGE_SENT', 0);
        const out = call('anko', 'debug');
        assert.match(out, /当时开关=开/, '要如实记录当时的状态');
        assert.match(out, /判定：已替换用户消息/);
    } finally {
        settings.autoDirector = saved;
    }
});

test('★ 推演期间那条消息文本被别的扩展改过时，仍然替换（曾经的假阴性）', async () => {
    // 真机上踩到过：文本相等这个判据太严 —— 酒馆自己（宏替换/重载聊天）或别的扩展
    // 动一下文本，自动推演就会"跑完了却什么都不做"。判据改成"那个位置还是不是用户消息"。
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = settings.autoDirector;
    settings.autoDirector = true;
    const original = stub.generateRaw;
    try {
        resetScenario(['走了1d3天', '收尾。']);
        stub.chat = [{ is_user: true, mes: '我去码头' }];
        // 推演期间，别的扩展把这条消息的文本改了（模拟 ST 的宏替换 / 重载）
        stub.generateRaw = (request) => {
            stub.chat[0].mes = '我去码头  '; // 多两个空格就够了
            return original(request);
        };
        await fire('MESSAGE_SENT', 0);
        assert.match(stub.chat[0].mes, /【1d3=\d】/, '文本变了也要替换，不能放弃');
        assert.match(call('anko', 'debug'), /已替换用户消息/, '判定要记成"已替换"');
    } finally {
        stub.generateRaw = original;
        settings.autoDirector = saved;
    }
});

test('★ 推演期间那条消息被删掉时才放弃替换', async () => {
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = settings.autoDirector;
    settings.autoDirector = true;
    const original = stub.generateRaw;
    try {
        resetScenario(['走了1d3天', '收尾。']);
        stub.chat = [{ is_user: true, mes: '我去码头' }];
        stub.generateRaw = (request) => {
            // 那条用户消息被删了，位置上换成了角色的回复
            stub.chat[0] = { is_user: false, mes: '角色的回复' };
            return original(request);
        };
        await fire('MESSAGE_SENT', 0);
        assert.equal(stub.chat[0].mes, '角色的回复', '不该往别的消息上写');
        assert.match(call('anko', 'debug'), /被删掉了/);
    } finally {
        stub.generateRaw = original;
        settings.autoDirector = saved;
    }
});

test('★ 服务端拒绝（4xx）时，提示指向酒馆自己那条提示', async () => {
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = settings.autoDirector;
    settings.autoDirector = true;
    const original = stub.generateRaw;
    try {
        stub.chat = [{ is_user: true, mes: '我去码头' }];
        stub.generateRaw = async () => { throw new Error('Bad Request'); };
        loadedMessages.length = 0;
        await fire('MESSAGE_SENT', 0);
        const toasts = JSON.stringify(loadedMessages);
        assert.match(toasts, /Chat Completion API/, `提示里要指明去看酒馆那条，实际：${toasts}`);
    } finally {
        stub.generateRaw = original;
        settings.autoDirector = saved;
    }
});

test('★ 设置迁移：老存档里停在旧默认值上的轮数上限会被迁到新默认值', async () => {
    const module = await import('../index.js');

    // 老存档：版本 1、轮数上限还是旧默认 8 → 迁
    const old = { settingsVersion: 1, maxRounds: 8 };
    const applied = module.migrateSettings(old, 1);
    assert.equal(old.maxRounds, 12, '旧默认值该被迁走');
    assert.ok(applied.some((line) => /轮数上限/.test(line)), '要留下迁移记录');

    // 用户自己设过的值不碰
    const custom = { settingsVersion: 1, maxRounds: 5 };
    module.migrateSettings(custom, 1);
    assert.equal(custom.maxRounds, 5, '用户明确设的 5 不能被迁走');

    // 已经迁过的版本不再动
    const done = { settingsVersion: 2, maxRounds: 8 };
    assert.deepEqual(module.migrateSettings(done, 2), []);
    assert.equal(done.maxRounds, 8, '版本已是最新就不该再动');
});

test('★ 叙述人称：要有明确的规则，否则模型会照抄范例里的人称', async () => {
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = settings.narrationPerson;

    // 造一轮推演的请求，检查 prompt 里的人称段落
    const prompts = [];
    const original = stub.generateRaw;
    settings.autoDirector = false;
    try {
        stub.generateRaw = (request) => {
            prompts.push(String(request?.prompt ?? ''));
            return original(request);
        };
        resetScenario(['走了1d3天', '收尾。']);

        settings.narrationPerson = 'auto';
        await call('anko-direct', '我去码头');
        assert.match(prompts[0], /# 叙述人称/, 'prompt 里要有「叙述人称」这一段');
        assert.match(prompts[0], /沿用前情/, '默认是沿用前情');
        assert.match(prompts[0], /不要自己把人称固定成第二人称/, '要明确禁止固定成第二人称');

        prompts.length = 0;
        settings.narrationPerson = 'third';
        resetScenario(['走了1d3天', '收尾。']);
        await call('anko-direct', '我去码头');
        assert.match(prompts[0], /一律用\*\*名字\*\*（第三人称）/, '选了第三人称就要写进去');
    } finally {
        stub.generateRaw = original;
        settings.narrationPerson = saved;
    }
});

test('★ 世界书：开着就整份塞进导演的简报，而且是 dryRun（不动粘性/冷却）', async () => {
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = settings.worldInfoInBrief;
    const original = stub.generateRaw;
    const prompts = [];
    try {
        stub.generateRaw = (request) => {
            prompts.push(String(request?.prompt ?? ''));
            return original(request);
        };

        // 开：世界书要进去，深度条目也要（它不在 worldInfoString 里）
        settings.worldInfoInBrief = true;
        resetScenario(['走了1d3天', '收尾。']);
        await call('anko-direct', '我去码头');
        const brief = prompts[0];
        assert.match(brief, /# 世界书/, '简报里要有世界书那一段');
        assert.match(brief, /魔法必须咏唱/, 'worldInfoString 的内容要进去');
        assert.match(brief, /王都的名字叫亚尔提/, '深度条目要单独收进去');
        assert.equal(stub._wiArgs.isDryRun, true, '必须是 dryRun —— 否则推演 12 轮会把条目"用掉"');

        // ★ 传参必须和酒馆自己的调用一致（script.js:4233-4243），否则永远扫出 0 条：
        //   ① chat 必须是**字符串数组**（不是消息对象）
        //   ② 必须是**从新到旧**（reverse 过）
        //   ③ globalScanData 必须带上角色/场景
        const args = stub._wiArgs;
        assert.ok(Array.isArray(args.chat) && args.chat.every((x) => typeof x === 'string'),
            'chat 必须是字符串数组，不能传消息对象');
        // 不断言具体文字，而是断言"它确实是 chat 的倒序" —— 这才是 reverse 的含义
        const newest = stub.chat.at(-1);
        const expectedNewest = `${newest?.name ?? ''}: ${newest?.mes ?? ''}`;
        assert.equal(args.chat[0], expectedNewest, 'chat 必须是从新到旧（reverse 过）');
        assert.equal(args.chat.length, stub.chat.length, '条数要和 chat 一致');
        assert.equal(args.globalScanData?.trigger, 'normal', 'globalScanData 必须带上 trigger');
        assert.ok('characterDescription' in (args.globalScanData ?? {}), 'globalScanData 要带角色描述');
        assert.ok('scenario' in (args.globalScanData ?? {}), 'globalScanData 要带场景');
        assert.ok(Number.isFinite(args.maxContext) && args.maxContext > 0, 'maxContext 要是正数');

        // 关：一个字都不该有
        prompts.length = 0;
        settings.worldInfoInBrief = false;
        resetScenario(['走了1d3天', '收尾。']);
        await call('anko-direct', '我去码头');
        assert.ok(!prompts[0].includes('魔法必须咏唱'), '关掉之后不该出现世界书内容');
    } finally {
        stub.generateRaw = original;
        settings.worldInfoInBrief = saved;
    }
});

test('★ 导演可以走指定的连接配置（走酒馆预设），失败时退回当前设置', async () => {
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = settings.directorProfile;
    const original = stub.generateRaw;
    const calls = [];
    try {
        stub.generateRaw = (request) => {
            calls.push(request);
            return original(request);
        };

        // ① 没设配置 → 走 generateRaw（现状）
        settings.directorProfile = '';
        resetScenario(['走了1d3天', '收尾。']);
        await call('anko-direct', '我去码头');
        assert.ok(calls.length > 0, '默认路径要用 generateRaw');

        // ② 设了一个拿不到的配置 → 动态 import 会失败 → 要**退回 generateRaw** 而不是整个推演挂掉
        calls.length = 0;
        valueWrites.delete('#send_textarea');
        settings.directorProfile = '不存在的配置';
        resetScenario(['走了1d3天', '收尾。']);
        await call('anko-direct', '我去码头');
        assert.ok(calls.length > 0, '拿不到配置时要退回 generateRaw');
        assert.match(valueWrites.get('#send_textarea') ?? '', /【1d3=\d】/, '退回之后仍然要能产出大纲');
    } finally {
        stub.generateRaw = original;
        settings.directorProfile = saved;
    }
});

test('★ 内置 API：开了就直连，不再走酒馆的 generateRaw', async () => {
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = {
        on: settings.useBuiltinApi,
        key: settings.builtinApiKey,
        model: settings.builtinApiModel,
        kind: settings.builtinApiKind,
        profile: settings.directorProfile,
    };
    const originalFetch = globalThis.fetch;
    const originalRaw = stub.generateRaw;
    const calls = [];
    let rawCalls = 0;
    try {
        settings.useBuiltinApi = true;
        settings.builtinApiKind = 'openai';
        settings.builtinApiKey = 'sk-test';
        settings.builtinApiModel = 'test-model';
        settings.directorProfile = '不该被用到';
        stub.generateRaw = (request) => {
            rawCalls += 1;
            return originalRaw(request);
        };
        globalThis.fetch = async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
            const text = calls.length === 1 ? '走了1d3天' : '收尾。';
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                text: async () => JSON.stringify({ choices: [{ message: { content: text } }] }),
            };
        };

        valueWrites.delete('#send_textarea');
        await call('anko-direct', '我去码头');

        assert.ok(calls.length >= 1, '要真的发出直连请求');
        assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions', '留空地址要用官方默认');
        assert.equal(calls[0].headers.Authorization, 'Bearer sk-test');
        assert.equal(calls[0].body.model, 'test-model');
        assert.equal(rawCalls, 0, '开了内置 API 就不该再走酒馆（也不该用连接配置）');
        assert.match(valueWrites.get('#send_textarea') ?? '', /【1d3=\d】/, '大纲要用直连返回的内容拼出来');
    } finally {
        globalThis.fetch = originalFetch;
        stub.generateRaw = originalRaw;
        settings.useBuiltinApi = saved.on;
        settings.builtinApiKey = saved.key;
        settings.builtinApiModel = saved.model;
        settings.builtinApiKind = saved.kind;
        settings.directorProfile = saved.profile;
    }
});

test('★ 收工时「进度」行要改掉：不能停在「生成中…」', async () => {
    // 用户报过"进度没跑满就结束了"——根因是跑完之后**没更新那一行**，
    // 它永远停在最后一句"第 N/M 轮：生成中…"，看起来像没跑完。
    await resetState();
    resetScenario(['走了1d3天', '收尾。']);
    await call('anko-direct', '我去码头');
    const progress = fakeJQuery('#anko_progress').text();

    assert.ok(!progress.includes('生成中'), `收工后不该还写着"生成中"，实际：${progress}`);
    assert.match(progress, /这一回合演完了|到轮数上限收尾|出错停下|卡住了|已停止/, '要说清是怎么结束的');
    assert.match(progress, /推演 \d+ 轮/, '要写清推了几轮');
});

test('★ 不带参数的 /anko option 要用默认项数（不能因为删了 optionCount 就炸）', async () => {
    // 这条测试的由来：我把假旋钮 optionCount 删掉、改用一个常量之后，
    // 常量忘了定义 —— 而当时**没有任何测试跑过不带参数的 /anko option**，所以全绿。
    await resetState();
    const out = call('anko', 'option');
    assert.match(out, /选项骰 10 项/, `实际：${out}`);
    assert.ok(!/is not defined/.test(out), '不该抛未定义变量的错');
});

test('★ 格式约束要用当前的标记符号现拼（改成 ★ 后不能再要求保留 ♛）', async () => {
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = settings.hitMark;
    try {
        settings.hitMark = '★';
        await fire('chat_id_changed');
        const lock = lastFormatLock();
        assert.match(lock.value, /★/, '要按当前符号写');
        assert.ok(!lock.value.includes('♛'), '不该再要求保留一个不存在的 ♛');

        settings.hitMark = '';
        await fire('chat_id_changed');
        assert.match(lastFormatLock().value, /不要自己加/, '留空（关掉打标）时要说清不会打标');
    } finally {
        settings.hitMark = saved;
        await fire('chat_id_changed');
    }
});

test('★ 导出不能带明文 API Key（文件是拿去备份/分享的）', async () => {
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = settings.builtinApiKey;
    try {
        settings.builtinApiKey = 'sk-secret-should-not-leak';
        muted.length = 0; // Node 里导不出来 → 会走"把 JSON 打到控制台"这条路
        call('anko', 'export all');
        const dumped = muted.map((item) => item[1].map(String).join(' ')).join('\n');
        assert.ok(!dumped.includes('sk-secret-should-not-leak'), '导出内容里绝不能出现密钥');
        assert.match(dumped, /hitMark/, '其它设置还是要导出去（否则就是把导出整个弄坏了）');
    } finally {
        settings.builtinApiKey = saved;
    }
});

test('★ 推演中途切聊天：骰子不能写进新聊天的日志', async () => {
    await resetState();
    const original = stub.generateRaw;
    stub.chat = [{ is_user: true, mes: '我去码头' }];
    try {
        resetScenario(['走了1d3天', '收尾。']);
        let switched = false;
        stub.generateRaw = async (request) => {
            const out = await original(request);
            if (!switched) {
                switched = true;
                await fire('chat_id_changed'); // 推演中途切走
            }
            return out;
        };
        await call('anko-direct', '我去码头');

        // 切走之后：新聊天的骰点日志必须是空的（以前这里会被塞进旧聊天的骰子并落盘）
        assert.match(call('anko', 'log'), /还没有投过骰子|共 0 条/,
            `新聊天的日志该是空的，实际：${call('anko', 'log')}`);
    } finally {
        stub.generateRaw = original;
    }
});

test('★ 面板的「结算正文 AI 写的骰子」要能回填初值（以前刷新后勾会消失）', async () => {
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = settings.resolveAiDice;
    try {
        settings.resolveAiDice = false;
        // 导入设置会走一遍 syncPanelFromSettings —— 顺便验证回填
        const payload = JSON.stringify({
            kind: 'anko-director-export',
            version: 1,
            settings: { resolveAiDice: true },
        });
        assert.match(String(await call('anko', `import ${payload}`)), /已导入/);
        assert.equal(fakeJQuery('#anko_resolve_ai').prop('checked'), true,
            '导入/刷新之后复选框要反映真实设置，否则用户再点一下反而把它关掉');
    } finally {
        settings.resolveAiDice = saved;
    }
});

test('★ 导出要带上战斗状态与前情（换设备不能丢）', async () => {
    await resetState();
    // 造一份带 combat + recentOutlines 的导入文件，验证导入侧真会回填
    const payload = JSON.stringify({
        kind: 'anko-director-export',
        version: 1,
        state: {
            attributes: { 话术: 40 },
            customTables: {},
            bid: { title: '', options: [] },
            combat: {
                round: 2, maxRounds: 5, finished: false, result: null,
                self: { name: '我', hp: 12, maxHp: 20, atk: 50, def: 10, initMod: 0 },
                enemy: { name: '敌', hp: 7, maxHp: 18, atk: 45, def: 8, initMod: 0 },
                initiative: { self: 12, enemy: 9, selfRoll: 12, enemyRoll: 9, order: ['self', 'enemy'] },
                log: [],
            },
            recentOutlines: ['第一幕：我走进酒馆。'],
        },
    });
    assert.match(String(await call('anko', `import ${payload}`)), /已导入/);
    assert.match(String(call('anko', 'combat status')), /第 2\/5 轮|我/, '战斗中途状态要回来');
    assert.match(String(call('anko', 'story')), /第一幕/, '前情要回来');
});

test('★ 改属性之后，注入主提示词的状态文本要跟着更新', async () => {
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = settings.injectTemplate;
    try {
        settings.injectTemplate = '当前属性 {{attrs}}';
        call('anko', 'attr set 话术 40');
        const injected = (stub._injections ?? []).filter((i) => i.key === 'anko_director_state_note').at(-1);
        assert.match(String(injected?.value ?? ''), /话术 40/,
            `注入要反映刚改过的属性（以前要切一次聊天才更新），实际：${injected?.value}`);
    } finally {
        settings.injectTemplate = saved;
    }
});

test('★ 8 条命令的「注册名」这条路径也要能跑通（以前只从 /anko 子命令间接覆盖）', async () => {
    // 两条入口共用同一个函数对象，风险不高，但注册名那条路径（含 rawArgs 对引号的拆包）
    // 实际从没被验证过。这里至少保证"按注册名调用不会炸、返回非空"。
    await resetState();
    const names = ['anko-export', 'anko-import', 'anko-float', 'anko-last',
        'anko-story', 'anko-debug', 'anko-prev', 'anko-revive'];
    for (const name of names) {
        const out = await call(name, '');
        assert.ok(typeof out === 'string' && out.length > 0, `/${name} 该有输出，实际：${out}`);
        assert.ok(!/is not defined|不是函数/.test(out), `/${name} 不该抛错：${out}`);
    }
    // ⚠️ 收尾：/anko-float 会把浮窗**留在打开状态**，会污染后面的浮窗测试
    // （就像之前 hitMark 泄漏那样 —— 测试之间改全局状态必须还原）
    if (stub.extensionSettings.anko_director.panelFloat) {
        await call('anko-float', '');
    }
    assert.equal(stub.extensionSettings.anko_director.panelFloat, false, '要把浮窗关回去');
});

test('★ 帮助文本要覆盖全部子命令（含以前漏掉的 table del / help 自己）', async () => {
    await resetState();
    const help = String(await call('anko', 'help'));
    for (const needle of ['table del', 'anko help', '别名', '/anko export', '/anko prev', '/anko debug']) {
        assert.ok(help.includes(needle), `帮助里该有「${needle}」`);
    }
});

test('★ 导演自己的 API 来源：走酒馆服务端代理（不直连、不自己传密钥/地址）', async () => {
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = { src: settings.directorApiSource, model: settings.directorApiModel };
    const originalRaw = stub.generateRaw;
    const originalService = stub.ChatCompletionService;
    const calls = [];
    let rawCalls = 0;
    try {
        stub.ChatCompletionService = {
            processRequest: async (payload) => {
                calls.push(payload);
                return { content: calls.length === 1 ? '走了1d3天' : '收尾。' };
            },
        };
        settings.directorApiSource = 'deepseek';
        settings.directorApiModel = 'deepseek-chat';
        stub.generateRaw = (r) => { rawCalls += 1; return originalRaw(r); };

        valueWrites.delete('#send_textarea');
        await call('anko-direct', '我去码头');

        assert.ok(calls.length > 0, '要走 ChatCompletionService.processRequest');
        assert.equal(calls[0].chat_completion_source, 'deepseek', '来源要带对');
        assert.equal(calls[0].model, 'deepseek-chat');
        assert.ok(!('api_key' in calls[0]), '不该自己传密钥 —— 用酒馆 secrets 里的');
        assert.ok(!('custom_url' in calls[0]), '不该自己传地址 —— 自定义来源用酒馆里配的');
        assert.equal(rawCalls, 0, '成功时不该退回 generateRaw');
        assert.match(valueWrites.get('#send_textarea') ?? '', /【1d3=\d】/, '大纲要用它的返回内容拼出来');
    } finally {
        stub.ChatCompletionService = originalService;
        stub.generateRaw = originalRaw;
        settings.directorApiSource = saved.src;
        settings.directorApiModel = saved.model;
    }
});

test('★ 面板的「测试这个来源」：会真的打一次，并在下面写出结果', async () => {
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = { src: settings.directorApiSource, model: settings.directorApiModel };
    const originalService = stub.ChatCompletionService;
    const calls = [];
    try {
        stub.ChatCompletionService = {
            processRequest: async (payload) => { calls.push(payload); return { content: '可以' }; },
        };
        settings.directorApiSource = 'deepseek';
        settings.directorApiModel = 'deepseek-chat';

        handlerOf('#anko_api_source_test', 'click')({ target: fakeJQuery('#anko_api_source_test') });
        await new Promise((resolve) => { setTimeout(resolve, 0); });

        assert.equal(calls.length, 1, '点一下要打一次');
        assert.equal(calls[0].chat_completion_source, 'deepseek');
        assert.equal(calls[0].model, 'deepseek-chat');
        assert.match(fakeJQuery('#anko_api_source_result').text(), /通/, '要把结果写出来');

        // 「同源换模型」= 用**正文当前的来源** + 导演自己填的模型 ✓
        // （以前这是"来源留空 + 填了模型"的隐式行为 ✗ —— 用户看不出区别，
        //   所以面板拆成了两个显式选项；哨兵值是 '__same__' ✓）
        fakeJQuery('#chat_completion_source').val('gemini');
        settings.directorApiSource = '__same__';
        settings.directorApiModel = 'gemini-2.5-flash';
        calls.length = 0;
        handlerOf('#anko_api_source_test', 'click')({ target: fakeJQuery('#anko_api_source_test') });
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        assert.equal(calls.length, 1, '「同源换模型」也该能测');
        assert.equal(calls[0].chat_completion_source, 'gemini', '要取正文当前的来源');
        assert.equal(calls[0].model, 'gemini-2.5-flash', '模型用导演自己填的');

        // 「跟随当前设置」+ 填了模型 → **不请求**，并明确告诉用户模型不生效 ✓
        settings.directorApiSource = '';
        settings.directorApiModel = 'gemini-2.5-flash';
        calls.length = 0;
        handlerOf('#anko_api_source_test', 'click')({ target: fakeJQuery('#anko_api_source_test') });
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        assert.equal(calls.length, 0, '跟随当前设置时不该拿面板模型去测');
        assert.match(fakeJQuery('#anko_api_source_result').text(), /不会生效|不生效/, '要说清模型不生效');

        // 只选了来源、没填模型 → 不请求（模型是必填的）
        settings.directorApiSource = 'deepseek';
        settings.directorApiModel = '';
        calls.length = 0;
        handlerOf('#anko_api_source_test', 'click')({ target: fakeJQuery('#anko_api_source_test') });
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        assert.equal(calls.length, 0, '没填模型不该打请求');
        assert.match(fakeJQuery('#anko_api_source_result').text(), /没填模型/);
    } finally {
        stub.ChatCompletionService = originalService;
        settings.directorApiSource = saved.src;
        settings.directorApiModel = saved.model;
    }
});
test('★ 选了来源但没填模型 → 直接退回当前设置（模型是必填的）', async () => {
    // 这条测试的由来：我一度在面板上写「留空 = 用该来源当前选中的模型」—— 那是假的。
    // `chat_completion_source` 只决定服务商，模型是另一个字段，传空只会让请求失败。
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = { src: settings.directorApiSource, model: settings.directorApiModel };
    const originalService = stub.ChatCompletionService;
    const calls = [];
    try {
        stub.ChatCompletionService = {
            processRequest: async (payload) => { calls.push(payload); return { content: '不该走到这里' }; },
        };
        settings.directorApiSource = 'deepseek';
        settings.directorApiModel = ''; // ← 没填
        resetScenario(['走了1d3天', '收尾。']);
        valueWrites.delete('#send_textarea');
        await call('anko-direct', '我去码头');

        assert.equal(calls.length, 0, '模型没填就不该发请求');
        assert.match(valueWrites.get('#send_textarea') ?? '', /【1d3=\d】/, '要退回当前设置并照常产出');
    } finally {
        stub.ChatCompletionService = originalService;
        settings.directorApiSource = saved.src;
        settings.directorApiModel = saved.model;
    }
});
test('★ 导演自己的 API 来源失败 → 退回当前设置并告警', async () => {
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = settings.directorApiSource;
    const originalService = stub.ChatCompletionService;
    try {
        stub.ChatCompletionService = {
            processRequest: async () => { throw new Error('来源挂了'); },
        };
        settings.directorApiSource = 'openai';
        resetScenario(['走了1d3天', '收尾。']); // ← 假模型的脚本要用完就换，忘了这步会没有骰子
        valueWrites.delete('#send_textarea');
        await call('anko-direct', '我去码头');
        assert.match(valueWrites.get('#send_textarea') ?? '', /【1d3=\d】/,
            '退回之后仍然要能产出大纲');
    } finally {
        stub.ChatCompletionService = originalService;
        settings.directorApiSource = saved;
    }
});

test('★★ 正文空 + 有思考 → 自动降思考重试一次，并用重试的结果', async () => {
    // 这条测试是**欠账补的**：重试分支当时一行测试都没有 ✗，
    // 结果里面 `const data` 被赋值，运行时崩 `Assignment to constant variable` ✓
    // —— 有这条测试就能拦住它 ✓。
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = { src: settings.directorApiSource, model: settings.directorApiModel, rounds: settings.maxRounds };
    const originalService = stub.ChatCompletionService;
    const calls = [];
    try {
        stub.chat = [{ is_user: true, mes: '我去码头' }];
        // 轮数上限设成 1：否则重试之后导演还会继续跑满 12 轮（实测请求 13 次 ✗），
        // 掩盖掉"重试恰好一次"这个要断言的点 ✓
        settings.maxRounds = 1;
        stub.ChatCompletionService = {
            processRequest: async (payload) => {
                calls.push(payload);
                // 第一次：只有思考、没有正文（实测就是这个形状）
                if (calls.length === 1) {
                    return { content: '', reasoning: '**计划**\n\n我打算先写一段大纲…' };
                }
                return { content: '走了1d3天', reasoning: '' };
            },
        };
        settings.directorApiSource = 'custom';
        settings.directorApiModel = 'google/gemini-4-argon';
        valueWrites.delete('#send_textarea');

        await call('anko-direct', '我去码头');

        assert.equal(calls.length, 2, `空正文后应当重试恰好一次，实际请求 ${calls.length} 次`);
        // 重试那次必须带上两条修法：降思考（custom 走 YAML 字符串）+ 显式额度
        assert.match(String(calls[1].custom_include_body ?? ''), /reasoning_effort/,
            '重试要带降思考参数（custom 来源只能从 custom_include_body 进）');
        assert.ok(Number(calls[1].max_tokens) > 0,
            `重试要显式给额度（思考与正文共用它），实际 ${calls[1].max_tokens}`);
        // 注意：重试那次返回的 '走了1d3天' 里带骰子 → 插件会**就地结算**成 【1d3=N】，
        // 所以输入框里是结算后的形态（这也是"骰子真的投了"的旁证 ✓）
        assert.match(valueWrites.get('#send_textarea') ?? '', /走了【1d3=\d】天/,
            '要用重试那次的正文，并且骰子被真投过');
    } finally {
        stub.ChatCompletionService = originalService;
        settings.directorApiSource = saved.src;
        settings.directorApiModel = saved.model;
        settings.maxRounds = saved.rounds;
    }
});

test('★★ 两次都只有思考 → 报第一因（带诊断），且**不退回 generateRaw**', async () => {
    // 为什么断言"不退回"：退回 generateRaw 对同一个响应会再抛 `No message generated`
    //（`script.js:3754-3755`），那只是**掩盖真因**的第二错误 ✓（读者核实过）
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = { src: settings.directorApiSource, model: settings.directorApiModel };
    const originalService = stub.ChatCompletionService;
    const originalRaw = stub.generateRaw;
    const calls = [];
    let rawCalls = 0;
    try {
        stub.chat = [{ is_user: true, mes: '我去码头' }];
        stub.ChatCompletionService = {
            processRequest: async (payload) => {
                calls.push(payload);
                return { content: '', reasoning: '只有思考，没有正文' };
            },
        };
        stub.generateRaw = (request) => { rawCalls += 1; return originalRaw(request); };
        settings.directorApiSource = 'custom';
        settings.directorApiModel = 'google/gemini-4-argon';
        muted.length = 0;

        await call('anko-direct', '我去码头');

        assert.equal(calls.length, 2, '重试一次就够，不该反复打');
        assert.equal(rawCalls, 0, '不该退回 generateRaw（只会抛出掩盖真因的第二错误）');
        const logged = muted.map((item) => item[1].map(String).join(' ')).join('\n');
        assert.match(logged, /content 长度/, '报错必须带诊断（content/reasoning 长度、finish_reason）');
        assert.match(logged, /没有产出正文|没拿到正文/, '要说清"没拿到正文"');
    } finally {
        stub.ChatCompletionService = originalService;
        stub.generateRaw = originalRaw;
        settings.directorApiSource = saved.src;
        settings.directorApiModel = saved.model;
    }
});

test('★ 命令的输出必须自己显示出来（酒馆不会显示斜杠命令的返回值）', async () => {
    // 根因：processCommands() 拿到返回值就 `return true`（script.js:2877），
    // executeSlashCommandsOnChatInput() 也只是 `return result`（slash-commands.js:5452），
    // 只有抛错才 toastr。所以命令必须自己把输出显示出来。
    await resetState();
    loadedMessages.length = 0;

    // 短输出 → toastr
    call('anko', 'attr set 话术 40');
    const toasts = loadedMessages.map((item) => JSON.stringify(item)).join(' ');
    assert.match(toasts, /话术/, `短输出要 toastr，实际：${toasts}`);

    // 长输出（多行）→ 弹窗
    popupCalls.length = 0;
    call('anko', 'debug');
    assert.ok(popupCalls.length > 0, '长输出要弹窗');
    assert.match(String(popupCalls.at(-1)[0]), /构建标记/, '弹窗里要有真实内容');
    assert.equal(popupCalls.at(-1)[2], '安科导游');
});

test('★★ /anko <子命令> 的输出只能显示一次（guard 嵌套会弹两遍）', async () => {
    // 根因：cmdAnko 自己也是 guard 包过的，它转发给的子命令**同样是 guard 包过的**，
    // 两边都显示 → 每个 /anko xxx 都弹两遍（长输出就是两个要关两次的弹窗）。
    // 修法：guard 只管错误处理，显示由注册时的 displayed() 包一层。
    //
    // ⚠️ 这条测试必须**数次数**：以前写的是 `stub._popup = args`（每次覆盖），
    // 所以重复弹窗永远不会被发现。
    await resetState();

    // ① 短的（toastr 路径）：用 /anko log（空日志只有一行）数 info 次数
    loadedMessages.length = 0;
    call('anko', 'attr set 话术 40');
    const infos = loadedMessages.filter((item) => item[0] === 'info');
    assert.equal(infos.length, 1, `/anko attr set 只该弹一条 toastr，实际 ${infos.length}`);

    // ② 长的（弹窗路径）：/anko debug
    popupCalls.length = 0;
    call('anko', 'debug');
    assert.equal(popupCalls.length, 1, `/anko debug 只该弹一个窗，实际 ${popupCalls.length}`);

    // ③ 独立命令同样只显示一次
    popupCalls.length = 0;
    call('anko-debug', '');
    assert.equal(popupCalls.length, 1, `/anko-debug 只该弹一个窗，实际 ${popupCalls.length}`);
});

test('★ 面板「状态」一行：命令注册 / 钩子 / 开关 / 触发次数全摊开', () => {
    // 存在的理由：用户没法（也不该）去翻控制台。"命令打出来没反应"时，
    // 这一行能直接区分"命令没注册"和"命令跑了但没输出"。
    const status = fakeJQuery('#anko_status').text();
    assert.match(status, /命令 \d+\/\d+/, '要显示命令注册数');
    assert.match(status, /自动推演钩子已挂/, '要显示监听器状态');
    assert.match(status, /触发 \d+ 次/);
    assert.match(status, /开关：(开|关)/);

    const detail = fakeJQuery('#anko_status').prop('title');
    assert.match(detail, /命令注册：\d+\/\d+/);
    assert.match(detail, /事件监听器：已挂/);
    assert.match(detail, /MESSAGE_SENT 触发次数：\d+/);
});

test('★ 状态行有问题时会标红（免得像上次那样没人注意到）', async () => {
    // 一切正常时不该标红
    await fire('chat_id_changed');
    assert.equal(fakeJQuery('#anko_status').hasClass('anko-warn'), false, '正常时不该有警告样式');

    // 模拟"扩展被禁用"：1.14.0 不调 disable 钩子，这是唯一的信号
    stub.extensionSettings.disabledExtensions = ['third-party/st-anko-director'];
    try {
        await fire('chat_id_changed');
        assert.equal(fakeJQuery('#anko_status').hasClass('anko-warn'), true, '被禁用时要标红');
        // 被禁用之后也要安静下来（不再往别人的提示词里插东西）
        assert.equal(await lastFormatLock().filter(), false, '禁用后格式约束不该注入');
    } finally {
        stub.extensionSettings.disabledExtensions = [];
        await fire('chat_id_changed');
    }
    assert.equal(fakeJQuery('#anko_status').hasClass('anko-warn'), false, '恢复后不该标红');
});

test('★ 推演期间用户新打的字不会被擦掉', async () => {
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = settings.autoDirector;
    settings.autoDirector = true;
    const original = stub.generateRaw;
    try {
        resetScenario(['走了1d3天', '收尾。']);
        stub.chat = [{ is_user: true, mes: '我去码头' }];
        // 推演进行中，用户在输入框里打了下一句话
        stub.generateRaw = (request) => {
            valueWrites.set('#send_textarea', '我掏出短匕');
            return original(request);
        };
        await fire('MESSAGE_SENT', 0);
        assert.equal(valueWrites.get('#send_textarea'), '我掏出短匕', '不能把用户新打的内容清掉');
    } finally {
        stub.generateRaw = original;
        settings.autoDirector = saved;
    }
});

// ---------------------------------------------------------------------------
// 前情记忆：连续推演的命根子
// ---------------------------------------------------------------------------

test('★ 连续推演：第二次会把第一次的大纲当前情喂回去', async () => {
    // 这就是"再点一次也只推演第一楼"的根因：大纲只躺在输入框里，
    // 没发送的话聊天记录里没有这一回合，下一次推演完全不知道前面发生了什么。
    await resetState();
    stub.chat = [];

    resetScenario(['走了1d3天', '收尾。']);
    await call('anko-direct', '我去码头');
    const firstOutline = valueWrites.get('#send_textarea');
    assert.ok(firstOutline, '第一次要产出大纲');

    resetScenario(['继续走了1d2天', '收尾。']);
    await call('anko-direct', '我继续赶路');

    const brief = scenario.calls[0].prompt;
    assert.match(brief, /# 已经推演过的前情/, '第二次必须带上前情');
    assert.match(brief, /走了【1d3=\d】天/, '前情里要有第一次的内容');
    assert.match(brief, /不要重演、不要复述/);
});

test('★ 已经发送进聊天记录的那份不再重复喂（省 token、也免得模型复述）', async () => {
    await resetState();
    resetScenario(['走了1d3天', '收尾。']);
    await call('anko-direct', '我去码头');
    const outline = valueWrites.get('#send_textarea');

    // 把大纲"发送"进聊天记录
    stub.chat = [{ is_user: true, mes: outline, name: '玩家' }];

    resetScenario(['继续走', '收尾。']);
    await call('anko-direct', '我继续赶路');
    const brief = scenario.calls[0].prompt;
    assert.match(brief, /走了【1d3=\d】天/, '聊天记录里本来就有，正文里会看到');
    assert.ok(!brief.includes('# 已经推演过的前情'), '不该再单独喂一遍');
});

test('/anko story 能看和清空前情', async () => {
    await resetState();
    stub.chat = [];
    resetScenario(['走了1d3天', '收尾。']);
    await call('anko-direct', '我去码头');

    assert.match(call('anko', 'story'), /记着 1 份最近大纲/);
    assert.match(call('anko', 'story'), /最近大纲/);

    assert.match(call('anko', 'story clear'), /已清空前情/);
    assert.match(call('anko', 'story'), /没有前情记忆/);
});

test('★ 按钮只推演输入框里那句话：空着就提示，绝不偷偷续推', async () => {
    await resetState();
    stub.chat = [];

    // 空输入框 + 有前情 —— 以前这里会"自动续推一幕"，那让按钮的含义取决于隐藏状态
    resetScenario(['走了1d3天', '收尾。']);
    await call('anko-direct', '我去码头');
    valueWrites.set('#send_textarea', '');

    resetScenario(['不该被调用']);
    loadedMessages.length = 0;
    await clickRun();
    assert.equal(scenario.calls.length, 0, '空输入框不该发起推演');
    assert.ok(
        loadedMessages.some(([, , msg]) => /输入框是空的/.test(String(msg))),
        `该提示先写一句，实际：${JSON.stringify(loadedMessages.slice(-2))}`,
    );
});

test('★ 输入框里还是上一次的大纲时，按钮拒绝推演并说清楚原因', async () => {
    await resetState();
    stub.chat = [];

    resetScenario(['第一幕走了1d3天', '收尾。']);
    await call('anko-direct', '我去码头');
    const outline = valueWrites.get('#send_textarea');
    assert.ok(outline);

    // 输入框保持那份大纲不动，再点按钮
    resetScenario(['不该被调用第二幕']);
    loadedMessages.length = 0;
    await clickRun();

    assert.equal(scenario.calls.length, 0, '不能把上一份大纲当成玩家输入再推一遍');
    assert.ok(
        loadedMessages.some(([, , msg]) => /上一次的大纲/.test(String(msg))),
        `该提示原因，实际：${JSON.stringify(loadedMessages.slice(-2))}`,
    );
    assert.equal(valueWrites.get('#send_textarea'), outline, '大纲不该被动过');
});

test('★ /anko continue：不写输入，明确地往下推一幕', async () => {
    await resetState();
    stub.chat = [];

    resetScenario(['第一幕走了1d3天', '收尾。']);
    await call('anko-direct', '我去码头');

    resetScenario(['第二幕又走了1d2天', '收尾。']);
    const out = await call('anko', 'continue');
    assert.match(out, /已接着往下推一幕/);
    assert.match(valueWrites.get('#send_textarea'), /第二幕/);
    const lastCall = scenario.calls.at(-1);
    assert.match(String(lastCall.prompt), /玩家没有给新的行动/, '空输入要有明确的推进指令');
    assert.match(String(lastCall.prompt), /# 已经推演过的前情/);
});

test('/anko continue 在没有前情时会拒绝', async () => {
    await resetState();
    stub.chat = [];
    assert.match(call('anko', 'continue'), /还没有可以接着推的剧情/);
});

// ---------------------------------------------------------------------------
// 撤回上一幕 / 正文骰子结算 / 保底警告
// ---------------------------------------------------------------------------

test('★ 撤回上一幕：退回一版大纲，并把前一版放回输入框', async () => {
    await resetState();
    stub.chat = [];
    resetScenario(['第一幕走了1d3天', '收尾。']);
    await call('anko-direct', '我去码头');
    resetScenario(['第二幕又走了1d2天', '收尾。']);
    await call('anko-continue', '');

    const out = call('anko', 'prev');
    assert.match(out, /已撤回上一幕/);
    assert.match(out, /前一版大纲已放回输入框/);
    assert.match(valueWrites.get('#send_textarea'), /第一幕/, '该把前一版放回输入框');
    assert.match(call('anko', 'story'), /记着 1 份最近大纲/);
});

test('前情空的时候撤回会说明原因，不炸', async () => {
    await resetState();
    stub.chat = [];
    assert.match(call('anko', 'prev'), /还没有大纲可撤回/);
});

test('★ 保底：认不出选项表时会留下警告（不再默默少一个 ♛）', async () => {
    // 表格写成一行 → 逐行解析认不出来
    const oneLineTable = '选项骰十项：1-3 甲 4-6 乙 7-9 丙 10 【1D2】大成功/大失败\n→ 1d10【选项】';
    resetScenario([oneLineTable, '收尾。']);
    await call('anko-direct', '我去码头');
    const out = call('anko', 'last');
    assert.match(out, /没能认出命中行/, '要明确告诉用户哪张表没认出来');
});

test('★ 保底：定稿里还剩解析不过去的骰子片段也会写进警告', async () => {
    resetScenario(['水路走了3d6k9天，然后1d100【话术40】', '收尾。']);
    await call('anko-direct', '我去码头');
    const out = call('anko', 'last');
    assert.match(out, /定稿里还有 1 处无法解析的骰子片段/);
    assert.match(out, /3d6k9/);
});

test('★ 结算正文骰子：默认关，打开后才会动 AI 的消息', async () => {    await resetState();
    const settings = stub.extensionSettings.anko_director;

    // 默认关：什么都不做
    settings.resolveAiDice = false;
    stub.chat = [{ is_user: false, mes: '他试探了一下 → 1d100【话术40】' }];
    await fire('MESSAGE_RECEIVED', 0, 'normal');
    assert.match(stub.chat[0].mes, /1d100【话术40】/, '关着的时候不该动它');

    // 打开：结算
    settings.resolveAiDice = true;
    try {
        await fire('MESSAGE_RECEIVED', 0, 'normal');
        assert.match(stub.chat[0].mes, /【1d100=\d+ \/ 话术40 → \S+】/, '要投掉');
        assert.ok(stub._updated, '要重绘');
    } finally {
        settings.resolveAiDice = false;
    }
});

test('结算正文骰子：用户消息 / 系统消息 / quiet 生成都不碰', async () => {
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    settings.resolveAiDice = true;
    try {
        stub.chat = [{ is_user: true, mes: '我说了1d100' }];
        await fire('MESSAGE_RECEIVED', 0, 'normal');
        assert.match(stub.chat[0].mes, /1d100/, '用户消息不碰');

        stub.chat = [{ is_user: false, is_system: true, mes: '系统说1d100' }];
        await fire('MESSAGE_RECEIVED', 0, 'normal');
        assert.match(stub.chat[0].mes, /1d100/, '系统消息不碰');

        stub.chat = [{ is_user: false, mes: '后台总结1d100' }];
        await fire('MESSAGE_RECEIVED', 0, 'quiet');
        assert.match(stub.chat[0].mes, /1d100/, 'quiet 生成不碰');
    } finally {
        settings.resolveAiDice = false;
    }
});

// ---------------------------------------------------------------------------
// 常驻浮窗 / 导入导出
// ---------------------------------------------------------------------------

test('★ 常驻浮窗：把面板搬出去，再点一次搬回来', async () => {
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    settings.panelFloat = false;
    nodeOf('#anko_panel').appendedTo = undefined;

    // 打开
    assert.match(call('anko', 'float'), /常驻浮窗/);
    assert.equal(settings.panelFloat, true, '状态要记住');
    assert.equal(nodeOf('#anko_panel').appendedTo, '#anko_float_body', '面板要搬进浮窗');
    assert.equal(nodeOf('#anko_float').visible, true, '浮窗要显示');

    // 再点一次 → 收回
    assert.match(call('anko', 'float'), /收回/);
    assert.equal(settings.panelFloat, false);
    assert.equal(nodeOf('#anko_panel').appendedTo, '#extensions_settings2', '面板要搬回侧栏');
    assert.equal(nodeOf('#anko_float').visible, false, '浮窗要藏起来');
});

test('★ 浮窗位置会被记住（拖动后写进设置）', async () => {
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    settings.panelFloat = false;
    settings.floatPos = { left: 123, top: 45 };
    try {
        // 打开浮窗时要按记住的位置摆（拖动结束会把它写回设置）
        call('anko', 'float');
        assert.equal(nodeOf('#anko_float').css.left, '123px', '要按记住的位置摆');
        assert.equal(nodeOf('#anko_float').css.top, '45px');
    } finally {
        settings.panelFloat = false;
        settings.floatPos = null;
        call('anko', 'float'); // 收回，别影响后面的测试
        call('anko', 'float');
    }
});

test('★ 导出：组装出属性与预设，并带 kind 标记', async () => {
    await resetState();
    call('anko-attr', 'set 话术 40');
    call('anko-table', 'add 试验表 甲|乙');
    call('anko', 'bid add 选项一');

    // Node 里没有 DOM，会走"打到控制台"那条路 —— 正好可以断言它没静默失败
    const out = call('anko', 'export attrs');
    assert.match(out, /不能下载文件|已导出/, `实际：${out}`);
});

test('★ 导入：只认本插件导出的 JSON，坏数据不会写进状态', async () => {
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    // 这条测试会改 hitMark —— 必须存下来恢复，否则会漏给后面测试
    // （写这条时真漏过一次：后面数 ♛ 的测试全挂了）
    const savedMark = settings.hitMark;
    call('anko-attr', 'set 话术 40');

    try {
        // 不是合法 JSON
        assert.match(call('anko', 'import 这不是 json'), /不是合法 JSON/);
        // 是 JSON 但不是我们导出的
        assert.match(call('anko', 'import {"kind":"别的插件"}'), /不是本插件导出的文件/);

        // 正确的导入：属性被覆盖
        const payload = JSON.stringify({
            kind: 'anko-director-export',
            version: 1,
            state: { attributes: { 话术: 77, 敏捷: 55 }, customTables: {}, bid: { title: '', options: [] } },
            settings: { hitMark: '★' },
        });
        const out = call('anko', `import ${payload}`);
        assert.match(out, /已导入/);
        assert.match(call('anko-attr', 'show'), /话术 77/);
        assert.equal(settings.hitMark, '★', '预设也要生效');
    } finally {
        settings.hitMark = savedMark;
    }
});

test('导入：类型不对的设置项会被跳过（不让脏数据进设置）', async () => {
    await resetState();
    const payload = JSON.stringify({
        kind: 'anko-director-export',
        version: 1,
        settings: { hitMark: 12345, maxRounds: '不是数字', 不存在的键: true },
    });
    const out = call('anko', `import ${payload}`);
    assert.match(out, /导入失败|设置 0 项/, `实际：${out}`);
    assert.equal(typeof stub.extensionSettings.anko_director.hitMark, 'string', '类型不对就不该写进去');
    assert.equal(stub.extensionSettings.anko_director.不存在的键, undefined, '未知键要丢掉');
});

test('/anko direct 不给输入时提示改用 continue', async () => {
    valueWrites.set('#send_textarea', '');
    assert.match(call('anko-direct', ''), /\/anko continue/);
});

// ---------------------------------------------------------------------------
// 提示词注入
// ---------------------------------------------------------------------------

test('提示词注入：模板里的占位符会被渲染成实际状态', () => {
    call('anko-attr', 'clear');
    call('anko-attr', 'set 话术 40');
    call('anko-attr', 'set 幸运 55');

    fakeJQuery('#anko_inject').val('当前属性：{{attrs}}；{{combat}}');
    const handler = handlerOf('#anko_inject');
    assert.ok(handler, '注入输入框要绑 input 事件');

    stub._injections = [];
    handler({ target: fakeJQuery('#anko_inject') });

    assert.equal(stub.extensionSettings.anko_director.injectTemplate, '当前属性：{{attrs}}；{{combat}}');
    assert.ok(stub._injections.length > 0, '要调 setExtensionPrompt');
    const injection = stub._injections.at(-1);
    assert.equal(injection.key, 'anko_director_state_note');
    assert.equal(injection.position, 1, '注入位置 IN_CHAT');
    assert.match(injection.value, /当前属性：话术 40　幸运 55/);
    assert.match(injection.value, /无战斗/);
});

test('提示词注入：模板清空就注入空串', () => {
    fakeJQuery('#anko_inject').val('');
    stub._injections = [];
    handlerOf('#anko_inject')({ target: fakeJQuery('#anko_inject') });
    assert.equal(stub._injections.at(-1).value, '');
});

// ---------------------------------------------------------------------------
// 格式约束（比世界书管用的那条）
// ---------------------------------------------------------------------------

/** 取最后一次格式约束注入。 */
function lastFormatLock() {
    return (stub._injections ?? []).filter((item) => item.key === 'anko_director_format_lock').at(-1);
}

test('★ 格式约束：depth 0（贴着生成点）、默认开、带过滤器、用 USER 角色', async () => {
    await fire('chat_id_changed');
    const injection = lastFormatLock();

    assert.ok(injection, '要有格式约束这条注入');
    assert.equal(injection.depth, 0, 'depth 0 = 紧贴生成点');
    // ⚠ 这条断言以前写的是 role=0（SYSTEM）—— 那是把 bug 固化成期望了。
    // 实测：`openai.js:764-786` 同深度按 ['system','user','assistant'] 生成消息、
    // 且同深度同角色会被 `\n` 拼成一条；用 SYSTEM 时用户录到的是
    // 「第 13 条，role=system，1667 字」（我的约束只有 239 字，其余是别人的），
    // 于是模型最后读到的是别人的约束。user 才排在 system 墙之后。
    assert.equal(injection.role, 1, 'role 必须是 USER(1)：SYSTEM 会被埋进 system 墙里');
    assert.match(injection.value, /格式约束/);
    assert.match(injection.value, /♛/);
    assert.match(injection.value, /原样保留/);
    assert.equal(typeof injection.filter, 'function', '要带过滤器，平时不占 token');
});

test('★ 格式约束的过滤器：没有骰子内容就不注入', async () => {
    await fire('chat_id_changed');
    const { filter } = lastFormatLock();

    stub.chat = [{ is_user: true, mes: '帮我写一段普通的问候' }];
    assert.equal(await filter(), false, '普通聊天不该注入');

    stub.chat = [{ is_user: true, mes: '我走进酒吧 → 【1d100=68 / 话术40 → 失败】' }];
    assert.equal(await filter(), true, '有检定回执就该注入');

    stub.chat = [{ is_user: true, mes: '选项骰十项：\n1-3 甲\n→ 【1d10=7】' }];
    assert.equal(await filter(), true, '有选项骰回执就该注入');

    // 往前找几条（正文 AI 可能在回倒数第二条）
    stub.chat = [
        { is_user: false, mes: '上一条' },
        { is_user: true, mes: '走了1d3天 → 【1d3=2】' },
        { is_user: false, mes: '……' },
    ];
    assert.equal(await filter(), true);
});

test('格式约束的过滤器不会因为脏数据炸掉', async () => {
    await fire('chat_id_changed');
    const { filter } = lastFormatLock();

    stub.chat = null;
    assert.equal(await filter(), false);
    stub.chat = [null, { mes: 123 }, {}];
    assert.equal(await filter(), false);
});

test('格式约束可以关掉', async () => {
    stub.extensionSettings.anko_director.formatLock = false;
    try {
        await fire('chat_id_changed');
        assert.equal(lastFormatLock().value, '', '关掉后注入空串');
    } finally {
        stub.extensionSettings.anko_director.formatLock = true;
        await fire('chat_id_changed');
    }
});

// ---------------------------------------------------------------------------
// 属性 / 成长
// ---------------------------------------------------------------------------

test('属性：set / add / del / clear / show 全套', async () => {
    await resetState();
    assert.match(call('anko-attr', 'show'), /还没有属性/);

    assert.match(call('anko-attr', 'set 话术 40'), /话术 = 40/);
    assert.match(call('anko-attr', 'add 话术 -5'), /话术：40 → 35/);
    assert.match(call('anko-attr', 'show'), /话术 35/);
    assert.match(call('anko-attr', 'del 话术'), /已删除 话术/);
    assert.match(call('anko-attr', 'show'), /还没有属性/);

    call('anko-attr', 'set 甲 1');
    call('anko-attr', 'set 乙 2');
    assert.match(call('anko-attr', 'clear'), /已清空 2 个属性/);
    assert.match(call('anko-attr', 'show'), /还没有属性/);
});

test('属性：车卡给默认八项', async () => {
    await resetState();
    const out = call('anko-attr', 'sheet');
    assert.match(out, /车卡完成（1d100）/);
    for (const name of ['力量', '敏捷', '体质', '智力', '意志', '外貌', '教育', '幸运']) {
        assert.match(out, new RegExp(name));
    }
    assert.match(call('anko-attr', 'show'), /力量 \d+/);
});

test('属性：写法错误给可读提示', () => {
    assert.match(call('anko-attr', 'set 话术'), /用法：\/anko attr set/);
    assert.match(call('anko-attr', 'add 不存在 1'), /操作失败：没有这个属性/);
    assert.match(call('anko-attr', '什么鬼'), /不认识的子命令/);
});

test('成长检定能跑，并写入日志', async () => {
    await resetState();
    call('anko-attr', 'set 话术 30');
    const out = call('anko-growth', '话术');
    assert.match(out, /话术 成长检定：1d100 = \d+ [>≤] \d+( → 成长 \+| → 没长进)/);
    assert.match(call('anko-growth', ''), /用法：\/anko growth/);
});

// ---------------------------------------------------------------------------
// 战斗轮
// ---------------------------------------------------------------------------

test('战斗：begin → round → status → end 全流程', async () => {
    await resetState();
    const begin = call('anko-combat', 'begin 打手 12 10 45');
    assert.match(begin, /战斗开始：我 vs 打手/);
    assert.match(begin, /先攻：/);
    assert.match(begin, /出手顺序：/);
    // begin 时会把我方的 HP/ATK/DEF 补进属性表
    const attrs = call('anko-attr', 'show');
    assert.match(attrs, /HP 20/);
    assert.match(attrs, /ATK 50/);
    assert.match(attrs, /DEF 10/);

    const round = call('anko-combat', 'round');
    assert.match(round, /—— 第 1\/5 轮 ——/);
    assert.match(round, /目标值 \d+）→ (大成功|大失败|命中|未命中)/);

    assert.match(call('anko-combat', 'status'), /我：ATK 50 \/ DEF 10/);
    assert.match(call('anko-combat', 'end'), /已中止/);
});

test('战斗：参数不足给用法提示', () => {
    assert.match(call('anko-combat', 'begin'), /用法：\/anko combat begin/);
});

test('战斗：最多 5 轮一定结束（要么分出生死，要么丝滑收场）', async () => {
    await resetState();
    // 注意：这里**故意不调 HP**。骰子是真随机的，我方可能真的被打死 ——
    // 那是正确行为，不该为了测试好写就去改数值。这里断言的是"一定会在 5 轮内结束"，
    // 至于是死在谁手里、还是丝滑收场，两种都接受。
    call('anko-combat', 'begin 打手 12 10 45');

    let out = '';
    let rounds = 0;
    for (let i = 0; i < 5; i += 1) {
        out = call('anko-combat', 'round');
        rounds += 1;
        if (/丝滑收场|战死|战斗结束/.test(out)) {
            break;
        }
    }

    assert.ok(rounds <= 5, `不该超过 5 轮，实际 ${rounds} 轮`);
    assert.match(out, /(丝滑收场|战死|战斗结束)/, '第 5 轮必须结束，不能一直拖');
    assert.match(call('anko-combat', 'round'), /已经结束/, '结束之后再点不该继续打');
});

// ---------------------------------------------------------------------------
// 死亡是真死
// ---------------------------------------------------------------------------

test('★ 死亡会落成持久状态，并明确写进给 agent 的简报', async () => {
    await resetState();

    assert.match(call('anko', 'die 被骰子坑死'), /已记录玩家角色战死/);
    assert.match(call('anko-attr', 'show'), /HP 0|还没有属性/, 'HP 该被清零');

    resetScenario(['收尾。']);
    await call('anko-direct', '继续');
    const brief = scenario.calls[0].prompt;
    assert.match(brief, /玩家角色已经战死/, '简报必须写明死讯');
    assert.match(brief, /被骰子坑死/, '带上死亡原因');
    assert.match(brief, /不要假装他还活着/, '要明确禁止 AI 糊过去');

    assert.match(call('anko', 'revive'), /已撤销死亡状态/);
    resetScenario(['收尾。']);
    await call('anko-direct', '继续');
    assert.ok(!scenario.calls[0].prompt.includes('已经战死'), '复活后简报里不该再有死讯');

    assert.match(call('anko', 'revive'), /本来就没死/);
});

test('死亡：面板上会显示出来', async () => {
    await resetState();
    call('anko', 'die 试试');
    assert.match(fakeJQuery('#anko_combat').text(), /☠ 玩家角色已战死/);
    call('anko', 'revive');
    assert.match(fakeJQuery('#anko_combat').text(), /无战斗|进行中|已结束/);
});

test('死亡：/anko die 不给原因也能用', async () => {
    await resetState();
    assert.match(call('anko-die', ''), /手动标记/);
    call('anko', 'revive');
});

// ---------------------------------------------------------------------------
// 随机表
// ---------------------------------------------------------------------------

test('随机表：内置表能列出来并投', () => {
    const list = call('anko-table', 'list');
    assert.match(list, /随机事件/);
    assert.match(list, /随机天气/);

    const rolled = call('anko-table', 'roll 随机天气');
    assert.match(rolled, /【随机天气】1d10 = \d+/);
    assert.match(rolled, /→ \d+-\d+ 区间/);
});

test('随机表：show 列出所有区间', () => {
    const out = call('anko-table', 'show 随机天气');
    assert.match(out, /共 10 段/);
    assert.match(out, /晴/);
});

test('随机表：自建、投、删', () => {
    assert.match(call('anko-table', 'add 今晚吃什么 1d4 面|饭|火锅|随便'), /已建表「今晚吃什么」/);
    assert.match(call('anko-table', 'roll 今晚吃什么'), /【今晚吃什么】1d4 = \d/);
    assert.match(call('anko-table', 'list'), /今晚吃什么/);
    // 自建表覆盖内置同名表
    assert.match(call('anko-table', 'add 随机天气 1d2 晴|雨'), /已建表「随机天气」/);
    assert.match(call('anko-table', 'roll 随机天气'), /【随机天气】1d2 = \d/);
    assert.match(call('anko-table', 'del 随机天气'), /已删除自定义表/);
    assert.match(call('anko-table', 'roll 随机天气'), /【随机天气】1d10 = \d/, '删掉自建后回落到内置');
});

test('随机表：写法错误给可读提示', () => {
    assert.match(call('anko-table', 'add 空表'), /用法：\/anko table add/);
    assert.match(call('anko-table', 'add 坏表 d100 a|b'), /操作失败：.*必须写成 1dN/);
    assert.match(call('anko-table', 'roll 不存在的表'), /操作失败：表「不存在的表」不存在/);
    assert.match(call('anko-table', '什么鬼'), /不认识的子命令/);
});

// ---------------------------------------------------------------------------
// 安价
// ---------------------------------------------------------------------------

test('安价：add / list / del / title / draw 全流程', () => {
    assert.match(call('anko-bid', 'clear'), /已清空/);
    assert.match(call('anko-bid', 'title 主角接下来做什么'), /标题：主角接下来做什么/);
    assert.match(call('anko-bid', 'add 去酒馆|去码头|继续睡觉'), /已加 3 项，共 3 项/);
    assert.match(call('anko-bid', 'list'), /【主角接下来做什么】共 3 项/);
    assert.match(call('anko-bid', 'del 2'), /已移除「去码头」，还剩 2 项/);

    const drawn = call('anko-bid', 'draw');
    assert.match(drawn, /共 2 项，投 1d2 = \d/);
    assert.match(drawn, /→ (去酒馆|继续睡觉)/);
    assert.match(call('anko-bid', 'list'), /安价池是空的/, '抽完要清空');
});

test('安价：空池抽取与越界删除给可读错误', () => {
    assert.match(call('anko-bid', 'draw'), /操作失败：安价池是空的/);
    assert.match(call('anko-bid', 'del 99'), /操作失败：选项序号/);
});

// ---------------------------------------------------------------------------
// 骰子命令（M1 回归）
// ---------------------------------------------------------------------------

test('投骰类命令仍然正常', () => {
    assert.match(call('anko-roll', '3d6k2+1'), /^3d6k2\+1 = \d+/m);
    assert.match(call('anko-check', '话术 40'), /→ (大成功|大失败|极难成功|困难成功|成功|失败)/);
    assert.match(call('anko-option', '6'), /选项骰 6 项/);
    assert.match(call('anko-inline', '走了1d3天'), /走了【1d3=\d】天/);
    assert.match(call('anko-log', '5'), /骰点日志/);
});

test('内联命令支持检定与选项注解', () => {
    const check = call('anko-inline', '我试探他 → 1d100【话术40】');
    assert.match(check, /【1d100=\d+ \/ 话术40 → \S+】/);

    const option = call('anko-inline', '→ 1d10【选项】');
    assert.match(option, /【1d10=\d+/);
});

test('★ /anko-inline 也会给选项表打命中标（只标一行）', () => {
    const text = [
        '选项骰十项：',
        '1-3 甲',
        '4-6 乙',
        '7-9 丙',
        '10 丁',
        '→ 1d10【选项】',
    ].join('\n');

    const out = call('anko-inline', text);
    assert.equal((out.match(/♛/g) ?? []).length, 1, '不管投中哪一行，只该有一个 ♛');
    assert.match(out, /已在 1 张选项表上标出命中行/);
    assert.match(out, /【1d10=\d+/);
});

test('面板上的命中符号输入框会被同步', () => {
    const saved = stub.extensionSettings.anko_director.hitMark;
    fakeJQuery('#anko_mark').val('★');
    handlerOf('#anko_mark')({ target: fakeJQuery('#anko_mark') });
    assert.equal(stub.extensionSettings.anko_director.hitMark, '★');

    stub.extensionSettings.anko_director.hitMark = saved;
    fakeJQuery('#anko_mark').val(saved ?? '');
});

// ---------------------------------------------------------------------------
// 状态落盘与清理
// ---------------------------------------------------------------------------

test('状态与日志写进了 chatMetadata（跟着聊天存档走）', async () => {
    call('anko-attr', 'set 持久化测试 1');
    await fire('chat_id_changed');
    assert.ok(stub.chatMetadata.anko_director_state, '状态要落到 chatMetadata');
    assert.equal(stub.chatMetadata.anko_director_state.attributes.持久化测试, 1);
    assert.ok(stub.chatMetadata.anko_director_roll_log, '骰点日志也要落盘');
});

test('切换聊天会重新装载状态', async () => {
    stub.chatMetadata = {
        anko_director_state: { attributes: { 别的聊天: 7 } },
        anko_director_roll_log: { seq: 0, entries: [] },
    };
    await fire('chat_id_changed');
    assert.match(call('anko-attr', 'show'), /别的聊天 7/);
    assert.ok(!/持久化测试/.test(call('anko-attr', 'show')), '不该残留上一个聊天的属性');
});

// ---------------------------------------------------------------------------
// 帮助
// ---------------------------------------------------------------------------

test('/anko help 覆盖了所有子系统', () => {
    const help = call('anko', 'help');
    for (const keyword of ['direct', 'roll', 'check', 'option', 'inline', 'attr', 'growth',
        'combat', 'table', 'bid', 'log', 'die', 'revive']) {
        assert.match(help, new RegExp(keyword), `帮助里缺少 ${keyword}`);
    }
});

test('/anko 无参数给帮助；乱写的子命令也有提示', () => {
    assert.match(call('anko', ''), /安科导游/);
    assert.match(call('anko', 'foobar'), /不认识子命令「foobar」/);
});

test('★ 「跟随当前设置」必须把额度传给 generateRaw（不传 → 用 300 → 空正文）', async () => {
    // 由来：用户报「跟随当前设置（默认）不对」✓。从代码推出来的原因：
    //   `generateRaw` 支持 `responseLength`（`script.js:3635` ✓），我们却只传了
    //   systemPrompt/prompt/prefill ✗ → 额度落到正文当前的 Max Response Length ✓，
    //   而 ST 默认 `openai_max_tokens: 300` ✗ → 推理模型的思考就能吃光 → 正文为空 ✗。
    //   而且"只回思考→降思考重试"和 `noContentError` 诊断**只在代理分支里有** ✗。
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = {
        builtin: settings.useBuiltinApi,
        src: settings.directorApiSource,
        model: settings.directorApiModel,
        profile: settings.directorProfile,
        max: settings.directorApiMaxTokens,
    };
    try {
        settings.useBuiltinApi = false;
        settings.directorApiSource = '';
        settings.directorApiModel = '';
        settings.directorProfile = '';
        settings.directorApiMaxTokens = 4096;
        stub.chat = [{ is_user: true, mes: '我推门进去' }];
        resetScenario(['他推门进去。']);

        await call('anko-direct', '我推门进去');

        assert.ok(scenario.calls.length >= 1, '应该真的调了 generateRaw');
        const first = scenario.calls[0];
        assert.equal(first.responseLength, 4096, `额度必须传下去，实际 ${first.responseLength}`);
        assert.ok(first.systemPrompt && first.systemPrompt.length > 0, '系统提示词也要传');
        assert.ok(first.prompt.includes('我推门进去'), '用户输入要在 prompt 里');
    } finally {
        settings.useBuiltinApi = saved.builtin;
        settings.directorApiSource = saved.src;
        settings.directorApiModel = saved.model;
        settings.directorProfile = saved.profile;
        settings.directorApiMaxTokens = saved.max;
    }
});

test('★ 面板没填额度时，「跟随当前设置」也要有个像样的兜底（不是 300）', async () => {
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = {
        builtin: settings.useBuiltinApi,
        src: settings.directorApiSource,
        model: settings.directorApiModel,
        profile: settings.directorProfile,
        max: settings.directorApiMaxTokens,
    };
    try {
        settings.useBuiltinApi = false;
        settings.directorApiSource = '';
        settings.directorApiModel = '';
        settings.directorProfile = '';
        settings.directorApiMaxTokens = null;
        stub.chat = [{ is_user: true, mes: '看看' }];
        resetScenario(['看了一眼。']);

        await call('anko-direct', '看看');

        const first = scenario.calls[0];
        assert.ok(Number(first.responseLength) > 0, '必须有额度，不能是 undefined ✗');
    } finally {
        settings.useBuiltinApi = saved.builtin;
        settings.directorApiSource = saved.src;
        settings.directorApiModel = saved.model;
        settings.directorProfile = saved.profile;
        settings.directorApiMaxTokens = saved.max;
    }
});




test('★★ 设置迁移 v2→v3：旧配置（来源空 + 模型有值）自动改为「同源换模型」', async () => {
    // 回归的根：旧版"来源留空 + 填了模型" = 同源换模型（走代理）✓，
    // 我改成显式哨兵后，同一份配置变成"跟随当前设置"✗ → 用户感觉"以前可以、现在不行"✗。
    // 修法就是**迁过去** ✓，不让用户重选一遍 ✗。
    const module = await import('../index.js');

    const old = { directorApiSource: '', directorApiModel: 'gemini-2.5-flash', maxRounds: 12 };
    const applied = module.migrateSettings(old, 2);
    assert.equal(old.directorApiSource, '__same__', '旧配置要迁到「同源换模型」✓');
    assert.match(applied.join('\n'), /同源换模型/, '迁移要在日志里说清楚 ✓');

    const explicit = { directorApiSource: 'custom', directorApiModel: 'x' };
    module.migrateSettings(explicit, 2);
    assert.equal(explicit.directorApiSource, 'custom', '已经选了具体来源的**不能动** ✗');

    const follow = { directorApiSource: '', directorApiModel: '' };
    module.migrateSettings(follow, 2);
    assert.equal(follow.directorApiSource, '', '真正"跟随当前设置"的（没填模型）也不能动 ✗');

    const fresh = { directorApiSource: '', directorApiModel: 'x' };
    module.migrateSettings(fresh, 3);
    assert.equal(fresh.directorApiSource, '', '已经到 v3 的不要再迁（否则会把用户新选的值改掉 ✗）');
});

test('★★ 同源换模型：必须带上正文当前预设（以前完全没应用 ✗），换预设要跟着变', async () => {
    // 依据：`ChatCompletionService.processRequest` 只有传 presetName 才应用预设
    // （`custom-request.js:540`）✓ —— 这条路不传 ✗ → 1.14.0 里等于不应用任何预设 ✗。
    // 用户期望（面板文案）：来源=正文 ✓ 模型=填的 ✓ 其余参数=正文当前预设 ✓。
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = {
        src: settings.directorApiSource,
        model: settings.directorApiModel,
        temp: settings.directorApiTemperature,
        max: settings.directorApiMaxTokens,
        builtin: settings.useBuiltinApi,
        profile: settings.directorProfile,
    };
    const oldService = stub.ChatCompletionService;
    const oldGet = stub.getPresetManager;
    const payloads = [];
    let selectedPreset = { temperature: 0.42, top_p: 0.81, openai_max_tokens: 1234 };
    try {
        settings.useBuiltinApi = false;
        settings.directorProfile = '';
        settings.directorApiSource = '__same__';
        settings.directorApiModel = 'cheap-model';
        settings.directorApiTemperature = null;
        settings.directorApiMaxTokens = null;

        stub.ChatCompletionService = {
            processRequest: async (payload) => {
                payloads.push(payload);
                return { content: '他推门进去。' };
            },
        };
        stub.getPresetManager = () => ({
            getSelectedPresetName: () => '正文预设',
            getCompletionPresetByName: (name) => (name === '正文预设' ? selectedPreset : undefined),
        });
        stub.chat = [{ is_user: true, mes: '我推门进去' }];
        resetScenario([]);

        await call('anko-direct', '我推门进去');

        assert.ok(payloads.length >= 1, '应该走了代理那条路');
        const p1 = payloads[0];
        assert.equal(p1.model, 'cheap-model', '模型用面板填的 ✓');
        assert.equal(p1.temperature, 0.42, '预设的温度要带进请求 ✓');
        assert.equal(p1.top_p, 0.81, '预设的 top_p 也要带 ✓');
        assert.equal(p1.max_tokens, 1234, '预设的 openai_max_tokens 要变成 max_tokens ✓');

        // 酒馆里换了预设 → 下一次推演必须跟着变 ✓
        selectedPreset = { temperature: 0.11, openai_max_tokens: 4321 };
        payloads.length = 0;
        await call('anko-direct', '再看看');
        assert.equal(payloads[0].temperature, 0.11, '换预设后要跟着变 ✓');

        // 面板填了 → 覆盖预设 ✓
        settings.directorApiTemperature = 0.9;
        settings.directorApiMaxTokens = 999;
        payloads.length = 0;
        await call('anko-direct', '再来');
        assert.equal(payloads[0].temperature, 0.9, '面板温度覆盖预设 ✓');
        assert.equal(payloads[0].max_tokens, 999, '面板额度覆盖预设 ✓');
    } finally {
        settings.directorApiSource = saved.src;
        settings.directorApiModel = saved.model;
        settings.directorApiTemperature = saved.temp;
        settings.directorApiMaxTokens = saved.max;
        settings.useBuiltinApi = saved.builtin;
        settings.directorProfile = saved.profile;
        stub.ChatCompletionService = oldService;
        stub.getPresetManager = oldGet;
    }
});

test('★★ 上游安全拦截（PROHIBITED_CONTENT）：要给行动建议，且**不许退回** generateRaw', async () => {
    // 依据：`PROHIBITED_CONTENT` 是 Google 的 finishReason/blockReason ✓，
    // 酒馆把四类阈值全设成 OFF 了 ✓（`src/constants.js` GEMINI_SAFETY），
    // 所以退回 generateRaw 只会用同一个模型再被拦一次 ✗ —— 白白多烧一次请求 ✗。
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = {
        src: settings.directorApiSource,
        model: settings.directorApiModel,
        builtin: settings.useBuiltinApi,
        profile: settings.directorProfile,
        temp: settings.directorApiTemperature,
        max: settings.directorApiMaxTokens,
    };
    const oldService = stub.ChatCompletionService;
    const oldGet = stub.getPresetManager;
    let rawCalls = 0;
    const originalRaw = stub.generateRaw;
    try {
        settings.useBuiltinApi = false;
        settings.directorProfile = '';
        settings.directorApiSource = '__same__';
        settings.directorApiModel = 'gemini-2.5-flash';
        settings.directorApiTemperature = null;
        settings.directorApiMaxTokens = null;

        stub.getPresetManager = () => ({ getSelectedPresetName: () => '', getCompletionPresetByName: () => undefined });
        stub.ChatCompletionService = {
            processRequest: async () => {
                throw new Error('Gemini blocked the request: PROHIBITED_CONTENT');
            },
        };
        stub.generateRaw = (request) => { rawCalls += 1; return originalRaw(request); };
        stub.chat = [{ is_user: true, mes: '继续' }];
        muted.length = 0;
        resetScenario([]);

        await call('anko-direct', '继续');

        assert.equal(rawCalls, 0, `不许退回 generateRaw ✗（实际调用 ${rawCalls} 次）`);
        const logged = muted.map((item) => item[1].map(String).join(' ')).join('\n');
        assert.match(logged, /安全策略/, '要说清是内容安全策略拦截 ✓');
        assert.match(logged, /换模型|换来源|OpenRouter/, '要给出可执行的建议 ✓');
    } finally {
        settings.directorApiSource = saved.src;
        settings.directorApiModel = saved.model;
        settings.useBuiltinApi = saved.builtin;
        settings.directorProfile = saved.profile;
        settings.directorApiTemperature = saved.temp;
        settings.directorApiMaxTokens = saved.max;
        stub.ChatCompletionService = oldService;
        stub.getPresetManager = oldGet;
        stub.generateRaw = originalRaw;
    }
});

test('★★ 代理路必须"抄酒馆的实时设置"（chatCompletionSettings），不是自己解析预设 ✗', async () => {
    // 这才是酒馆自己的做法 ✓：选中预设时酒馆把值写进 `oai_settings`（= getContext().chatCompletionSettings
    // ，`st-context.js:206` ✓），之后每次请求都从这份**实时设置**取参数 ✓。
    // 我前面一直去解析"预设对象"✗ —— 那条路要赌预设名/字段名，天然多几个失败点 ✗。
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = {
        src: settings.directorApiSource, model: settings.directorApiModel,
        temp: settings.directorApiTemperature, max: settings.directorApiMaxTokens,
        builtin: settings.useBuiltinApi, profile: settings.directorProfile,
    };
    const oldService = stub.ChatCompletionService;
    const oldGet = stub.getPresetManager;
    const oldLive = stub.chatCompletionSettings;
    const payloads = [];
    try {
        settings.useBuiltinApi = false;
        settings.directorProfile = '';
        settings.directorApiSource = '__same__';
        settings.directorApiModel = 'cheap-model';
        settings.directorApiTemperature = null;
        settings.directorApiMaxTokens = null;

        stub.chatCompletionSettings = {
            temp_openai: 0.63,
            top_p_openai: 0.77,
            freq_pen_openai: 0.05,
            pres_pen_openai: 0.15,
            openai_max_tokens: 1536,
            reasoning_effort: 'medium',
        };
        stub.getPresetManager = () => ({ getSelectedPresetName: () => '某个预设' });
        stub.ChatCompletionService = {
            processRequest: async (payload) => { payloads.push(payload); return { content: '好的。' }; },
        };
        stub.chat = [{ is_user: true, mes: '继续' }];
        resetScenario([]);

        await call('anko-direct', '继续');

        const p = payloads[0];
        assert.equal(p.temperature, 0.63, '温度要来自**实时设置** ✓');
        assert.equal(p.top_p, 0.77);
        assert.equal(p.frequency_penalty, 0.05);
        assert.equal(p.presence_penalty, 0.15);
        assert.equal(p.max_tokens, 1536, 'openai_max_tokens → max_tokens ✓');
        assert.equal(p.reasoning_effort, 'medium', '字符串枚举不能丢 ✓');
    } finally {
        settings.directorApiSource = saved.src;
        settings.directorApiModel = saved.model;
        settings.directorApiTemperature = saved.temp;
        settings.directorApiMaxTokens = saved.max;
        settings.useBuiltinApi = saved.builtin;
        settings.directorProfile = saved.profile;
        stub.ChatCompletionService = oldService;
        stub.getPresetManager = oldGet;
        stub.chatCompletionSettings = oldLive;
    }
});


test('★★ 跟随当前设置：必须走酒馆的 generateQuietPrompt（它才带预设那 67 条 + 聊天上下文）', async () => {
    // 依据：`generateQuietPrompt`（`script.js:2832`）走酒馆完整组装 ✓；
    // `generateRaw` 是"完全自己控制提示词"✗（文档原话）→ 预设与上下文都不进 ✗。
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = { builtin: settings.useBuiltinApi, src: settings.directorApiSource, model: settings.directorApiModel, profile: settings.directorProfile };
    const oldQuiet = stub.generateQuietPrompt;
    const oldRaw = stub.generateRaw;
    const quietCalls = [];
    let rawCalls = 0;
    try {
        settings.useBuiltinApi = false;
        settings.directorProfile = '';
        settings.directorApiSource = '';
        settings.directorApiModel = '';
        stub.generateQuietPrompt = async (options) => {
            quietCalls.push(options);
            return '他推门进去。';
        };
        stub.generateRaw = (request) => { rawCalls += 1; return oldRaw(request); };
        stub.chat = [{ is_user: true, mes: '我推门进去' }];
        resetScenario([]);

        await call('anko-direct', '我推门进去');

        assert.equal(quietCalls.length >= 1, true, '必须调用 generateQuietPrompt ✓');
        assert.equal(rawCalls, 0, '不该再用 generateRaw ✗');
        const q = String(quietCalls[0].quietPrompt ?? '');
        assert.match(q, /导游|导演/, 'quietPrompt 里要有导演的任务说明 ✓');
        assert.match(q, /我推门进去/, '也要有玩家输入 ✓');
        assert.ok(Number(quietCalls[0].responseLength) > 0, '额度要传 ✓');
    } finally {
        settings.useBuiltinApi = saved.builtin;
        settings.directorApiSource = saved.src;
        settings.directorApiModel = saved.model;
        settings.directorProfile = saved.profile;
        stub.generateQuietPrompt = oldQuiet;
        stub.generateRaw = oldRaw;
    }
});







test('★ 导入预设：必须走 savePreset 默认参数（skipUpdate=false → 酒馆自动应用 ✓）', async () => {
    // 依据（本机核实 ✓）：`preset-manager.js:466` savePreset；`:497` updateList → trigger('change') → 应用 ✓
    const calls = [];
    const oldPresetManager = stub.getPresetManager;
    try {
        stub.getPresetManager = (api) => (api === 'openai' ? {
            getAllPresets: () => ['Reborn2.4.2'],
            getSelectedPresetName: () => 'Reborn2.4.2',
            findPreset: () => '0',
            selectPreset: () => {},
            savePreset: async (name, data, options) => { calls.push({ name, data, options }); },
            getPresetSettings: () => ({ prompts: [] }),
        } : null);
        // 假造 File（只要 text() 与 name ✓）
        const file = {
            name: '导入测试.json',
            text: async () => JSON.stringify({
                prompts: [{ identifier: 'a', content: 'A' }],
                prompt_order: [{ character_id: 100000, order: [{ identifier: 'a', enabled: true }] }],
            }),
        };
        const mod = await import('../index.js');
        await mod._importPresetToSt(file);
        assert.equal(calls.length, 1, '应当保存一次 ✓');
        assert.equal(calls[0].name, '导入测试', '名字取文件名 ✓');
        const options = calls[0].options ?? {};
        assert.notEqual(options.skipUpdate, true, '不许传 skipUpdate: true ✗（那样酒馆不会应用 ✓）');
    } finally {
        stub.getPresetManager = oldPresetManager;
    }
});

test('★ 酒馆预设：下拉只**显示**预设（不改你的预设 ✗），导入仍可用 ✓', async () => {
    await resetState();
    const oldPresetManager = stub.getPresetManager;
    const switched = [];
    try {
        stub.getPresetManager = (api) => (api === 'openai' ? {
            getAllPresets: () => ['Reborn2.4.2', '另一个预设'],
            getSelectedPresetName: () => 'Reborn2.4.2',
            findPreset: () => '1',
            selectPreset: (value) => { switched.push(value); },
            savePreset: async () => {},
            getPresetSettings: () => ({ prompts: [] }),
        } : null);

        handlerOf('#anko_preset_select', 'focus')({ target: fakeJQuery('#anko_preset_select') });
        const html = String(fakeJQuery('#anko_preset_select').html() ?? '');
        assert.match(html, /Reborn2\.4\.2/, '下拉里要有预设名 ✓');
        assert.equal(switched.length, 0, '这个插件**不许**切换你的预设 ✗');
    } finally {
        stub.getPresetManager = oldPresetManager;
    }
});

test('★★ 跟随当前设置：必须走酒馆的 generateQuietPrompt（它才带预设那 67 条 + 聊天上下文）', async () => {
    // 依据：`generateQuietPrompt`（`script.js:2832`）走酒馆完整组装 ✓；
    // `generateRaw` 是"完全自己控制提示词"✗（文档原话）→ 预设与上下文都不进 ✗。
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = { builtin: settings.useBuiltinApi, src: settings.directorApiSource, model: settings.directorApiModel, profile: settings.directorProfile };
    const oldQuiet = stub.generateQuietPrompt;
    const oldRaw = stub.generateRaw;
    const quietCalls = [];
    let rawCalls = 0;
    try {
        settings.useBuiltinApi = false;
        settings.directorProfile = '';
        settings.directorApiSource = '';
        settings.directorApiModel = '';
        stub.generateQuietPrompt = async (options) => {
            quietCalls.push(options);
            return '他推门进去。';
        };
        stub.generateRaw = (request) => { rawCalls += 1; return oldRaw(request); };
        stub.chat = [{ is_user: true, mes: '我推门进去' }];
        resetScenario([]);

        await call('anko-direct', '我推门进去');

        assert.equal(quietCalls.length >= 1, true, '必须调用 generateQuietPrompt ✓');
        assert.equal(rawCalls, 0, '不该再用 generateRaw ✗');
        const q = String(quietCalls[0].quietPrompt ?? '');
        assert.match(q, /导游|导演/, 'quietPrompt 里要有导演的任务说明 ✓');
        assert.match(q, /我推门进去/, '也要有玩家输入 ✓');
        assert.ok(Number(quietCalls[0].responseLength) > 0, '额度要传 ✓');
    } finally {
        settings.useBuiltinApi = saved.builtin;
        settings.directorApiSource = saved.src;
        settings.directorApiModel = saved.model;
        settings.directorProfile = saved.profile;
        stub.generateQuietPrompt = oldQuiet;
        stub.generateRaw = oldRaw;
    }
});







test('★ 导入预设：必须走 savePreset 默认参数（skipUpdate=false → 酒馆自动应用 ✓）', async () => {
    // 依据（本机核实 ✓）：`preset-manager.js:466` savePreset；`:497` updateList → trigger('change') → 应用 ✓
    const calls = [];
    const oldPresetManager = stub.getPresetManager;
    try {
        stub.getPresetManager = (api) => (api === 'openai' ? {
            getAllPresets: () => ['Reborn2.4.2'],
            getSelectedPresetName: () => 'Reborn2.4.2',
            findPreset: () => '0',
            selectPreset: () => {},
            savePreset: async (name, data, options) => { calls.push({ name, data, options }); },
            getPresetSettings: () => ({ prompts: [] }),
        } : null);
        // 假造 File（只要 text() 与 name ✓）
        const file = {
            name: '导入测试.json',
            text: async () => JSON.stringify({
                prompts: [{ identifier: 'a', content: 'A' }],
                prompt_order: [{ character_id: 100000, order: [{ identifier: 'a', enabled: true }] }],
            }),
        };
        const mod = await import('../index.js');
        await mod._importPresetToSt(file);
        assert.equal(calls.length, 1, '应当保存一次 ✓');
        assert.equal(calls[0].name, '导入测试', '名字取文件名 ✓');
        const options = calls[0].options ?? {};
        assert.notEqual(options.skipUpdate, true, '不许传 skipUpdate: true ✗（那样酒馆不会应用 ✓）');
    } finally {
        stub.getPresetManager = oldPresetManager;
    }
});

test('★ 酒馆预设：下拉只**显示**预设（不改你的预设 ✗），导入仍可用 ✓', async () => {
    await resetState();
    const oldPresetManager = stub.getPresetManager;
    const switched = [];
    try {
        stub.getPresetManager = (api) => (api === 'openai' ? {
            getAllPresets: () => ['Reborn2.4.2', '另一个预设'],
            getSelectedPresetName: () => 'Reborn2.4.2',
            findPreset: () => '1',
            selectPreset: (value) => { switched.push(value); },
            savePreset: async () => {},
            getPresetSettings: () => ({ prompts: [] }),
        } : null);

        handlerOf('#anko_preset_select', 'focus')({ target: fakeJQuery('#anko_preset_select') });
        const html = String(fakeJQuery('#anko_preset_select').html() ?? '');
        assert.match(html, /Reborn2\.4\.2/, '下拉里要有预设名 ✓');
        assert.equal(switched.length, 0, '这个插件**不许**切换你的预设 ✗');
    } finally {
        stub.getPresetManager = oldPresetManager;
    }
});
test('★★ 跟随当前设置：必须走酒馆的 generateQuietPrompt（它才带预设那 67 条 + 聊天上下文）', async () => {
    // 依据：`generateQuietPrompt`（`script.js:2832`）走酒馆完整组装 ✓；
    // `generateRaw` 是"完全自己控制提示词"✗（文档原话）→ 预设与上下文都不进 ✗。
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = { builtin: settings.useBuiltinApi, src: settings.directorApiSource, model: settings.directorApiModel, profile: settings.directorProfile };
    const oldQuiet = stub.generateQuietPrompt;
    const oldRaw = stub.generateRaw;
    const quietCalls = [];
    let rawCalls = 0;
    try {
        settings.useBuiltinApi = false;
        settings.directorProfile = '';
        settings.directorApiSource = '';
        settings.directorApiModel = '';
        stub.generateQuietPrompt = async (options) => {
            quietCalls.push(options);
            return '他推门进去。';
        };
        stub.generateRaw = (request) => { rawCalls += 1; return oldRaw(request); };
        stub.chat = [{ is_user: true, mes: '我推门进去' }];
        resetScenario([]);

        await call('anko-direct', '我推门进去');

        assert.equal(quietCalls.length >= 1, true, '必须调用 generateQuietPrompt ✓');
        assert.equal(rawCalls, 0, '不该再用 generateRaw ✗');
        const q = String(quietCalls[0].quietPrompt ?? '');
        assert.match(q, /导游|导演/, 'quietPrompt 里要有导演的任务说明 ✓');
        assert.match(q, /我推门进去/, '也要有玩家输入 ✓');
        assert.ok(Number(quietCalls[0].responseLength) > 0, '额度要传 ✓');
    } finally {
        settings.useBuiltinApi = saved.builtin;
        settings.directorApiSource = saved.src;
        settings.directorApiModel = saved.model;
        settings.directorProfile = saved.profile;
        stub.generateQuietPrompt = oldQuiet;
        stub.generateRaw = oldRaw;
    }
});







test('★ 导入预设：必须走 savePreset 默认参数（skipUpdate=false → 酒馆自动应用 ✓）', async () => {
    // 依据（本机核实 ✓）：`preset-manager.js:466` savePreset；`:497` updateList → trigger('change') → 应用 ✓
    const calls = [];
    const oldPresetManager = stub.getPresetManager;
    try {
        stub.getPresetManager = (api) => (api === 'openai' ? {
            getAllPresets: () => ['Reborn2.4.2'],
            getSelectedPresetName: () => 'Reborn2.4.2',
            findPreset: () => '0',
            selectPreset: () => {},
            savePreset: async (name, data, options) => { calls.push({ name, data, options }); },
            getPresetSettings: () => ({ prompts: [] }),
        } : null);
        // 假造 File（只要 text() 与 name ✓）
        const file = {
            name: '导入测试.json',
            text: async () => JSON.stringify({
                prompts: [{ identifier: 'a', content: 'A' }],
                prompt_order: [{ character_id: 100000, order: [{ identifier: 'a', enabled: true }] }],
            }),
        };
        const mod = await import('../index.js');
        await mod._importPresetToSt(file);
        assert.equal(calls.length, 1, '应当保存一次 ✓');
        assert.equal(calls[0].name, '导入测试', '名字取文件名 ✓');
        const options = calls[0].options ?? {};
        assert.notEqual(options.skipUpdate, true, '不许传 skipUpdate: true ✗（那样酒馆不会应用 ✓）');
    } finally {
        stub.getPresetManager = oldPresetManager;
    }
});

test('★ 酒馆预设：下拉只**显示**预设（不改你的预设 ✗），导入仍可用 ✓', async () => {
    await resetState();
    const oldPresetManager = stub.getPresetManager;
    const switched = [];
    try {
        stub.getPresetManager = (api) => (api === 'openai' ? {
            getAllPresets: () => ['Reborn2.4.2', '另一个预设'],
            getSelectedPresetName: () => 'Reborn2.4.2',
            findPreset: () => '1',
            selectPreset: (value) => { switched.push(value); },
            savePreset: async () => {},
            getPresetSettings: () => ({ prompts: [] }),
        } : null);

        handlerOf('#anko_preset_select', 'focus')({ target: fakeJQuery('#anko_preset_select') });
        const html = String(fakeJQuery('#anko_preset_select').html() ?? '');
        assert.match(html, /Reborn2\.4\.2/, '下拉里要有预设名 ✓');
        assert.equal(switched.length, 0, '这个插件**不许**切换你的预设 ✗');
    } finally {
        stub.getPresetManager = oldPresetManager;
    }
});


test('★★ MVU 式：口径用 setExtensionPrompt 注入，且 filter 只在推演期间放行', async () => {
    await resetState();
    const settings = stub.extensionSettings.anko_director;
    const saved = { name: settings.directorPresetName, builtin: settings.useBuiltinApi };
    const oldPresetManager = stub.getPresetManager;
    const oldSet = stub.setExtensionPrompt;
    const calls = [];
    try {
        settings.useBuiltinApi = false;
        settings.directorPresetName = '导演专用预设';
        stub.getPresetManager = (api) => (api === 'openai' ? {
            getSelectedPresetName: () => '当前预设',
            getPresetSettings: (name) => (name === '导演专用预设' ? {
                prompts: [{ identifier: 'x', name: 'X', content: '导演专用口径：第三人称、冷静', role: 'system' }],
                prompt_order: [{ character_id: 100000, order: [{ identifier: 'x', enabled: true }] }],
            } : null),
        } : null);
        stub.setExtensionPrompt = (key, value, position, depth, scan, role, filter) => {
            calls.push({ key, value, position, depth, role, filter });
        };
        stub.chat = [{ is_user: true, mes: '继续' }];
        resetScenario(['他推门进去。']);

        await call('anko-direct', '继续');

        const ours = calls.filter((item) => String(item.key).includes('preset_guidance'));
        assert.ok(ours.length >= 1, '必须调用 setExtensionPrompt 注入口径 ✓');
        assert.match(String(ours[0].value), /导演专用口径/, '注入了选中那份预设的条目 ✓');
        assert.equal(typeof ours[0].filter, 'function', '必须带 filter（平时不注入）✓');
        assert.equal(ours[0].filter(), false, '推演结束后 filter 必须关掉 ✓');
    } finally {
        settings.directorPresetName = saved.name;
        settings.useBuiltinApi = saved.builtin;
        stub.getPresetManager = oldPresetManager;
        stub.setExtensionPrompt = oldSet;
    }
});