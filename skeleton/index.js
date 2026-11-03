/**
 * ============================================================================
 *  酒馆扩展骨架（范本）— 入口文件
 * ============================================================================
 *  适用：SillyTavern 前端扩展（UI Extension），纯 ESM，无需构建步骤。
 *  目录约定：本文件所在目录 = 扩展根目录，ST 通过 manifest.json 的 "js" 加载它。
 *
 *  六条设计原则（每条都能在官方文档/源码里找到依据，详见 docs/开发规范与踩坑清单.md）：
 *   1. 只经 SillyTavern.getContext() / SillyTavern.libs 取 API，不 import ST 内部模块。
 *      官方原文：内部 import "may break with internal changes"。
 *   2. 依赖 DOM 的初始化放在 APP_READY 之后。APP_READY 在「已就绪」状态下会对
 *      新挂上的监听者自动重放，所以不需要自己判断时序。
 *   3. 侧栏面板用 renderExtensionTemplateAsync 渲染独立 HTML 模板：
 *      返回值已被 DOMPurify 清洗，并自动套用 data-i18n 翻译。
 *   4. 注入提示词用 setExtensionPrompt，不改写 chat 数组（chat 是真实聊天记录）。
 *   5. 监听器集中登记，disable/清理时整批摘掉，避免重复注册。
 *   6. 生成拦截器必须挂到 globalThis：ST 是按 globalThis[名字] 查找的。
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// 1. 常量：改名时这几处必须一起改（清单见 README「改造清单」）
// ---------------------------------------------------------------------------

/** 设置键名。必须全局唯一，否则会和别的扩展抢 extensionSettings 里的同一个对象。 */
const MODULE_NAME = 'st_extension_skeleton';

/** 扩展在 ST 里的挂载路径：third-party/<安装目录名>。目录名改了这里也要改。 */
const EXTENSION_PATH = 'third-party/st-extension-skeleton';

/** 生成拦截器的全局函数名。必须与 manifest.json 的 generate_interceptor 完全一致。 */
const INTERCEPTOR_NAME = 'stExtensionSkeletonInterceptor';

/** setExtensionPrompt 的 key，同样要求全局唯一。 */
const INJECTION_KEY = `${MODULE_NAME}_injection`;

/** 斜杠命令名，最终用法为 /skeleton。 */
const COMMAND_NAME = 'skeleton';

/** 日志前缀，便于在控制台里过滤自己的输出。 */
const LOG_PREFIX = '[扩展骨架]';

/** 设置结构版本号，用于写迁移逻辑。 */
const SETTINGS_VERSION = 1;

/**
 * setExtensionPrompt 的位置/角色枚举。
 *
 * 注意：这两个枚举**没有**暴露在 getContext() 里（可以在 st-context.js 里搜
 * extension_prompt 验证），源码 public/script.js 中的实际取值如下。
 * 为了两个数字去 import 内部模块不划算，这里按源码值本地定义。
 */
const PROMPT_POSITION = Object.freeze({ NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 });
const PROMPT_ROLE = Object.freeze({ SYSTEM: 0, USER: 1, ASSISTANT: 2 });

// ---------------------------------------------------------------------------
// 2. 小工具
// ---------------------------------------------------------------------------

/**
 * 每次都重新取 context。
 * 不要把它缓存到模块级变量：chat / chatMetadata 这些引用会在切换聊天时被换掉，
 * 官方文档明确警告「Do not save the reference to chatMetadata in a long-lived variable」。
 */
const ctx = () => SillyTavern.getContext();

const log = (...args) => console.log(LOG_PREFIX, ...args);
const warn = (...args) => console.warn(LOG_PREFIX, ...args);
const fail = (...args) => console.error(LOG_PREFIX, ...args);

// ---------------------------------------------------------------------------
// 3. 设置
// ---------------------------------------------------------------------------

/**
 * 默认设置。新增键直接加进来即可，getSettings() 会自动为老用户补上默认值。
 * 原则：只放小的、JSON 可序列化的东西。大对象请放 localforage（官方 Best Practices）。
 * 原则：绝对不要放 API key —— extensionSettings 是明文且所有扩展都能读到。
 */
const defaultSettings = Object.freeze({
    enabled: true,
    injectionEnabled: false,
    injectionText: '（示例注入）请保持回复简洁。',
    injectionDepth: 4,
    injectionRole: PROMPT_ROLE.SYSTEM,
    countReceived: true,
    settingsVersion: SETTINGS_VERSION,
});

/**
 * 取出设置对象，并补齐缺失的键。
 * 这是官方推荐做法：合并默认值，这样扩展升级后新增的键对老用户也生效。
 * @returns {Record<string, any>} 设置对象（extensionSettings 里的同一个引用，可直接改）
 */
function getSettings() {
    const { extensionSettings } = ctx();
    const store = (extensionSettings[MODULE_NAME] ??= {});
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!Object.hasOwn(store, key)) {
            store[key] = structuredClone(value);
        }
    }
    return store;
}

/**
 * 设置结构迁移。只在版本号落后时执行，返回是否发生了改动。
 * 迁移写完记得同步把 defaultSettings.settingsVersion 和 SETTINGS_VERSION 提上去。
 * @param {Record<string, any>} store
 * @returns {boolean} 是否发生了迁移
 */
function migrateSettings(store) {
    const from = Number(store.settingsVersion ?? 0);
    if (!Number.isFinite(from) || from >= SETTINGS_VERSION) {
        return false;
    }

    // --- 示例：把 v0 的旧键 oldInjectionText 改名到 injectionText ---
    if (from < 1 && typeof store.oldInjectionText === 'string') {
        if (!store.injectionText) {
            store.injectionText = store.oldInjectionText;
        }
        delete store.oldInjectionText;
    }

    store.settingsVersion = SETTINGS_VERSION;
    log(`设置已从 v${from} 迁移到 v${SETTINGS_VERSION}`);
    return true;
}

/** 写入设置并交给 ST 去防抖保存。任何改动设置的地方都要调它。 */
function persistSettings() {
    ctx().saveSettingsDebounced();
}

// ---------------------------------------------------------------------------
// 4. 面板 UI
// ---------------------------------------------------------------------------

/** 是否已经挂过面板，防止重复插入。 */
let panelMounted = false;

/** 取本扩展 manifest 里声明的版本号，拿不到就退回占位值。 */
function extensionVersion() {
    try {
        const manifest = ctx().getExtensionManifest?.(MODULE_NAME);
        return manifest?.version ?? '0.0.0';
    } catch {
        return '0.0.0';
    }
}

/**
 * 渲染并挂载设置面板。
 * 左栏 #extensions_settings 放系统类功能，右栏 #extensions_settings2 放界面/视觉类功能。
 * 本范本按「界面/视觉类」挂右栏；如果你做的是系统级开关，换成左栏。
 */
async function mountPanel() {
    if (panelMounted) {
        return;
    }

    const { renderExtensionTemplateAsync } = ctx();
    const settings = getSettings();

    // 第二个参数是模板名，不带 .html 后缀
    const html = await renderExtensionTemplateAsync(EXTENSION_PATH, 'settings', {
        title: 'Extension Skeleton',
        version: extensionVersion(),
        injectionDepth: settings.injectionDepth,
        injectionText: settings.injectionText,
    });

    if ($('#st_ext_skeleton_panel').length > 0) {
        // 理论上不会走到；万一同名面板已存在（比如页面被手动注入过），就地替换。
        $('#st_ext_skeleton_panel').replaceWith(html);
    } else {
        $('#extensions_settings2').append(html);
    }

    panelMounted = true;
    bindPanelEvents();
    syncPanelFromSettings();
    log('设置面板已挂载');
}

/** 把设置值刷进面板控件。挂载后、以及外部改动设置后都应调用。 */
function syncPanelFromSettings() {
    const settings = getSettings();
    $('#st_ext_skeleton_enabled').prop('checked', Boolean(settings.enabled));
    $('#st_ext_skeleton_injection_enabled').prop('checked', Boolean(settings.injectionEnabled));
    $('#st_ext_skeleton_injection_text').val(String(settings.injectionText));
    $('#st_ext_skeleton_injection_depth').val(Number(settings.injectionDepth));
    $('#st_ext_skeleton_count_received').prop('checked', Boolean(settings.countReceived));
    $('#st_ext_skeleton_stats').text(String(chatStats.total));
}

/** 绑定面板上的控件事件。用 .on 而不是内联 onclick，方便将来清理。 */
function bindPanelEvents() {
    $('#st_ext_skeleton_enabled').on('input', (event) => {
        getSettings().enabled = Boolean($(event.target).prop('checked'));
        persistSettings();
        applyRuntimeState();
    });

    $('#st_ext_skeleton_injection_enabled').on('input', (event) => {
        getSettings().injectionEnabled = Boolean($(event.target).prop('checked'));
        persistSettings();
    });

    $('#st_ext_skeleton_injection_text').on('input', (event) => {
        getSettings().injectionText = String($(event.target).val());
        persistSettings();
    });

    $('#st_ext_skeleton_injection_depth').on('input', (event) => {
        const value = Number($(event.target).val());
        getSettings().injectionDepth = Number.isFinite(value) ? value : defaultSettings.injectionDepth;
        persistSettings();
    });

    $('#st_ext_skeleton_count_received').on('input', (event) => {
        getSettings().countReceived = Boolean($(event.target).prop('checked'));
        persistSettings();
    });

    $('#st_ext_skeleton_reset_stats').on('click', () => {
        chatStats.total = 0;
        saveChatStats();
        syncPanelFromSettings();
        toastr.info('本聊天的统计已清零', '扩展骨架');
    });
}

// ---------------------------------------------------------------------------
// 5. 运行时状态（示例：只读统计 + 每聊天元数据）
// ---------------------------------------------------------------------------

/** 内存态，切聊天时由 CHAT_CHANGED 重新装载。 */
const chatStats = { total: 0 };

/**
 * 每聊天数据放 chatMetadata，它随聊天文件一起保存。
 * 键名同样要加扩展前缀，避免和别的扩展撞车。
 */
const CHAT_META_KEY = `${MODULE_NAME}_stats`;

/** 从当前聊天的元数据里装载统计值。切聊天必须重新调用。 */
function loadChatStats() {
    const { chatMetadata } = ctx();
    const stored = chatMetadata?.[CHAT_META_KEY];
    chatStats.total = Number(stored?.total) || 0;
    syncPanelFromSettings();
}

/** 把统计值写回当前聊天的元数据。 */
function saveChatStats() {
    const { chatMetadata, saveMetadataDebounced } = ctx();
    if (!chatMetadata) {
        return;
    }
    chatMetadata[CHAT_META_KEY] = { total: chatStats.total };
    saveMetadataDebounced();
}

// ---------------------------------------------------------------------------
// 6. 事件监听（集中登记 / 集中摘除）
// ---------------------------------------------------------------------------

/** @type {Array<[string, Function]>} 已登记的监听器，用于整批摘除。 */
const registeredListeners = [];

/**
 * 登记一个事件监听器。
 * @param {string} eventType eventTypes 里的键
 * @param {Function} handler 处理函数
 */
function listen(eventType, handler) {
    const { eventSource } = ctx();
    eventSource.on(eventType, handler);
    registeredListeners.push([eventType, handler]);
}

/** 摘掉本扩展登记过的全部监听器。重复注册就是这么避免的。 */
function unlistenAll() {
    const { eventSource } = ctx();
    for (const [eventType, handler] of registeredListeners.splice(0)) {
        eventSource.removeListener(eventType, handler);
    }
}

/**
 * 消息收到后的处理示例。
 * 这个事件在「消息已写进 chat、但还没渲染」时触发，很适合做统计/解析。
 * 注意：它每条消息都会跑一次，所以这里只做 O(1) 的活；重活请排队到空闲时做。
 * @param {number} messageId 消息在 chat 数组里的下标
 */
function onMessageReceived(messageId) {
    const settings = getSettings();
    if (!settings.enabled || !settings.countReceived) {
        return;
    }
    if (typeof messageId !== 'number') {
        return;
    }
    chatStats.total += 1;
    saveChatStats();
    syncPanelFromSettings();
}

/** 切换聊天时，所有与聊天绑定的状态都要重新装载。 */
function onChatChanged() {
    loadChatStats();
    log('已切换聊天，状态重新装载');
}

/** 注册本扩展需要的全部事件。 */
function registerListeners() {
    const { eventTypes } = ctx();
    listen(eventTypes.MESSAGE_RECEIVED, onMessageReceived);
    listen(eventTypes.CHAT_CHANGED, onChatChanged);
    // 其余常用事件按需加：
    //   MESSAGE_SENT / MESSAGE_EDITED / MESSAGE_DELETED / MESSAGE_SWIPED
    //   GENERATION_STARTED / GENERATION_STOPPED / GENERATION_ENDED
    //   CHARACTER_MESSAGE_RENDERED / USER_MESSAGE_RENDERED / WORLDINFO_UPDATED
}

// ---------------------------------------------------------------------------
// 7. 生成拦截器（提示词注入的正确姿势）
// ---------------------------------------------------------------------------

/** 重入保护：拦截器内部若触发新的生成，不要再跑一遍。 */
let interceptorBusy = false;

/**
 * 生成拦截器。
 *
 * 由 manifest.json 的 generate_interceptor 指到 INTERCEPTOR_NAME，
 * ST 会在非 dry-run 的生成请求上调用它：globalThis[名字](chat, contextSize, abort, type)。
 *
 * 这里刻意**不改写 chat**（chat 就是真实聊天记录，改了会落到存档里），
 * 而是用 setExtensionPrompt 注入 —— 它只作用于即将发出的提示词。
 *
 * @param {object[]} chat 即将用于构建提示词的消息数组（可变，慎改）
 * @param {number} contextSize 本次生成的上下文大小（token）
 * @param {(immediately: boolean) => void} abort 调用即中止生成；传 true 还会阻止后续拦截器
 * @param {string} type 生成触发类型：'normal' | 'quiet' | 'regenerate' | 'swipe' | 'impersonate' ...
 */
async function generateInterceptor(chat, contextSize, abort, type) {
    try {
        const settings = getSettings();

        // 关闭状态：把上一次注入的内容清空，否则它会一直留在 extension_prompts 里。
        if (!settings.enabled || !settings.injectionEnabled) {
            ctx().setExtensionPrompt(INJECTION_KEY, '', PROMPT_POSITION.IN_PROMPT, 0);
            return;
        }

        // 静默生成（自动总结、翻译、变量更新这类后台调用）默认不注入，
        // 避免自己的后台生成被自己注入的内容污染 —— 这是最常见的翻车点之一。
        if (type === 'quiet') {
            return;
        }

        if (interceptorBusy) {
            warn('拦截器重入，已跳过本次注入');
            return;
        }
        interceptorBusy = true;

        const text = String(settings.injectionText ?? '').trim();
        if (!text) {
            ctx().setExtensionPrompt(INJECTION_KEY, '', PROMPT_POSITION.IN_PROMPT, 0);
            return;
        }

        const depth = Math.max(0, Number(settings.injectionDepth) || 0);
        const role = Number(settings.injectionRole) || PROMPT_ROLE.SYSTEM;

        // 位置 IN_CHAT + depth：插在倒数第 depth 条消息处；scan=false 表示不参与世界书扫描。
        ctx().setExtensionPrompt(INJECTION_KEY, text, PROMPT_POSITION.IN_CHAT, depth, false, role);

        // 想中止生成就调 abort(false)；要连带阻止后续扩展的拦截器则调 abort(true)。
        // 中止属于破坏性操作，范本里只留说明不启用。
        // abort(false);
    } catch (error) {
        // 拦截器抛错只会污染本次生成，所以自己吞掉并记录，不要往上抛。
        fail('拦截器执行失败', error);
    } finally {
        interceptorBusy = false;
    }
}

/** 把拦截器挂到 globalThis —— ST 是按 globalThis[名字] 查找的，模块作用域无效。 */
function registerInterceptor() {
    globalThis[INTERCEPTOR_NAME] = generateInterceptor;
}

// ---------------------------------------------------------------------------
// 8. 斜杠命令
// ---------------------------------------------------------------------------

/** 注册 /skeleton 命令，返回一段状态文本。 */
function registerSlashCommand() {
    const { SlashCommandParser, SlashCommand } = ctx();

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: COMMAND_NAME,
        // 回调可以是 async；返回字符串会直接输出到聊天/控制台
        callback: async () => {
            const settings = getSettings();
            return [
                `扩展骨架 v${extensionVersion()}`,
                `启用：${settings.enabled ? '是' : '否'}`,
                `提示词注入：${settings.injectionEnabled ? `开（深度 ${settings.injectionDepth}）` : '关'}`,
                `本聊天已统计回复数：${chatStats.total}`,
            ].join('\n');
        },
        returns: 'the extension status',
        // 需要参数时这样声明（范本里先注释掉，留个样子；用到时再从 getContext() 取
        // SlashCommandArgument 和 ARGUMENT_TYPE）：
        // unnamedArgumentList: [
        //     SlashCommandArgument.fromProps({
        //         description: '要统计的文本',
        //         typeList: [ARGUMENT_TYPE.STRING],
        //         isRequired: true,
        //     }),
        // ],
        helpString: `
            <div>显示扩展骨架的当前状态。</div>
            <div><strong>示例：</strong> <code>/skeleton</code></div>
        `,
    }));
}

// ---------------------------------------------------------------------------
// 9. 生命周期
// ---------------------------------------------------------------------------

/** 是否已完成初始化，保证 init 幂等。 */
let initialized = false;

/** 按当前设置开关运行时行为（例如清掉不再需要的注入）。 */
function applyRuntimeState() {
    const settings = getSettings();
    if (!settings.enabled || !settings.injectionEnabled) {
        // 关掉时主动清空注入，因为 setExtensionPrompt 一旦写入就会一直生效。
        ctx().setExtensionPrompt(INJECTION_KEY, '', PROMPT_POSITION.IN_PROMPT, 0);
    }
    $('#st_ext_skeleton_body').toggle(Boolean(settings.enabled));
}

/** 一次性初始化：设置、UI、监听、命令。可安全重复调用。 */
async function init() {
    if (initialized) {
        return;
    }
    initialized = true;

    try {
        const store = getSettings();
        if (migrateSettings(store)) {
            persistSettings();
        }
        await mountPanel();
        loadChatStats();
        registerListeners();
        applyRuntimeState();
        log('初始化完成');
    } catch (error) {
        fail('初始化失败', error);
    }
}

/** 卸载：摘监听、移除面板、清注入。disable 钩子会调它。 */
function teardown() {
    initialized = false;
    panelMounted = false;
    unlistenAll();
    try {
        ctx().setExtensionPrompt(INJECTION_KEY, '', PROMPT_POSITION.IN_PROMPT, 0);
    } catch (error) {
        warn('清理注入失败', error);
    }
    $('#st_ext_skeleton_panel').remove();
    log('已卸载');
}

// ---------------------------------------------------------------------------
// 10. 模块加载时立即执行的同步部分
// ---------------------------------------------------------------------------

// 拦截器与斜杠命令必须是同步、尽早完成的，所以放在模块顶层而不是 APP_READY 里。
registerInterceptor();
try {
    registerSlashCommand();
} catch (error) {
    fail('注册斜杠命令失败', error);
}

// APP_READY 是异步初始化的正确入口：
//   - 若页面已就绪，ST 会对新挂上的监听者**自动重放**这个事件，所以不会漏；
//   - 若尚未就绪，它会在就绪时触发。
// 因此不需要自己写轮询或 setTimeout 判断时序。
ctx().eventSource.on(ctx().eventTypes.APP_READY, () => {
    // 事件处理器会被 await：这里先让出一帧，避免把就绪流程卡住。
    setTimeout(() => {
        void init();
    }, 0);
});

// ---------------------------------------------------------------------------
// 11. manifest.json 里声明的生命周期钩子（必须是具名导出）
// ---------------------------------------------------------------------------
// 钩子有 5 秒超时，超时只会告警并继续，所以钩子里别做重活。

/** 安装后：初始化默认数据。 */
export async function onInstall() {
    log('已安装，写入默认设置');
    getSettings();
    persistSettings();
}

/** 更新后：跑一次结构迁移。 */
export async function onUpdate() {
    const store = getSettings();
    if (migrateSettings(store)) {
        persistSettings();
    }
    log('已更新');
}

/** 页面加载期间激活：只做同步的事。 */
export function onActivate() {
    log('已激活');
}

/** 启用前：ST 默认会刷新页面，所以这里不需要重建状态。 */
export function onEnable() {
    log('已启用');
}

/** 禁用前：摘掉监听与 UI。 */
export function onDisable() {
    log('已禁用，开始清理');
    teardown();
}

/** 用户点「清理扩展数据」或删除时选择清理。 */
export async function onClean() {
    const { extensionSettings } = ctx();
    delete extensionSettings[MODULE_NAME];
    persistSettings();
    teardown();
    log('数据已清理');
}

/** 从服务器删除前：清掉本地遗留数据。 */
export async function onDelete() {
    teardown();
    log('即将被删除');
}
