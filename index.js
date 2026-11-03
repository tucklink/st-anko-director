/**
/**
 * ============================================================================
 *  安科导游 —— 入口
 * ============================================================================
 *
 *  ⚠️ **改这个文件之前，先跑一句**：
 *      npm run ask 预设          （换成你要动的那个关键词）
 *  这个仓库的结论都在 `docs/` 里 ✓（入口是 `AGENTS.md` ✓，索引是 `docs/INDEX.md` ✓）。
 *  我在这项目里反复犯的错就是"先改、被纠正后才翻文档" ✗ —— 所以把检索压成一条命令 ✓。
 *  尤其是这几类改动：酒馆交互（预设 / 连接配置 / generateRaw / 注入 / 世界书 / 钩子）、
 *  额度与提示词、面板与命令的契约 ✓。
 *
 *  插件在酒馆里扮演「骰子神」，内置一个导演 agent 替玩家把一个回合推演完：
 *  多轮写大纲 → 在需要随机的地方写下骰子表达式 → 插件真随机投骰、原地替换
 *  → 大纲写进输入框。
 *
 *  分工是死的：agent 是导游，插件是骰子神，**骰子值只能插件生成**。
 *
 *  设计依据 docs/设计书.md；酒馆侧 API 与坑 docs/开发规范与踩坑清单.md。
 *
 *  从源码核实过的关键事实（决定了本文件的写法）：
 *    · 斜杠命令回调是 `(namedArguments, unnamedArguments)`，后者可能是字符串也可能是数组
 *    · 命令名允许连字符，只有 `/ # : parser-flag breakpoint` 前缀被禁；重名会同步抛错
 *    · `generateRaw({ systemPrompt, prompt, prefill })` 不经过 Generate()，**不触发扩展拦截器**
 *      —— 所以导演循环用它，天然没有自递归
 *    · `updateMessageBlock(messageId, message, { rerenderMessage })`
 *    · `saveMetadataDebounced()` 发现聊天变了会**放弃保存**，切聊天前必须 `saveMetadata()`
 * ============================================================================
 */

import { DiceError, defaultRng, rollExpression } from './src/dice.js';
import { buildRollDiceTool, canUseDiceTool, ROLL_DICE_TOOL_NAME } from './src/tool-roll-dice.js';
import {
    formatCheckReplacement,
    formatKongmingReplacement,
    rollCheck,
    rollKongming,
} from './src/rules.js';
import {
    findDiceUnits,
    findInvalidDiceLike,
    formatRoll,
    resolveDiceUnits,
    resolveExpressions,
    splitAtFirstExpression,
    stripEcho,
} from './src/inline.js';
import { createRollLog } from './src/roll-log.js';
import { DEFAULT_HIT_MARK, markOptionHits } from './src/option-table.js';
import { runDirector, describeError } from './src/director.js';
import { presetGuidanceFromSettings, presetToPayload, settingsToPayload } from './src/preset.js';
import { isTokensSuspiciouslyLow, resolveDirectorTokens } from './src/tokens.js';
import { buildFormatLockText, DIRECTOR_SYSTEM_PROMPT, stripVariableUpdateBlocks, buildContextBrief, setDiceMode } from './src/prompts.js';
import {
    DEFAULT_ATTRIBUTE_NAMES,
    adjustAttribute,
    bidAdd,
    bidClear,
    bidDraw,
    bidRemove,
    bidSetTitle,
    clearOutlines,
    createState,
    formatAttributes,
    formatBid,
    formatOutlines,
    growthCheck,
    markDead,
    migrateState,
    pushOutline,
    removeAttribute,
    revive,
    rollAttributeSheet,
    setAttribute,
} from './src/state.js';
import {
    COMBAT_MAX_ROUNDS,
    createCombat,
    describeCombat,
    resolveRound,
    resultLabel,
} from './src/combat.js';
import { getTable, listTables, normalizeTable, rollTable } from './src/tables.js';
import { API_KINDS, callChatApi } from './src/api.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const MODULE_NAME = 'anko_director';
const EXTENSION_PATH = 'third-party/st-anko-director';
const LOG_PREFIX = '[安科导游]';

/**
 * 「同源换模型」这个选项的**哨兵值** ✓。
 *
 * 为什么需要它：以前"来源留空"同时表示两件事 ✗ ——
 *   模型空 = 跟随当前设置 ✓；模型填了 = 偷偷换成"同源换模型" ✗
 * 用户看不出区别（面板只写了"跟随当前设置"），于是"默认选项行为不对" ✗。
 * 现在拆成两个显式选项 ✓：空串 = 跟随当前设置，`__same__` = 同源换模型 ✓。
 */
const SAME_SOURCE_SENTINEL = '__same__';

/**
 * 构建标记 —— **每次改代码都顺手把它改成当前时间**。
 *
 * 存在的理由：我们反复卡在"你到底刷新了没有"这件事上，双方都只能猜。
 * 面板「状态」行会直接显示这个标记，一眼就能看出浏览器加载的是不是最新代码：
 * 如果它比你手上的时间旧，就是缓存在作怪（`Ctrl+Shift+R` 硬刷新）。
 */
const BUILD = '11-01 11:53';

/** chatMetadata 里的两个键（状态与骰点日志分开存，免得迁移逻辑互相干扰）。 */
const META_STATE_KEY = `${MODULE_NAME}_state`;
const META_LOG_KEY = `${MODULE_NAME}_roll_log`;

/** setExtensionPrompt 的键，全局唯一。 */
const INJECTION_KEY = `${MODULE_NAME}_state_note`;

/**
 * 空输入时代替玩家输入的那句话。
 *
 * 为什么不真的传空串：`buildDirectorPrompt` 对空输入写的是「（玩家没有输入，请你推进剧情）」——
 * 太含糊了，模型容易摸鱼。给一句明确的、有推进感的指令。
 */
const CONTINUE_INPUT = '玩家没有给新的行动，请接着前面的剧情自然地把故事往下推一幕：'
    + '让局势自己发展、让 NPC 行动、让时间流动。不要原地打转，也不要重演已经发生过的场景。';

/**
 * 导演"预设口径"注入用的键（MVU 式：**注入**，不是切预设 ✓）。
 *
 * 依据（本机逐行核实 ✓）：
 *   · `script.js:8378` `setExtensionPrompt(key, value, position, depth, scan, role, filter)` ✓
 *   · `openai.js:1262-1300` 里，`position` 为 BEFORE_PROMPT / IN_PROMPT 的扩展提示词会被并进 `systemPrompts` ✓
 *   · `openai.js:1296` 的 `filter` 是**每次组装时调用** ✓ → 返回 false 就**完全不注入**（不占 token ✓）
 * 所以：**只在导演推演期间**（filter 判定）注入一份"口径" ✓；平时零影响 ✓；
 * 且**绝不调 `selectPreset`** ✗、不改预设 ✗、不落盘 ✗。
 */
const PRESET_GUIDANCE_KEY = `${MODULE_NAME}_preset_guidance`;

/** 给正文 AI 的格式约束，单独一个键。 */
const FORMAT_LOCK_KEY = `${MODULE_NAME}_format_lock`;

/**
 * setExtensionPrompt 的位置枚举。
 * 这两个枚举**没有**暴露在 getContext() 里（见规范文档 §3），所以按源码值本地定义。
 */
const PROMPT_POSITION = Object.freeze({ NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 });

/**
 * setExtensionPrompt 的角色枚举。
 *
 * **实测出来的关键一条：同一深度上，酒馆按 `['system','user','assistant']` 的顺序生成消息**
 * （`openai.js:764-786`），而且**同深度同角色的注入会被 `\n` 拼成一条消息**（`jointPrompt`）。
 * 所以用 SYSTEM 注入的东西会被焊死在一堵别人也注入的 system 墙**正中间**；
 * 用 USER 才会落在那堵墙**之后**。详见 `applyFormatLock`。
 */
const PROMPT_ROLE = Object.freeze({ SYSTEM: 0, USER: 1, ASSISTANT: 2 });
const INJECTION_DEPTH = 4;

/** 战斗里用的三个属性名。 */
const ATTR_HP = 'HP';
const ATTR_ATK = 'ATK';
const ATTR_DEF = 'DEF';
const COMBAT_DEFAULTS = Object.freeze({ hp: 20, atk: 50, def: 10 });

/**
 * 设置结构版本。**改了默认值、或加了新键，就 +1**，并在 `migrateSettings` 里写迁移。
 *
 * 为什么需要：`getSettings()` 只补**缺失**的键 —— 用户第一次装插件时那个默认值
 * 就已经存进他的设置里了，之后我改默认值**动不了它**。
 * 真实踩到：把轮数上限默认从 8 提到 12，用户面板里还是 8，于是双方都以为"没改对"。
 */
const SETTINGS_VERSION = 3;

/**
 * `/anko option` 不带参数时用几项。
 *
 * ⚠️ 这**不是**设置项：选项表的项数由模型写的骰子面数决定（`1d10` → 十项、`1d6` → 六项），
 * 孔明式就是十项表。以前这里有个 `optionCount` 设置键 + `resolveUnit` 的一个形参，
 * 但**两头都没接线**（形参从来没被读过、面板上也没有控件）—— 典型假旋钮，已删。
 */
const DEFAULT_OPTION_COUNT = 10;

/**
 * 一次性迁移：**只动那些还停在旧默认值上的键**（用户明确改过的值绝不碰）。
 *
 * 导出是为了能被测试直接验证 —— 它只在启动时跑一次，集成测试很难构造"老存档"。
 * @param {object} store
 * @param {number} fromVersion
 * @returns {string[]} 做过哪些迁移（给日志/面板看）
 */
export function migrateSettings(store, fromVersion) {
    const applied = [];

    if (fromVersion < 2 && Number(store.maxRounds) === 8) {
        // v1 的默认是 8 轮。实测一个回合常投 3–7 次骰子、一次骰子一轮，8 轮很容易打满，
        // 后面改成 12 —— 但老用户的设置里还留着 8，所以要迁一次。
        store.maxRounds = defaultSettings.maxRounds;
        applied.push(`轮数上限 8 → ${store.maxRounds}（旧默认值太小，一个回合容易打满）`);
    }

    if (fromVersion < 3) {
        // v2 → v3：来源下拉里"空值"的含义变了 ✗
        //   旧：来源留空 + 填了模型 → **同源换模型**（走服务端代理）✓ —— 用户一直在用这条路 ✓
        //   新：来源留空 = 跟随当前设置（generateRaw）✗，模型被忽略 ✗
        // 所以老配置（留空 + 有模型）要**自动迁到「同源换模型」** ✓，否则用户升级后
        // 会看到"以前可以、现在不行" ✓（这正是本次的回归 ✗）。
        const hasModel = String(store.directorApiModel ?? '').trim() !== '';
        const sourceEmpty = String(store.directorApiSource ?? '').trim() === '';
        if (hasModel && sourceEmpty) {
            store.directorApiSource = SAME_SOURCE_SENTINEL;
            applied.push('导演来源：旧配置（留空 + 填了模型）已自动改为「同源换模型」✓'
                + '（新版本"留空"已改成"跟随当前设置"，模型会被忽略 ✗）');
        }
    }

    return applied;
}

/** 最近一次设置迁移做了什么（面板/调试用）。 */
let lastSettingsMigration = [];

const defaultSettings = Object.freeze({
    /** 孔明式选项表的默认项数。 */
    /** 输出里是否附带每颗骰子的原始点数。 */
    showRawDice: true,
    /** 叙述人称。见 prompts.js 的 NARRATION_PERSONS —— 不给规则的话人称会随轮次飘。 */
    narrationPerson: 'auto',
    /** 严格因果模式：强制一轮一骰。 */
    strictCausality: false,
    /**
     * 导演**专用**的预设名（只影响导演 ✓，不改你酒馆的当前预设 ✗）。
     *
     * 机制照 MVU 的思路 ✓（它不碰预设 ✓，只往提示词里**注入** ✓）：
     *   读这份预设的 `prompts` + `prompt_order` ✓ → 把启用的条目按顺序拼进导演的 `quietPrompt` ✓。
     * ⚠️ 采样参数（temperature / max_tokens 等）**仍用酒馆当前设置** ✗ —— 那些只有切预设才会变 ✓，
     *    而我们**不切**（切了会改你正文 ✗）。等价说法：**口径用这份预设，采样用当前设置** ✓。
     */
    directorPresetName: '',
    /**
     * 导演自己的 API **来源**（走酒馆服务端代理，不是浏览器直连）。
     *
     * 这就是用户说的「不走酒馆」的真正含义：**不用正文那套 API 设置**，
     * 仍然经酒馆的 `/api/backends/chat-completions/generate` 发出去 ——
     * 所以没有 CORS，密钥和自定义地址都用酒馆里已经配好的那一份。
     * 空串 = 跟随当前设置。
     */
    directorApiSource: '',
    /** 导演用的模型名；空串 = 用该来源当前选中的模型。 */
    directorApiModel: '',
    /**
     * 是否把「投骰」注册成**酒馆核心的函数工具**（P2）。
     *
     * 开着的时候，模型可以主动调用 `RollDice({expression, options})`：
     * 参数是结构化的十项表，返回的是真骰值 —— 于是"模型用自然语言描述一次函数调用"
     * 带来的所有歧义（解析、抢标、表写歪）从根上不存在。
     *
     * 但**不是所有来源都支持工具调用**（`isToolCallingSupported()`），所以：
     *   · 支持 → 注册工具，导演提示词走工具口径
     *   · 不支持 → 不注册，整套退回文本协议（`→ 1d10【选项】`）那条老路
     * 两条路的开关由 `syncDiceTool()` 统一裁决，别在别处单独判断。
     *
     * ⚠️⚠️ **默认必须是 false** —— 这是踩出来的：我接 P2 时把它默认设成 `true` ✗，
     * 结果模型尝试调用 `RollDice` 时上游返回
     * `finish_reason: "error"` + **`native_finish_reason: "MALFORMED_FUNCTION_CALL"`**
     * （实测日志），消息 `content: null / reasoning: null` ✗ → 导演**一个字都产不出来** ✓。
     *
     * 教训：**一个新机制不许默认打开** ✗ —— 默认值等于"所有用户的默认体验"，
     * 拿它做实验就是把别人的游戏当试验田 ✓。P2 要开，得等 MALFORMED_FUNCTION_CALL
     * 查清、并且在面板上给一个明确的开关 + 警告 ✓。
     */
    useDiceTool: false,
    /**
     * 要不要把**当前激活的世界书**塞进导演的上下文简报。
     *
     * 默认开：导演本来完全看不到世界书（`generateRaw` 不跑主提示词组装），
     * 于是它会编出和设定冲突的东西。代价是**每轮都重复一遍**（一回合最多 12 轮），
     * 世界书越大越贵。用户明确选了"全塞进去"，所以这里**不截断**。
     */
    worldInfoInBrief: true,
    /**
     * 内置 API（**完全不走酒馆**）。
     *
     * 为什么要有：酒馆那条路总被设置/预设/提示词组装牵着走，而且服务端错误原文
     * 经常传不出来（见规范 B22）。自己发请求就自由了，错误也是我们解析的原文。
     * 代价：浏览器直连要过 **CORS**，不是所有接口都允许（见 `src/api.js` 顶部注释）。
     */
    useBuiltinApi: false,
    builtinApiKind: 'openai',
    builtinApiBase: '',
    builtinApiKey: '',
    builtinApiModel: '',
    /** 温度；留空（null）就不传，用接口默认值。 */
    builtinApiTemperature: null,
    /** 最大 token；0 表示不传。 */
    builtinApiMaxTokens: 2048,
    /**
     * 导演自己的 API 来源（走酒馆代理）那一次的 `max_tokens`；0 表示不传。
     *
     * ⚠️ 这个键以前**只被读、从没被定义过**（读的地方是 `directorMaxTokens()` 和代理路径），
     * 也没在面板上出现过 —— 于是永远是 `undefined` → 判定成 0 → 永远不传 ✗。
     * 这正是我在审计里骂过的"假旋钮"（`optionCount` 同类），自己又犯了一次。
     *
     * 默认值是 0（不传），**不是某个我挑的数字**：查过源码 ——
     *   · 传值 → 会**覆盖**预设（`shared.js:412` + `custom-request.js:220`）
     *   · 不传 → 该键被丢掉，服务端原样透传（`chat-completions.js:630/705/…`）→ 落到服务商默认上限
     * 而"某个具体数字更好"**没有任何证据** ✗：我一度写死 2048 并声称"服务商默认不够用"，
     * **已被实测推翻** —— 传 2048 时正文照样是空的（`{content:"",reasoning:"…"}`），
     * 真因是 Gemini 3 默认 high 思考（厂商明文，见规范 §7.0），与额度无关 ✗。
     * 需要时在面板填一个值即可（>0 才传）。
     */
    directorApiMaxTokens: 0,
    /** 导演循环轮数上限。一个回合常要投 3–7 次骰子，一次骰子一轮，所以别设太小。 */
    maxRounds: 12,
    /** 发送前自动推演。 */
    autoDirector: false,
    /** 大纲直接发送（不给用户改）。 */
    directSend: false,
    /**
     * 用 `prefill` 续写。
     * 默认关：prefill 会变成一条 assistant 消息，而 **Gemini 拒绝「请求以模型回合结尾」**
     * （HTTP 400 `Requests ending with a model turn are not supported`）。
     * 关掉时改用内嵌续写（把已定稿放进用户消息），所有 API 都能跑。
     */
    usePrefill: false,
    /** 注入主提示词的状态文本模板，留空则不注入。 */
    injectTemplate: '',
    /**
     * 选项骰命中那一行后面打的符号。
     * 由**插件**打，不靠 AI —— 谁投的骰子谁负责标结果。留空则不打标。
     */
    hitMark: DEFAULT_HIT_MARK,
    /**
     * 给正文 AI 的格式约束，默认开。
     *
     * 用户自己写的世界书约束力不够（它落在角色定义区、离生成点很远，还要命中关键词才注入）。
     * 这份约束由插件在 **depth 0**（贴着生成点）注入，而且**只在真的出现骰子内容时才注入**
     * —— 靠 `setExtensionPrompt` 的 filter 参数，平时完全不占 token。
     */
    formatLock: true,
    /**
     * 结算**正文 AI 自己写的**骰子。
     *
     * 默认关，因为设计上骰子归导演：大纲里已经投好了（带 ♛），演员只负责叙述，
     * 不该再写新骰子。但如果你不开导演、就想让插件把正文里的 `1d100【话术40】` 投掉，
     * 打开它即可 —— 关着是为了不越权改演员的输出。
     */
    resolveAiDice: false,
    /**
     * 面板挂成**常驻浮窗**（桌面端用）。
     *
     * 为什么自己写浮窗、不用酒馆的 `Popup`：`Popup` 是模态的，会挡住聊天，
     * 而"看着骰点日志聊天"恰恰需要不挡。自己写还免得多依赖一层版本相关的 API。
     */
    panelFloat: false,
    /** 浮窗位置（屏幕坐标，拖动后记住）。 */
    floatPos: null,
    settingsVersion: SETTINGS_VERSION,
});

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

const ctx = () => SillyTavern.getContext();

const log = (...args) => console.log(LOG_PREFIX, ...args);
const warn = (...args) => console.warn(LOG_PREFIX, ...args);
const fail = (...args) => console.error(LOG_PREFIX, ...args);
/**
 * 每个消息/每轮都会跑的日志走这里。
 *
 * 规范 A10：「生产环境刷屏日志 —— 统一前缀 + 需要时才 console.debug」。
 * `console.debug` 在 Chrome 里默认归到 Verbose 一档，**默认不显示**，
 * 但打开 Verbose 就能看到 —— 正好是"排障时能看到、平时不吵"。
 */
const debug = (...args) => console.debug(LOG_PREFIX, ...args);

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

/** 骰点日志（内存态，跟着聊天存档一起落盘）。 */
const rollLog = createRollLog();

/** 每聊天的状态。 */
let ankoState = createState();

/** 事件监听登记表 —— 只为**排查用**保留（`unlistenAll` 已随 hooks 删除 ✓）。 */
const listeners = [];
const listen = (eventType, handler) => {
    const { eventSource } = ctx();
    // 防呆：eventTypes 里没有这个键时 `on(undefined, …)` 会静默注册到 `undefined` 上，
    // 然后你永远等不到它 —— 这类"静默不生效"最难查（规范 §1.7 也警告过命名不一致）。
    if (typeof eventType !== 'string' || eventType.length === 0) {
        fail('要监听的事件名不是字符串 —— eventTypes 里可能没有这个键', eventType);
        return false;
    }
    eventSource.on(eventType, handler);
    listeners.push([eventType, handler]);
    return true;
};
// ⚠️ 这里原来有个 `unlistenAll`（整批摘掉 eventSource 监听）✓ —— 它唯一的调用者是
// `teardown()`，而 `teardown()` 只被已删除的 hooks 调用 ✗。所以一并删掉了 ✓。
// （`listeners` 数组还留着：调试时能看到注册了哪些事件 ✓。）
// 将来若要做"禁用时摘监听"，先确认那个版本的酒馆**真的会调用**钩子（1.14.0 不会 ✗）。

// ---------------------------------------------------------------------------
// 状态读写（chatMetadata）
// ---------------------------------------------------------------------------

function loadChatState() {
    const { chatMetadata } = ctx();
    ankoState = migrateState(chatMetadata?.[META_STATE_KEY]);
    rollLog.hydrate(chatMetadata?.[META_LOG_KEY] ?? {});
    refreshPanel();
}

/**
 * 保存状态。
 *
 * ⚠️ `immediate` 默认就是 **true** —— 规范 B18：
 * `saveMetadataDebounced()` 的防抖回调会重新比对 `groupId`/`characterId`，
 * 发现聊天已经切了就打一行 `console.warn` 然后**放弃保存**。
 * 也就是说「改了属性 → 立刻切聊天」这类操作，最后一次写入会**静默丢失**。
 * 我们的写入频率很低（一次用户操作 / 一次推演各一次），走立即保存完全负担得起。
 *
 * @param {{immediate?: boolean}} [options] immediate=false 才走防抖（高频更新才用得上）
 */
function saveChatState({ immediate = true } = {}) {
    const { chatMetadata, saveMetadata, saveMetadataDebounced } = ctx();
    if (!chatMetadata) {
        return;
    }
    chatMetadata[META_STATE_KEY] = ankoState;
    chatMetadata[META_LOG_KEY] = rollLog.toJSON();

    // 状态一变就把注入主提示词的状态文本重渲染一遍。
    // 以前只在 init / 切聊天 / 编辑模板 / 导入时刷 —— 于是改完属性、打完架，
    // 正文 AI 看到的 `{{attrs}}`/`{{combat}}` 还是旧值（这条注入存在的意义就是给它看当前数值）。
    try {
        applyInjection();
    } catch (error) {
        warn('重渲染状态注入失败（不影响存档）', error);
    }

    if (immediate && typeof saveMetadata === 'function') {
        void saveMetadata();
    } else if (typeof saveMetadataDebounced === 'function') {
        saveMetadataDebounced();
    }
}

// ---------------------------------------------------------------------------
// 常驻浮窗（把面板从侧栏搬到屏幕上，边聊边看骰点日志）
// ---------------------------------------------------------------------------

const FLOAT_ID = '#anko_float';
const FLOAT_BODY_ID = '#anko_float_body';
const PANEL_HOME = '#extensions_settings2';

/** 浮窗开着没（模块态）。别去查 DOM —— DOM 可能被别的扩展或酒馆重渲染清掉。 */
let floatOpen = false;
let floatDrag = null;

/** 屏幕尺寸（Node 里没有 window，给个兜底）。 */
function viewportSize() {
    if (typeof window === 'undefined') {
        return { width: 1280, height: 800 };
    }
    return { width: window.innerWidth, height: window.innerHeight };
}

function currentFloatPos() {
    const saved = getSettings().floatPos;
    if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) {
        return { left: saved.left, top: saved.top };
    }
    const { width } = viewportSize();
    return { left: Math.max(8, width - 380), top: 64 };
}

/** 浮窗的骨架（只在第一次打开时插入）。 */
function floatHtml() {
    const pos = currentFloatPos();
    return `<div id="anko_float" class="anko-float" style="left:${pos.left}px; top:${pos.top}px;">`
        + '<div id="anko_float_bar" class="anko-float-bar">'
        + '<span class="anko-float-title">安科导游</span>'
        + '<span id="anko_float_pin" class="anko-float-btn" title="收回侧栏">⇱</span>'
        + '</div>'
        + `<div id="${FLOAT_BODY_ID.slice(1)}" class="anko-float-body"></div>`
        + '</div>';
}

/** 拖动 + 收回按钮（绑一次就够）。 */
function bindFloat() {
    if (bindFloat.done) {
        return;
    }
    bindFloat.done = true;

    $('#anko_float_bar').on('pointerdown', (event) => {
        if (event?.target?.id === 'anko_float_pin') {
            return;
        }
        const pos = currentFloatPos();
        floatDrag = {
            startX: Number(event?.clientX ?? 0),
            startY: Number(event?.clientY ?? 0),
            baseLeft: pos.left,
            baseTop: pos.top,
        };
    });

    // 指针事件同时覆盖鼠标与触屏
    $(document).on('pointermove', (event) => {
        if (!floatDrag) {
            return;
        }
        const { width, height } = viewportSize();
        const left = Math.min(Math.max(0, floatDrag.baseLeft + (Number(event?.clientX ?? 0) - floatDrag.startX)), Math.max(0, width - 60));
        const top = Math.min(Math.max(0, floatDrag.baseTop + (Number(event?.clientY ?? 0) - floatDrag.startY)), Math.max(0, height - 40));
        $(FLOAT_ID).css({ left: `${left}px`, top: `${top}px` });
    });

    $(document).on('pointerup', () => {
        if (!floatDrag) {
            return;
        }
        floatDrag = null;
        const left = parseFloat($(FLOAT_ID).css('left'));
        const top = parseFloat($(FLOAT_ID).css('top'));
        if (Number.isFinite(left) && Number.isFinite(top)) {
            getSettings().floatPos = { left, top };
            ctx().saveSettingsDebounced();
        }
    });

    $('#anko_float_pin').on('click', () => {
        closeFloat();
        toastr.info('面板已收回右侧扩展设置里', '安科导游');
    });
}

/** 把面板搬进浮窗。 */
function openFloat() {
    try {
        if ($(FLOAT_ID).length === 0) {
            $('body').append(floatHtml());
            bindFloat.done = false; // 新建的浮窗要重新绑
            bindFloat();
        }
        $(FLOAT_ID).css({ left: `${currentFloatPos().left}px`, top: `${currentFloatPos().top}px` });
        $('#anko_panel').appendTo(FLOAT_BODY_ID);
        $(FLOAT_ID).toggle(true);
        floatOpen = true;
        refreshPanel();
        return true;
    } catch (error) {
        fail('打开浮窗失败', error);
        return false;
    }
}

/** 把面板搬回侧栏。 */
function closeFloat() {
    try {
        $('#anko_panel').appendTo(PANEL_HOME);
        $(FLOAT_ID).toggle(false);
        floatOpen = false;
        refreshPanel();
        return true;
    } catch (error) {
        fail('收回浮窗失败', error);
        return false;
    }
}

/**
 * 更新浮窗按钮的文案与 tooltip。
 *
 * ⚠️ 两个坑都踩过：
 * ① 以前直接 `$('#anko_float_toggle').text(...)` —— 那会把里面带 `data-i18n` 的
 *    `<span>` **整个节点删掉**，之后切语言再也修不回来。所以只改 span 的文本。
 * ② tooltip 从来不更新：已经挂成浮窗了，鼠标悬停还在教你"怎么变成浮窗"（与实际相反）。
 */
function setFloatButtonLabel(isOpen) {
    const label = isOpen ? '收回侧栏' : '常驻浮窗';
    const title = isOpen
        ? '把面板收回右侧扩展设置里'
        : '把面板搬成屏幕上的常驻浮窗（可拖动），边聊边看骰点日志';
    const toggle = $('#anko_float_toggle');
    if (typeof toggle.attr === 'function') {
        toggle.attr('title', title);
    }
    // ⚠️ 只改里面那个 <span>，**不要**对按钮整体 .text() —— 那会把带 data-i18n 的
    // span 节点整个删掉，之后切语言再也修不回来。用后代选择器，真 jQuery 和测试桩都认。
    const label$ = $('#anko_float_toggle span');
    if (label$.length > 0) {
        label$.text(label);
    } else {
        toggle.text(label);
    }
}

/** 投骰工具现在注册着没（模块态；酒馆核心里同名会覆盖并告警，所以别重复注册）。 */
let diceToolRegistered = false;

/**
 * 裁决"要不要注册投骰工具"，并真的注册/注销。
 *
 * 什么时候要重新裁决：插件启动、来源变了、模型变了、开关被点了 —— 因为
 * `isToolCallingSupported()` 是**按当前 API 来源**判断的（`st-context.js:168`），
 * 换个来源就可能从"支持"变成"不支持"。
 *
 * @param {boolean} [verbose] 状态变化时是否说一声（启动和来源切换时说，重复调用不说）
 * @returns {{supported: boolean, registered: boolean, reason: string}}
 */
function syncDiceTool(verbose = false) {
    const context = ctx();
    const canToggle = typeof context?.registerFunctionTool === 'function'
        && typeof context?.unregisterFunctionTool === 'function';
    const supported = canToggle && canUseDiceTool(context);
    // 开关（面板上的「实验：导演用函数工具投骰」）。
    // ⚠️ 默认 `false`（见 defaultSettings），而且**不是**因为"还没做完"——
    // 是实测过：模型调用工具时上游会返回 `native_finish_reason: "MALFORMED_FUNCTION_CALL"`，
    // 消息 content/reasoning 全空，导演一个字都产不出来 ✓（见规范 §7.0.3）。
    // 现在它是个**用户可开、默认关、面板上有警告**的开关 ✓；
    // 上一版是硬钉 `false` ✗（用户看不见也改不了），那只是止血 ✓。
    const want = Boolean(getSettings().useDiceTool) && supported;

    if (!want) {
        if (diceToolRegistered) {
            try {
                context.unregisterFunctionTool(ROLL_DICE_TOOL_NAME);
            } catch (error) {
                warn('注销投骰工具失败', error);
            }
            diceToolRegistered = false;
        }
        const reason = !canToggle
            ? '这个酒馆版本没暴露 registerFunctionTool'
            : (!getSettings().useDiceTool ? '开关关着' : '当前 API 来源不支持工具调用');
        // 口径跟着工具走：没工具就必须退回文本协议（否则提示词会说"别写表达式"却没人能投骰）
        setDiceMode('text');
        if (verbose) {
            // ⚠️ 用 log 不用 debug：`console.debug` 在 Chrome 默认归到 Verbose、**默认不显示**
            // （本文件 A10 就写着这条，我却给工具注册全用了 debug ✗ —— 于是"插件一言不发"）。
            log(`投骰工具未启用：${reason}（导演提示词走文本协议）`);
        }
        return { supported, registered: false, reason };
    }

    if (diceToolRegistered) {
        return { supported, registered: true, reason: '已经注册着' };
    }

    try {
        context.registerFunctionTool(buildRollDiceTool({
            // 真投骰：走和 /anko roll 同一条引擎路径，保证"命令行投的"和"模型投的"规则一致
            roll: (expression) => rollExpression(expression, { rng: defaultRng }),
            onRoll: ({ label, roll, options }) => {
                rollLog.add(roll, { kind: 'tool', context: `${label ?? '工具投骰'}（模型调用）` });
                log(`工具投骰：${roll.expr}=${roll.total}${options ? `，${options.length} 项选项表` : ''}`);
                refreshPanel();
            },
            // 命中符号跟着面板设置走（可配置、可留空）——和文本协议那边同一个来源
            mark: () => String(getSettings().hitMark ?? ''),
        }));
        diceToolRegistered = true;
        // 提示词口径跟着工具走：注册上了就让导演"调用工具"
        setDiceMode('tool');
        log(`投骰工具已注册（${ROLL_DICE_TOOL_NAME}）→ 导演提示词改用工具口径`);
        // 把**酒馆核心里真实的工具名单**打出来（`ToolManager.tools` 是公开 getter，
        // `tool-calling.js:258`）—— 这样"我的工具到底在不在里面"不用猜，
        // 一眼就能看见（核心里还有 SD 扩展、以及核心自带的工具）。
        try {
            const names = context.ToolManager?.tools?.map((tool) => tool?.name).filter(Boolean) ?? [];
            log(`当前注册的工具表：${names.length ? names.join('、') : '（空）'}`);
        } catch (error) {
            warn('读工具表失败（不影响注册）', error);
        }
        return { supported, registered: true, reason: '刚注册' };
    } catch (error) {
        warn('注册投骰工具失败，这一轮仍走文本协议', error);
        return { supported, registered: false, reason: `注册失败：${error?.message ?? error}` };
    }
}

function toggleFloat() {
    const want = !floatOpen;
    getSettings().panelFloat = want;
    ctx().saveSettingsDebounced();
    const ok = want ? openFloat() : closeFloat();
    if (ok && panelMounted) {
        setFloatButtonLabel(want);
    }
    return { ok, open: floatOpen };
}

/** 按设置把面板摆到该在的地方（挂载/切聊天后都调一次）。 */
function applyFloatState() {
    const want = Boolean(getSettings().panelFloat);
    if (want && !floatOpen) {
        openFloat();
    } else if (!want && floatOpen) {
        closeFloat();
    }
    if (panelMounted) {
        setFloatButtonLabel(floatOpen);
    }
}

// ---------------------------------------------------------------------------
// 导入 / 导出
// ---------------------------------------------------------------------------

const EXPORT_KIND = 'anko-director-export';
const EXPORT_VERSION = 1;

/**
 * 导出设置时**永远排除**的键。
 *
 * `builtinApiKey` 是明文密钥，而导出文件是给人备份/发给别人看的（面板上写的就是
 * "换设备或备份用"）—— 一旦带出去就收不回来。所以宁可让用户在新设备上重填一次。
 */
const SECRET_SETTING_KEYS = new Set(['builtinApiKey']);

const EXPORT_SCOPES = {
    all: '全部（属性 + 预设）',
    attrs: '只导出属性',
    settings: '只导出预设',
};

/**
 * 组装导出内容。
 * @param {'all'|'attrs'|'settings'} scope
 */
function buildExportPayload(scope = 'all') {
    const payload = {
        kind: EXPORT_KIND,
        version: EXPORT_VERSION,
        scope,
        exportedAt: new Date().toISOString(),
    };

    if (scope === 'all' || scope === 'attrs') {
        payload.state = {
            attributes: ankoState.attributes,
            customTables: ankoState.customTables,
            bid: ankoState.bid,
            dead: ankoState.dead,
            deathNote: ankoState.deathNote,
            // 这两个以前漏了：换设备之后战斗中途状态丢失（属性里的 HP 还是被打过的值）、
            // 下一次推演会从头开场（recentOutlines 就是为"连续推演"存在的）。
            combat: ankoState.combat,
            recentOutlines: ankoState.recentOutlines,
        };
    }

    if (scope === 'all' || scope === 'settings') {
        const store = getSettings();
        payload.settings = {};
        for (const key of Object.keys(defaultSettings)) {
            // settingsVersion 不导出（迁移靠本机版本判断）
            // 密钥类**绝不导出**：这个文件是拿去备份/分享的，明文 key 泄出去就收不回来
            if (key === 'settingsVersion' || SECRET_SETTING_KEYS.has(key)) {
                continue;
            }
            payload.settings[key] = store[key];
        }
    }

    return payload;
}

/** 触发浏览器下载；环境不支持就把 JSON 打进控制台（别静默什么都没发生）。 */
function downloadJson(payload, filename) {
    const text = JSON.stringify(payload, null, 2);
    try {
        if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL?.createObjectURL !== 'function') {
            log('这个环境不能下载文件，导出内容打在下面：');
            log(text);
            return { ok: false, why: '这个环境不能下载文件，JSON 已打到控制台（F12 复制）' };
        }
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return { ok: true, text };
    } catch (error) {
        fail('导出下载失败', error);
        log(text);
        return { ok: false, why: `下载失败（${errorMessage(error)}），JSON 已打到控制台` };
    }
}

/**
 * 应用导入的 JSON 文本。
 *
 * 只认本插件导出的东西（带 `kind` 标记），并且**复用 `migrateState` 做校验** ——
 * 外部文件可能被手改坏，宁可丢几项也不要让状态变成脏数据。
 * @param {string} text
 */
function applyImportedJson(text) {
    let payload;
    try {
        payload = JSON.parse(String(text ?? ''));
    } catch (error) {
        return { ok: false, why: `不是合法 JSON：${errorMessage(error)}` };
    }
    if (!payload || typeof payload !== 'object') {
        return { ok: false, why: '内容不是一个对象' };
    }
    if (payload.kind !== EXPORT_KIND) {
        return { ok: false, why: `这不是本插件导出的文件（kind=${payload.kind ?? '缺失'}）` };
    }

    const applied = [];

    if (payload.state && typeof payload.state === 'object') {
        const clean = migrateState({ ...ankoState, ...payload.state });
        ankoState.attributes = clean.attributes;
        ankoState.customTables = clean.customTables;
        ankoState.bid = clean.bid;
        ankoState.dead = clean.dead;
        ankoState.deathNote = clean.deathNote;
        ankoState.combat = clean.combat;
        ankoState.recentOutlines = clean.recentOutlines;
        applied.push(`属性 ${Object.keys(clean.attributes).length} 项`
            + `、自定义表 ${Object.keys(clean.customTables).length} 张`
            + `、安价 ${clean.bid.options.length} 项`
            + `${clean.combat ? '、战斗中途状态' : ''}`
            + `${clean.recentOutlines.length ? `、前情 ${clean.recentOutlines.length} 版` : ''}`);
    }

    if (payload.settings && typeof payload.settings === 'object') {
        const store = getSettings();
        let keys = 0;
        for (const [key, value] of Object.entries(payload.settings)) {
            if (!Object.hasOwn(defaultSettings, key) || key === 'settingsVersion') {
                continue; // 只认已知键，别把乱七八糟的东西塞进设置
            }
            const expected = defaultSettings[key];
            const sameKind = typeof value === typeof expected
                || (expected === null && typeof value === 'object');
            if (!sameKind) {
                continue;
            }
            store[key] = value;
            keys += 1;
        }
        applied.push(`设置 ${keys} 项`);
        ctx().saveSettingsDebounced();
        syncPanelFromSettings();
        applyInjection();
        applyFormatLock();
        applyFloatState();
    }

    if (applied.length === 0) {
        return { ok: false, why: '文件里没有能导入的内容' };
    }

    saveChatState();
    refreshPanel();
    return { ok: true, applied };
}

/** 弹出文件选择器导入（浏览器里才有）。 */
function openImportPicker() {
    if (typeof document === 'undefined') {
        return false;
    }
    try {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('change', () => {
            const file = input.files?.[0];
            if (!file) {
                return;
            }
            const reader = new FileReader();
            reader.onload = () => {
                const result = applyImportedJson(String(reader.result ?? ''));
                if (result.ok) {
                    toastr.success(`已导入：${result.applied.join('；')}`, '安科导游');
                } else {
                    toastr.error(`导入失败：${result.why}`, '安科导游');
                }
            };
            reader.onerror = () => toastr.error('读文件失败', '安科导游');
            reader.readAsText(file);
        });
        input.click();
        return true;
    } catch (error) {
        fail('打开导入选择器失败', error);
        return false;
    }
}

function normalizeScope(raw) {
    const key = String(raw ?? '').trim().toLowerCase();
    if (key === 'attrs' || key === 'attr' || key === '属性') {
        return 'attrs';
    }
    if (key === 'settings' || key === '预设') {
        return 'settings';
    }
    return 'all';
}

/** 面板上那个「范围」下拉现在选的是什么。 */
function panelScope() {
    const value = String($('#anko_io_scope').val() ?? 'all');
    return EXPORT_SCOPES[value] ? value : 'all';
}

// ---------------------------------------------------------------------------
// 面板
// ---------------------------------------------------------------------------

let panelMounted = false;

function extensionVersion() {
    try {
        return ctx().getExtensionManifest?.(MODULE_NAME)?.version ?? '0.0.0';
    } catch {
        return '0.0.0';
    }
}

async function mountPanel() {
    if (panelMounted) {
        return;
    }
    const { renderExtensionTemplateAsync } = ctx();
    const settings = getSettings();
    const html = await renderExtensionTemplateAsync(EXTENSION_PATH, 'settings', {
        maxRounds: settings.maxRounds,
        injectTemplate: settings.injectTemplate,
        hitMark: settings.hitMark,
        version: extensionVersion(),
    });

    if ($('#anko_panel').length > 0) {
        $('#anko_panel').replaceWith(html);
    } else {
        $('#extensions_settings2').append(html);
    }

    panelMounted = true;
    bindPanel();
    syncPanelFromSettings();
    void syncApiSourceOptions();
    // ⚠️ 只在挂载时同步一次是**不够**的 ✗：
    // connection-manager 可能比我们晚就绪 ✓，那样下拉里就永远只有「跟随当前设置」✗
    // → 用户根本选不到连接配置 ✓ → 表现成"预设没用" ✗（这就是本次的真缺陷 ✓）。
    // 三重保险：① 等一下再补一次 ✓ ② 挂酒馆的连接配置事件 ✓ ③ 打开下拉时刷新 ✓
    for (const eventName of [
    ]) {
        try {
            // 优先用枚举 ✓；枚举里没有（老版本/测试桩）就退回酒馆真实的事件串 ✓ ——
            const type = ctx().eventTypes?.[eventName]
                ?? eventName.toLowerCase();
        } catch (error) {
            debug('挂连接配置事件失败：' + eventName, error);
        }
    }
    // 上次是浮窗状态就摆回浮窗里（挂载后要重新搬一次，因为面板是新 DOM）
    applyFloatState();
    refreshPanel();
    log('面板已挂载');
}

function syncPanelFromSettings() {
    const settings = getSettings();
    $('#anko_auto').prop('checked', Boolean(settings.autoDirector));
    $('#anko_direct_send').prop('checked', Boolean(settings.directSend));
    $('#anko_strict').prop('checked', Boolean(settings.strictCausality));
    $('#anko_raw').prop('checked', Boolean(settings.showRawDice));
    $('#anko_prefill').prop('checked', Boolean(settings.usePrefill));
    $('#anko_rounds').val(Number(settings.maxRounds));
    $('#anko_person').val(String(settings.narrationPerson ?? 'auto'));
    $('#anko_world_info').prop('checked', Boolean(settings.worldInfoInBrief));
    // 内置 API
    $('#anko_api_on').prop('checked', Boolean(settings.useBuiltinApi));
    $('#anko_api_kind').val(String(settings.builtinApiKind ?? 'openai'));
    $('#anko_api_base').val(String(settings.builtinApiBase ?? ''));
    $('#anko_api_key').val(String(settings.builtinApiKey ?? ''));
    $('#anko_api_model').val(String(settings.builtinApiModel ?? ''));
    $('#anko_api_temp').val(Number.isFinite(settings.builtinApiTemperature)
        ? String(settings.builtinApiTemperature)
        : '');
    $('#anko_api_maxtok').val(String(Number(settings.builtinApiMaxTokens) || 0));
    // 走酒馆代理的那一条（导演自己的来源/模型）
    $('#anko_api_source').val(String(settings.directorApiSource ?? ''));
    $('#anko_api_model2').val(String(settings.directorApiModel ?? ''));
    // 实验开关：回填真实状态（不这样做的话，用户刷新后看到的是未勾选，
    // 一勾反而把已经开着的功能关掉 ✓ —— 和 #anko_resolve_ai 当初同一个坑）
    $('#anko_dice_tool').prop('checked', Boolean(settings.useDiceTool));
    $('#anko_api_state').text(settings.useBuiltinApi
        ? `（开：${settings.builtinApiKind} / ${settings.builtinApiModel || '没填模型'}）`
        : '（关）');
    $('#anko_inject').val(String(settings.injectTemplate));
    $('#anko_mark').val(String(settings.hitMark));
    $('#anko_format_lock').prop('checked', Boolean(settings.formatLock));
    $('#anko_resolve_ai').prop('checked', Boolean(settings.resolveAiDice));
}

/**
 * 把连接配置填进面板下拉。
 *
 * 异步：`connection-manager` 可能比我们晚就绪，拿不到就只留下「跟随当前设置」，
 * 并在下面给一句提示，别让用户对着空下拉猜。
 */




/** 刷新面板上的状态区（属性/战斗/日志）。 */
/** 面板上那行「状态」：把排障信息放在用户本来就会看的地方。 */
function statusText() {
    const parts = [];
    parts.push(`构建 ${BUILD}`);
    parts.push(commandStats.registered === commandStats.total && commandStats.total > 0
        ? `命令 ${commandStats.registered}/${commandStats.total}`
        : `⚠ 命令只注册上 ${commandStats.registered}/${commandStats.total}`);
    parts.push(listenersRegistered ? '自动推演钩子已挂（MESSAGE_SENT）' : '⚠ 自动推演钩子没挂');
    if (autoTrace.count === 0) {
        parts.push('触发 0 次（刷新后还没发送过消息）');
    } else {
        parts.push(`触发 ${autoTrace.count} 次`);
    }
    parts.push(getSettings().autoDirector ? '开关：开' : '开关：关');
    if (lastBriefChars > 0) {
        parts.push(`上下文简报 ${lastBriefChars} 字`);
    }
    if (lastSendInfo) {
        const f = lastSendInfo.fields ?? {};
        const fmt = (item) => (item && item.value !== null && item.value !== undefined
            ? `${item.value}（${item.from}）`
            : '未发送');
        parts.push(`上次发送 temperature=${fmt(f.temperature)} top_p=${fmt(f.top_p)} max_tokens=${fmt(f.max_tokens)}`);
    }
    if (autoTrace.last) {
        parts.push(`上次判定：${autoTrace.last.decision}`);
    }
    if (commandStats.errors.length > 0) {
        parts.push(`⚠ ${commandStats.errors[0]}`);
    }
    return parts.join('　·　');
}

/** 面板上那行「状态」的详细版（多行，给 tooltip）。 */
function statusDetail() {
    const lines = [
        `构建标记：${BUILD}　（和你手上的时间对不上就是缓存在作怪，Ctrl+Shift+R）`,
        `命令注册：${commandStats.registered}/${commandStats.total}`,
        `当前轮数上限：${getSettings().maxRounds}`,
        getSettings().useBuiltinApi
            ? `导演 API：**内置直连**　${getSettings().builtinApiKind} / ${getSettings().builtinApiModel || '⚠ 没填模型'} / ${getSettings().builtinApiBase || '官方默认地址'}`
            : '导演 API：跟随当前设置（generateQuietPrompt）',
        getSettings().worldInfoInBrief
            ? (lastWorldInfo
                ? (lastWorldInfo.chars > 0
                    ? `世界书：上次取了 ${lastWorldInfo.chars} 字（${lastWorldInfo.entries} 条深度/示例条目，`
                        + `扫了 ${lastWorldInfo.scanned} 条消息）　⚠ 每轮都会重带一遍`
                    : `世界书：**没取到内容**（扫了 ${lastWorldInfo.scanned ?? 0} 条消息、`
                        + `maxContext ${lastWorldInfo.maxContext ?? '?'}）—— ${lastWorldInfo.why ?? '未知原因'}`)
                : '世界书：开着，但还没取过（推演一次就会有数字）')
            : '世界书：**关**（导演看不到世界书，会靠自己编设定）',
        `事件监听器：${listenersRegistered ? '已挂（MESSAGE_SENT）' : '没挂'}`,
        `自动推演开关：${getSettings().autoDirector ? '开' : '关'}`,
        `MESSAGE_SENT 触发次数：${autoTrace.count}`,
    ];
    if (commandStats.errors.length > 0) {
        lines.push('注册失败的命令：', ...commandStats.errors.map((e) => `  · ${e}`));
    }
    if (autoTrace.last) {
        const t = autoTrace.last;
        lines.push(
            '',
            '最近一次钩子触发：',
            `  ${t.at}　消息下标=${t.messageId}`,
            `  当时开关=${t.autoDirector ? '开' : '关'}　chat 长度=${t.chatLength}　这条是用户消息=${t.lastIsUser}`,
            `  判定：${t.decision}`,
        );
    } else {
        lines.push(
            '',
            '钩子从来没被触发过（MESSAGE_SENT 一次都没发到插件）。注意这两种情况不会触发它：',
            '  · 用「重新生成 / 滑动换一个」出正文 —— 那不发 MESSAGE_SENT，只有**真正发送一条消息**才发',
            '  · 用别的扩展自己的发送按钮（绕过了酒馆的发送流程）',
        );
    }
    if (lastSettingsMigration.length > 0) {
        lines.push('', '上次设置迁移做了什么：', ...lastSettingsMigration.map((item) => `  · ${item}`));
    }
    if (lastFilterTrace) {
        lines.push(
            '',
            '格式约束的过滤器上次怎么判的（决定要不要注入）：',
            `  ${lastFilterTrace.at}　开关=${lastFilterTrace.enabled ? '开' : '关'}`
            + `　判定=${lastFilterTrace.result ? '注入' : '不注入'}　原因：${lastFilterTrace.why}`,
        );
    }
    if (lastPromptShape) {
        const lock = lastPromptShape.lock ?? {};
        lines.push(
            '',
            '最近一次即将发出的请求（只读记录）：',
            `  ${lastPromptShape.count} 条：[${lastPromptShape.roles.join(', ')}]`
            + `　最后一条=${lastPromptShape.lastRole}`,
        );
        if (!lock.present) {
            lines.push('  格式约束：**不在提示词里** ← 那"正文没守住格式"就不是模型不听话，而是它压根没收到约束');
        } else {
            const behind = lastPromptShape.count - 1 - lock.index;
            lines.push(
                `  格式约束：**在**（第 ${lock.index + 1}/${lastPromptShape.count} 条，role=${lock.role}，${lock.chars} 字）`
                + (behind === 0
                    ? '　✓ 就在生成点上（模型最后读到的）'
                    : `　⚠ 后面还压着 ${behind} 条消息，约束力会打折`
                        + (lock.role === 'system' ? '（role=system 会被埋进同深度的 system 墙里，应该用 user）' : ''))
                + '　注：Google 系服务端会把中间/末尾的 system 转成 user，属正常',
            );
        }
    }
    if (lastRequestShape) {
        lines.push(
            '',
            '最近一次失败请求的体积：',
            `  第 ${lastRequestShape.round} 轮·第 ${lastRequestShape.attempt} 次`
            + `　提示词 ${lastRequestShape.promptChars} 字`
            + `　prefill ${lastRequestShape.prefillChars ?? 0} 字`,
        );
    }
    return lines.join('\n');
}

function refreshPanel() {
    if (!panelMounted) {
        return;
    }
    $('#anko_attrs').text(formatAttributes(ankoState));
    $('#anko_combat').text(
        ankoState.dead
            ? `☠ 玩家角色已战死${ankoState.deathNote ? `（${ankoState.deathNote}）` : ''}`
            : describeCombat(ankoState.combat),
    );
    $('#anko_log_count').text(`（共 ${rollLog.size()} 条）`);
    $('#anko_log').text(rollLog.formatLast(30));
    $('#anko_status').text(statusText());    $('#anko_status').prop('title', statusDetail());
    $('#anko_status').toggleClass('anko-warn', hasStatusProblem());

    // 上一轮推演留下的警告（认不出选项表 / 还有解析不过去的骰子片段）—— 只在这一行显示，别让它埋在控制台里
    const warnings = lastDirectorRun?.warnings ?? [];
    $('#anko_warn').text(warnings.length > 0
        ? `⚠ ${warnings[warnings.length - 1]}${warnings.length > 1 ? `（本轮共 ${warnings.length} 条，详见控制台）` : ''}`
        : '');
    $('#anko_warn').toggle(warnings.length > 0);
}

/** 状态行有没有需要用户注意的问题（有就把那一行标红）。 */
function hasStatusProblem() {
    if (commandStats.registered !== commandStats.total || commandStats.total === 0) {
        return true;
    }
    if (!listenersRegistered) {
        return true;
    }
    return isDisabledByUser();
}

/**
 * 撤回上一幕：把最新那版大纲从「前情」里去掉，并把再上一版放回输入框。
 *
 * 为什么需要：一轮推演可能跑偏（模型发挥失常、或者你自己想换个方向），
 * 而大纲一旦写进输入框、你又发送了，就没有"上一版"了。
 * 前情里存着最近 3 版，正好够回退一步。
 */
function rollbackOutline() {
    const list = ankoState.recentOutlines ?? [];
    if (list.length === 0) {
        return { ok: false, why: '前情里还没有大纲可撤回' };
    }
    const removed = list.pop();
    const restored = list[list.length - 1] ?? '';
    saveChatState();
    if (restored) {
        writeToInput(restored);
    }
    refreshPanel();
    return { ok: true, removed, restored, left: list.length };
}

function setProgress(text) {
    if (panelMounted) {
        $('#anko_progress').text(text);
    }
}

function bindPanel() {
    const persist = () => {
        saveChatState();
    };

    /** 面板按钮执行一条命令（输出由 guard 统一显示，这里只管报错）。 */
    const runAndToast = async (fn, label) => {
        try {
            await fn();
        } catch (error) {
            fail(label, error);
            toastr.error(errorMessage(error), '安科导游');
        }
    };

    $('#anko_continue').on('click', () => {
        void runAndToast(() => cmdContinue({}, ''), '续推失败');
    });
    $('#anko_prev').on('click', () => {
        void runAndToast(() => cmdPrev({}, ''), '撤回失败');
    });
    $('#anko_resolve_ai').on('input', (event) => {
        getSettings().resolveAiDice = Boolean($(event.target).prop('checked'));
        ctx().saveSettingsDebounced();
    });

    $('#anko_float_toggle').on('click', () => {
        void runAndToast(() => cmdFloat({}, ''), '切换浮窗失败');
    });
    $('#anko_io_export').on('click', () => {
        void runAndToast(() => cmdExport({}, ''), '导出失败');
    });
    $('#anko_io_import').on('click', () => {
        void runAndToast(() => cmdImport({}, ''), '导入失败');
    });

    $('#anko_auto').on('input', (event) => {
        getSettings().autoDirector = Boolean($(event.target).prop('checked'));
        ctx().saveSettingsDebounced();
    });
    $('#anko_direct_send').on('input', (event) => {
        getSettings().directSend = Boolean($(event.target).prop('checked'));
        ctx().saveSettingsDebounced();
    });
    $('#anko_strict').on('input', (event) => {
        getSettings().strictCausality = Boolean($(event.target).prop('checked'));
        ctx().saveSettingsDebounced();
    });
    $('#anko_raw').on('input', (event) => {
        getSettings().showRawDice = Boolean($(event.target).prop('checked'));
        ctx().saveSettingsDebounced();
    });
    $('#anko_prefill').on('input', (event) => {
        getSettings().usePrefill = Boolean($(event.target).prop('checked'));
        ctx().saveSettingsDebounced();
    });
    $('#anko_rounds').on('input', (event) => {
        const value = Math.trunc(Number($(event.target).val()));
        getSettings().maxRounds = Number.isFinite(value) ? Math.max(1, Math.min(50, value)) : defaultSettings.maxRounds;
        ctx().saveSettingsDebounced();
    });
    $('#anko_inject').on('input', (event) => {
        getSettings().injectTemplate = String($(event.target).val());
        ctx().saveSettingsDebounced();
        applyInjection();
    });
    $('#anko_person').on('input', (event) => {
        getSettings().narrationPerson = String($(event.target).val() ?? 'auto');
        ctx().saveSettingsDebounced();
    });
    $('#anko_world_info').on('input', (event) => {
        getSettings().worldInfoInBrief = Boolean($(event.target).prop('checked'));
        ctx().saveSettingsDebounced();
    });

    // ---- 导演自己的 API 来源（走酒馆服务端代理：同源、无 CORS、密钥用酒馆的）----
    $('#anko_api_source').on('input', (event) => {
        getSettings().directorApiSource = String($(event.target).val() ?? '');
        ctx().saveSettingsDebounced();
    });
    $('#anko_api_model2').on('input', (event) => {
        getSettings().directorApiModel = String($(event.target).val() ?? '').trim();
        ctx().saveSettingsDebounced();
    });

    // 酒馆预设：下拉切换 + 导入 + 导出（照别的插件的写法 ✓）
    // 打开下拉时刷新列表 ✓（酒馆的预设列表可能中途增减 ✓）
    $('#anko_preset_select').on('focus', () => { refreshPresetSelect(); });
    // ⚠️ 下拉只在**点「应用」**时才真正切换 ✓ —— 用户明确不接受"选一下就改掉我酒馆的预设" ✗。
    // 下拉只在**我们自己的设置**里记名字 ✓ —— **绝不调 selectPreset** ✗（那会改你酒馆的预设 ✗）。
    $('#anko_preset_select').on('change', (event) => {
        const raw = typeof event?.target?.val === 'function' ? event.target.val() : $(event.target).val();
        getSettings().directorPresetName = String(raw ?? '');
        ctx().saveSettingsDebounced();
        presetMsg(raw
            ? `导演将用预设「${raw}」的口径 ✓（不改你酒馆的当前预设 ✓）`
            : '导演跟随当前预设 ✓');
    });
    $('#anko_preset_import').on('click', () => {
        const input = $('#anko_preset_file')[0];
        if (input && typeof input.click === 'function') {
            input.click();
        } else {
            presetMsg('这个环境不能弹文件选择框 ✗', true);
        }
    });
    $('#anko_preset_file').on('change', () => {
        const picked = $('#anko_preset_file')[0]?.files?.[0];
        if (picked) {
            void importPresetToSt(picked);
        }
    });
    $('#anko_preset_export').on('click', () => { exportCurrentPreset(); });
    void refreshPresetSelect();
    $('#anko_api_source_test').on('click', () => {
        void testDirectorApiSource();
    });
    // 「实验：导演用函数工具投骰」——点一下立刻生效/失效，并把原因写进 console ✓
    $('#anko_dice_tool').on('input', (event) => {
        getSettings().useDiceTool = Boolean($(event.target).prop('checked'));
        ctx().saveSettingsDebounced();
        const state = syncDiceTool(true);
        log(state.registered
            ? '投骰工具：已开启 ✓'
            : `投骰工具：没开启（${state.reason}）`);
    });

    // ---- 内置直连（留的口子：不走酒馆服务端，会撞 CORS）----
    $('#anko_api_on').on('input', (event) => {
        getSettings().useBuiltinApi = Boolean($(event.target).prop('checked'));
        ctx().saveSettingsDebounced();
        $('#anko_api_state').text(getSettings().useBuiltinApi
            ? `（开：${getSettings().builtinApiKind} / ${getSettings().builtinApiModel || '没填模型'}）`
            : '（关）');
        refreshPanel();
    });
    $('#anko_api_kind').on('input', (event) => {
        getSettings().builtinApiKind = String($(event.target).val() ?? 'openai');
        ctx().saveSettingsDebounced();
    });
    $('#anko_api_base').on('input', (event) => {
        getSettings().builtinApiBase = String($(event.target).val() ?? '').trim();
        ctx().saveSettingsDebounced();
    });
    $('#anko_api_key').on('input', (event) => {
        getSettings().builtinApiKey = String($(event.target).val() ?? '');
        ctx().saveSettingsDebounced();
    });
    $('#anko_api_model').on('input', (event) => {
        getSettings().builtinApiModel = String($(event.target).val() ?? '').trim();
        ctx().saveSettingsDebounced();
    });
    $('#anko_api_temp').on('input', (event) => {
        const raw = String($(event.target).val() ?? '').trim();
        const value = Number(raw);
        // 留空 = 不传，让接口用自己的默认温度
        getSettings().builtinApiTemperature = raw === '' || !Number.isFinite(value) ? null : value;
        ctx().saveSettingsDebounced();
    });
    $('#anko_api_maxtok').on('input', (event) => {
        const value = Math.trunc(Number($(event.target).val()));
        getSettings().builtinApiMaxTokens = Number.isFinite(value) && value > 0 ? value : 0;
        ctx().saveSettingsDebounced();
    });
    $('#anko_api_test').on('click', () => {
        void testBuiltinApi();
    });
    $('#anko_mark').on('input', (event) => {
        getSettings().hitMark = String($(event.target).val());
        ctx().saveSettingsDebounced();
    });
    $('#anko_format_lock').on('input', (event) => {
        getSettings().formatLock = Boolean($(event.target).prop('checked'));
        ctx().saveSettingsDebounced();
        applyFormatLock();
    });

    $('#anko_run').on('click', () => void handleDirectorButton());
    $('#anko_bid_draw').on('click', () => {
        try {
            toastr.info(doBidDraw(), '安价');
        } catch (error) {
            toastr.error(errorMessage(error), '安价');
        }
        persist();
    });
    $('#anko_sheet').on('click', () => {
        // 隔壁 #anko_bid_draw 一直都包了 try/catch；这里以前没有 ——
        // 一旦 doSheet 抛错，用户看到的就是"点了没反应"（只有控制台有栈）。
        // 而且车卡是多行输出，走 toastr 会被截断，所以和命令路径一样用 showCommandOutput。
        try {
            persist();
            showCommandOutput(doSheet());
        } catch (error) {
            fail('车卡失败', error);
            toastr.error(errorMessage(error), '安科导游');
        }
    });
    $('#anko_log_refresh').on('click', () => refreshPanel());
    $('#anko_log_clear').on('click', () => {
        rollLog.clear();
        refreshPanel();
        persist();
    });

    // 1.14.0 的加载遮罩没有停止键，所以中止全靠这个按钮
    $('#anko_stop').on('click', () => {
        abortRequested = true;
        setProgress('正在停止…（已经写好的部分会保留）');
    });
    $('#anko_stop').toggle(false);
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const errorMessage = (error) => (error instanceof DiceError ? error.message : String(error?.message ?? error));

/**
 * 这条错误是不是"上游按内容安全策略拦了" ✓。
 *
 * 依据：`PROHIBITED_CONTENT` 是 **Google 自己的 finishReason / blockReason** ✓，
 * 不是酒馆写的 ✗（酒馆源码里搜不到这个词 ✓）、也不是我们写的 ✗。
 * 而且酒馆已经把四类安全阈值全设成 `OFF` ✓（`src/constants.js` 的 `GEMINI_SAFETY` ✓）
 * —— 所以这类拦截**不是调阈值能解决的** ✗，只能换模型/来源/内容 ✓。
 *
 * 识别它只为一件事：**别做无意义的重试和回退** ✗（同模型同内容一定还被拦 ✗）。
 */
const isPolicyBlocked = (text) => /PROHIBITED_CONTENT|blocked the request|blockReason|SAFETY/i.test(String(text ?? ''));

/** 极小的 HTML 转义（弹窗里要放用户内容，不能直接插）。 */
function escapeHtmlText(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * 把命令的输出**显示出来**。
 *
 * 为什么必须自己做：酒馆**不显示**斜杠命令的返回值 ——
 * `processCommands()` 调完 `executeSlashCommandsOnChatInput({clearChatInput:true})`
 * 就 `return true`（`script.js:2877`），而后者执行完只是 `return result`
 * （`slash-commands.js:5452`），**只有抛错才会 toastr**。
 * 所以我们以前那些命令是"跑了、也有输出、但谁也看不见" ——
 * 用户报过"`/anko debug` 打出来什么都没有"，根因就在这里。
 *
 * 短的就 toastr，长的（多行/长文本）弹窗 —— 弹窗能滚动能复制，比 toastr 截断强。
 */
function showCommandOutput(text) {
    const body = String(text ?? '').trim();
    if (!body) {
        return;
    }
    if (body.length <= 160 && !body.includes('\n')) {
        toastr.info(body, '安科导游');
        return;
    }
    try {
        const { callGenericPopup, POPUP_TYPE } = ctx();
        if (typeof callGenericPopup !== 'function') {
            throw new Error('这个版本没有 callGenericPopup');
        }
        void callGenericPopup(
            `<pre style="white-space:pre-wrap;word-break:break-word;text-align:left;margin:0;">${escapeHtmlText(body)}</pre>`,
            POPUP_TYPE?.TEXT ?? 1,
            '安科导游',
            { allowVerticalScrolling: true, wide: true },
        );
    } catch (error) {
        // 弹窗不可用就退回 toastr + 控制台，至少能看见
        toastr.info(`${body.slice(0, 300)}${body.length > 300 ? '…（完整内容见控制台）' : ''}`, '安科导游');
        log(body);
    }
}

/**
 * 包一层错误处理：骰子错误变成一句中文，而不是一堆栈。
 *
 * ⚠️ **这里故意不显示输出** —— 显示交给 `displayed()` 在**注册时**包一层。
 *
 * 为什么这么拆：子命令（`cmdDirector`/`cmdRoll`…）既被 `/anko roll` 这样转发调用，
 * 又被注册成独立的 `/anko-roll`。如果 `guard` 自己显示，那么 `/anko roll` 会
 * **先由内层 guard 显示一次、再由外层 cmdAnko 的 guard 显示第二次** ——
 * 用户看到两条一模一样的 toastr / 两个要关两次的弹窗（真实踩到过）。
 * 拆开之后：内部转发不显示，注册出去的那一层显示，**两条入口都恰好显示一次**。
 */
function guard(handler) {
    return (namedArguments, unnamedArguments) => {
        try {
            return handler(namedArguments ?? {}, unnamedArguments, rawArgs(unnamedArguments));
        } catch (error) {
            if (error instanceof DiceError) {
                return `操作失败：${error.message}`;
            }
            fail('命令执行出错', error);
            return `出错了：${errorMessage(error)}`;
        }
    };
}

/** 在**注册**时包一层：把命令返回的文本显示出来（见 `guard` 的注释）。 */
function displayed(handler) {
    const show = (value) => {
        if (typeof value === 'string' && value.trim()) {
            showCommandOutput(value);
        }
        return value;
    };
    return (namedArguments, unnamedArguments) => {
        try {
            const result = handler(namedArguments, unnamedArguments);
            if (result && typeof result.then === 'function') {
                return result.then(show, (error) => {
                    fail('命令执行出错', error);
                    return show(`出错了：${errorMessage(error)}`);
                });
            }
            return show(result);
        } catch (error) {
            fail('命令执行出错', error);
            return show(`出错了：${errorMessage(error)}`);
        }
    };
}

function rawArgs(unnamedArguments) {
    if (unnamedArguments === null || unnamedArguments === undefined) {
        return '';
    }
    if (typeof unnamedArguments === 'string') {
        return unnamedArguments;
    }
    if (Array.isArray(unnamedArguments)) {
        return unnamedArguments.map((v) => String(v ?? '')).join(' ').trim();
    }
    if (typeof unnamedArguments === 'object') {
        return Object.values(unnamedArguments).map((v) => String(v ?? '')).join(' ').trim();
    }
    return String(unnamedArguments).trim();
}

const tokenize = (raw) => String(raw ?? '').split(/\s+/).filter((s) => s.length > 0);

/** 读输入框内容。 */
function readInput() {
    return String($('#send_textarea').val() ?? '');
}

/** 把大纲写进输入框。 */
function writeToInput(text) {
    const $area = $('#send_textarea');
    if ($area.length === 0) {
        warn('找不到 #send_textarea，无法写入输入框');
        return false;
    }
    $area.val(text).trigger('input');
    return true;
}

/** 直接发送（点发送按钮）。 */
function sendNow() {
    const $button = $('#send_but');
    if ($button.length === 0) {
        warn('找不到 #send_but，无法直接发送');
        return false;
    }
    $button.trigger('click');
    return true;
}

/** 拿一个 loader 句柄（拿不到就返回空实现，别让扩展崩）。 */

// ---------------------------------------------------------------------------
// 核心操作：投骰类
// ---------------------------------------------------------------------------

function doRoll(expr, context = '') {
    const roll = rollExpression(expr, { rng: defaultRng });
    rollLog.add(roll, { kind: 'roll', context });

    const lines = [`${roll.expr} = ${roll.total}`];
    if (roll.detail !== String(roll.total)) {
        lines.push(`      ${roll.detail}`);
    }
    if (getSettings().showRawDice && roll.dice.length > 0) {
        lines.push(`      原始点数：[${roll.dice.join(', ')}]`);
    }
    return lines.join('\n');
}

function doCheck(name, rate, context = '') {
    const roll = rollCheck({ rate, name, rng: defaultRng });
    rollLog.add(roll, { kind: 'check', context });

    const lines = [`${name}${rate} 检定：1d100 = ${roll.total} → ${roll.label}`];
    if (getSettings().showRawDice) {
        lines.push(`      原始点数：[${roll.dice.join(', ')}]`);
    }
    lines.push(`      内联回执：${formatCheckReplacement(roll)}`);
    return lines.join('\n');
}

function doOption(optionCount, context = '') {
    const result = rollKongming({ optionCount, rng: defaultRng, resolveEffect: true });
    rollLog.add(result, { kind: 'kongming', context });

    return [
        `选项骰 ${optionCount} 项`,
        `      ${formatKongmingReplacement(result.chain)}`,
        `      结论：${result.label}`,
    ].join('\n');
}

/**
 * 结算一段文本里的内联骰子，并给选项表打命中标。
 *
 * `/anko-inline` 和「结算正文 AI 写的骰子」共用这一份 —— 免得两处逻辑慢慢跑偏。
 *
 * @param {string} text
 * @param {string} [context] 写进骰点日志的上下文标签
 * @returns {{text: string, count: number, marked: number, invalid: Array, results: Array}}
 */
function resolveDiceInText(text, context = '内联') {
    const invalid = findInvalidDiceLike(text);
    const { text: settled, results } = resolveDiceUnits(text, (unit) => {
        const outcome = resolveDiceUnitForInline(unit);
        rollLog.add(outcome.roll, { kind: outcome.roll.kind, context });
        return { replacement: outcome.replacement, roll: outcome.roll };
    });

    // 算出每个结果在**替换之后**的正文里的位置，好给选项表打命中标
    const optionHits = [];
    let delta = 0;
    for (const item of results) {
        const at = item.unit.start + delta;
        delta += item.replacement.length - (item.unit.end - item.unit.start);
        if (item.roll?.kind === 'kongming' && Number.isFinite(item.roll.dice?.[0])) {
            optionHits.push({ replacement: item.replacement, value: item.roll.dice[0], at });
        }
    }

    const marked = markOptionHits(settled, optionHits, { mark: String(getSettings().hitMark ?? '') });

    return {
        text: marked.text,
        count: results.length,
        marked: marked.marked,
        invalid,
        results,
    };
}

function doInline(text) {
    if (!text.trim()) {
        return '用法：/anko-inline 水路走了1d3天，又投1d100';
    }
    const resolved = resolveDiceInText(text, '内联');

    const lines = [resolved.text, '', `—— 结算了 ${resolved.count} 个骰子 ——`];
    for (const item of resolved.results) {
        lines.push(`   ${item.replacement}   原始点数[${item.roll.dice?.join(', ') ?? ''}]`);
    }
    if (resolved.marked > 0) {
        lines.push(`   已在 ${resolved.marked} 张选项表上标出命中行`);
    }
    if (resolved.invalid.length > 0) {
        lines.push(`⚠ 有 ${resolved.invalid.length} 段像骰子但解析不过去：`
            + `${resolved.invalid.map((x) => x.raw).join('、')}`);
    }
    return lines.join('\n');
}

/**
 * 内联命令用的结算（不走 director 的注解降级逻辑，直接照注解走）。
 * @param {object} unit
 */
function resolveDiceUnitForInline(unit) {
    const annotation = unit.annotation;

    if (annotation?.kind === 'option') {
        const faces = /^\s*1\s*[dD]\s*(\d+)\s*$/.exec(unit.expr)?.[1];
        if (faces) {
            const result = rollKongming({ optionCount: Number(faces), rng: defaultRng, resolveEffect: true });
            return {
                replacement: formatKongmingReplacement(result.chain),
                roll: {
                    kind: 'kongming',
                    expr: unit.expr,
                    total: result.chain[result.chain.length - 1].value,
                    detail: result.chain.map((c) => `${c.expr}=${c.value}`).join(' → '),
                    dice: result.chain.map((c) => c.value),
                    label: result.label,
                },
            };
        }
    }

    if (annotation?.kind === 'check' && unit.expr.replace(/\s+/g, '').toLowerCase() === '1d100') {
        const roll = rollCheck({ rate: annotation.rate, name: annotation.name, expr: unit.expr, rng: defaultRng });
        return { replacement: formatCheckReplacement(roll), roll: { ...roll, kind: 'check' } };
    }

    const roll = rollExpression(unit.expr, { rng: defaultRng });
    return { replacement: formatRoll(unit.expr, roll.total), roll: { ...roll, kind: 'roll' } };
}

// ---------------------------------------------------------------------------
// 核心操作：导演循环（M2）
// ---------------------------------------------------------------------------

/** 自动推演时的重入保护 —— 否则会在生成回调里再触发一次。 */
let directorBusy = false;

/** 用户按了「停止」。 */
let abortRequested = false;

/**
 * 当前聊天 id（用来发现"推演期间被切走了"）。
 * 群聊/未保存的新聊天可能拿不到 id —— 那就返回空串，判断退化成"没变"，不会误报。
 */
function currentChatId() {
    try {
        const c = ctx();
        const id = typeof c.getCurrentChatId === 'function' ? c.getCurrentChatId() : c.chatId;
        return String(id ?? '');
    } catch {
        return '';
    }
}

/**
 * 这个扩展是不是已经被用户禁用了。
 *
 * 为什么需要：**1.14.0 完全忽略 `manifest.hooks`**（实测 `extensions.js` 里搜不到
 * `callExtensionHook` / `manifest.hooks`），所以 `onDisable` 钩子根本不会响 ——
 * 我的监听器、注入、面板都不会被清理。酒馆 UI 默认在启用/禁用后 `location.reload()`，
 * 所以正常路径上会被刷新清掉；但走 API 禁用（`reload: false`）时不会。
 * 规范 C7/B10 的建议就是「读路径上也要能判断我已被禁用」—— 这里就是那个判断。
 */
function isDisabledByUser() {
    try {
        const list = ctx().extensionSettings?.disabledExtensions;
        return Array.isArray(list) && list.includes(EXTENSION_PATH);
    } catch {
        return false;
    }
}

/** 最近一次推演的结果摘要，给 `/anko last` 排障用。 */
let lastDirectorRun = null;

/**
 * 聊天纪元：每次 `CHAT_CHANGED` 递增。
 *
 * 用来判断"这次推演中途是不是切走过" —— 只比 chatId 会漏（见 `chatSwitched` 的注释）。
 */
let chatEpoch = 0;

/** 最近一次失败请求的体积，排除"太长被拒"用。 */
let lastRequestShape = null;

/**
 * 最近一次**即将发出的**请求的消息角色结构。
 *
 * 为什么需要它：Gemini 报 `Requests ending with a model turn are not supported`，
 * 意思就是"请求最后一条是 assistant"。可这个 assistant 是**谁加的**、到底有没有，
 * 光看错误文本判断不出来（我猜过是 `prefill`，用户说开关是关的 —— 猜错了）。
 *
 * `generateRaw` 在真正发请求前会 `emit(CHAT_COMPLETION_PROMPT_READY, { chat })`，
 * 那个 `chat` 就是最终消息数组。把它记下来就有了硬证据：
 * 最后一条是什么角色、数组里都有哪些角色。
 */
let lastPromptShape = null;

/** 格式约束文本的特征片段 —— 用来在最终请求里找它到底在不在。 */
const FORMAT_LOCK_MARKER = '【格式约束';

function recordPromptShape(eventData) {
    try {
        const chat = Array.isArray(eventData?.chat) ? eventData.chat : null;
        if (!chat || chat.length === 0) {
            return;
        }
        // 顺手查一下：我注入的格式约束有没有活着到最终请求里、在第几条、什么角色。
        // 别的扩展完全可以在同一个事件里重建数组把它冲掉 —— 那就得看得见。
        const lockIndex = chat.findIndex((message) => String(message?.content ?? '').includes(FORMAT_LOCK_MARKER));
        lastPromptShape = {
            at: new Date().toLocaleTimeString(),
            count: chat.length,
            roles: chat.map((message) => String(message?.role ?? '?')),
            lastRole: String(chat[chat.length - 1]?.role ?? '?'),
            lock: {
                present: lockIndex >= 0,
                index: lockIndex,
                role: lockIndex >= 0 ? String(chat[lockIndex]?.role ?? '?') : '',
                chars: lockIndex >= 0 ? String(chat[lockIndex]?.content ?? '').length : 0,
            },
        };
    } catch (error) {
        // 只做记录，绝不因为它打断别人的生成
        debug('记录请求结构时出错（已忽略）', error);
    }
}

/** 监听器是否挂上了（排障用）。 */
let listenersRegistered = false;

/**
 * 自动推演钩子的运行痕迹。
 *
 * 只记录、不改变任何行为。存在的理由：自动推演"没效果"有三种完全不同的原因 ——
 *   ① 钩子根本没触发（事件没发 / 监听器没挂上）
 *   ② 触发了但被守卫挡掉（开关没开、type 不对……）
 *   ③ 通过了、推演跑了、但产出是空的
 * 光看现象分不出是哪种，`/anko debug` 能一眼看出。
 */
const autoTrace = { count: 0, last: null };

/**
 * 命令注册结果 —— 会**显示在面板上**，因为"命令打出来什么都没有"这种情况，
 * 用户看不到控制台就没法区分"命令没注册"和"命令跑了但没输出"。
 */
const commandStats = { registered: 0, total: 0, errors: [] };

/** 开关面板上的按钮状态。 */
function setRunning(running) {
    directorBusy = running;
    if (panelMounted) {
        $('#anko_stop').toggle(running);
        $('#anko_run').toggle(!running);
    }
}

/**
 * 拿一个加载遮罩句柄。
 *
 * ⚠️ 1.14.0 **没有** `getContext().loader`（那是后来才有的 action-loader），
 * 所以这里必须回退到已废弃的 `showLoader()` / `hideLoader()`，
 * 否则会静默降级成"什么提示都没有"，多轮推演看起来像卡死。
 * 中止一律靠面板上的「停止」按钮（`abortRequested`），不依赖遮罩自带的停止键。
 */
function openLoader(message) {
    try {
        const { loader, showLoader } = ctx();
        if (loader?.show) {
            return loader.show({ message, onStop: () => { abortRequested = true; } });
        }
        if (typeof showLoader === 'function') {
            showLoader();
            return {
                hide: async () => {
                    const { hideLoader } = ctx();
                    if (typeof hideLoader === 'function') {
                        hideLoader();
                    }
                },
            };
        }
    } catch (error) {
        warn('打开加载遮罩失败（继续执行）', error);
    }
    warn('这个酒馆版本没有可用的加载遮罩，推演期间请看面板上的进度');
    return { hide: async () => {} };
}

/** 有没有可以接着推的前情。 */
function hasStoryMemory() {
    if ((ankoState.recentOutlines ?? []).length > 0) {
        return true;
    }
    return (ctx().chat ?? []).length > 0;
}

/**
 * 拼给模型看的「前情」。
 *
 * 只带**还没进聊天记录**的那几份大纲 —— 已经发送出去的那些，聊天记录里本来就有，
 * 再喂一遍既浪费 token，又会让模型更爱复述。
 */
function storySoFarText() {
    const chat = ctx().chat;
    const recent = Array.isArray(chat) ? chat.slice(-10).map((m) => String(m?.mes ?? '')) : [];
    const pending = (ankoState.recentOutlines ?? []).filter((text) => {
        const head = String(text).slice(0, 24);
        return head.length > 8 && !recent.some((mes) => mes.includes(head));
    });
    return formatOutlines({ recentOutlines: pending });
}

/** 组装给导演看的上下文简报。 */
async function currentContextBrief() {
    const c = ctx();
    const characterId = c.characterId;
    const character = Number.isInteger(characterId) ? c.characters?.[characterId] : null;

    return buildContextBrief({
        characterName: c.name2 ?? '',
        personaName: c.name1 ?? '',
        characterDescription: character?.description ?? character?.data?.description ?? '',
        scenario: c.chatMetadata?.scenario ?? '',
        // ⚠️ 原来只给最后 **6 条**、每条截 400 字 ✗ —— 对话一长，导演就"看不到上下文" ✗
        // （用户报的原话 ✓）。用户一贯的选择是"整份塞、不截断"（世界书那条）✓，
        // 所以放宽到 20 条 / 每条 1200 字 ✓；数值写在参数里，方便以后调 ✓。
        recentMessages: (c.chat ?? []).slice(-20).map((m) => ({
            name: m?.name,
            mes: m?.mes,
            isUser: Boolean(m?.is_user),
        })),
        maxRecent: 20,
        maxMessageChars: 1200,
        attributes: ankoState.attributes,
        combat: ankoState.combat && !ankoState.combat.finished ? ankoState.combat : null,
        dead: ankoState.dead,
        deathNote: ankoState.deathNote,
        storySoFar: storySoFarText(),
        worldInfo: getSettings().worldInfoInBrief ? await collectWorldInfo() : null,
    });
}

/**
 * 取当前**激活的**世界书内容，给导演看。
 *
 * 为什么导演默认看不到世界书：`generateRaw` 自己拼 raw prompt，**不跑主提示词组装** ——
 * 世界书正是在那一步（`script.js:4244` 的 `getWorldInfoPrompt`）扫码注入的。
 * 而走连接配置那条路也不带（`custom-request.js` 里完全没有 world info 代码）。
 * 所以想要导演懂设定，只能我们自己取一份塞进上下文简报。
 *
 * ⚠️ 三个"少一样就扫不出东西"的点（都是踩过才知道的，对照 `script.js:4233-4243`）：
 *
 * ① `dryRun = true` **必须** —— 扫一次不会动粘性/冷却状态（`world-info.js:861` 只有
 *    `!isDryRun` 时才记激活），否则推演 12 轮会把条目"用掉"。
 * ② 传给它的聊天数组必须是**字符串数组**（`名字: 正文`），**而且要 `reverse()` 成从新到旧**
 *    —— 世界书就是按"从新到旧"分配预算的。我第一次传的是 `ctx().chat`（消息对象、从旧到新），
 *    结果永远扫出 0 条（用户看到「世界书：上次取了 0 字」）。
 * ③ 第 4 个参数 `globalScanData` 必须带上角色/玩家/场景，否则 `matchPersonaDescription`、
 *    `matchScenario` 这类条件全部匹配不上。
 *
 * @returns {Promise<{text: string, chars: number, entries: number}|null>}
 */
async function collectWorldInfo() {
    try {
        const c = ctx();
        const { getWorldInfoPrompt } = c;
        if (typeof getWorldInfoPrompt !== 'function') {
            debug('这个酒馆版本没暴露 getWorldInfoPrompt，跳过世界书');
            lastWorldInfo = { at: new Date().toLocaleTimeString(), chars: 0, entries: 0, scanned: 0, why: '这个版本没暴露 getWorldInfoPrompt' };
            return null;
        }

        const character = Number.isInteger(c.characterId) ? c.characters?.[c.characterId] : null;
        // 见上面 ② ：字符串数组 + 从新到旧
        const chat = (Array.isArray(c.chat) ? c.chat : [])
            .map((message) => `${message?.name ?? ''}: ${message?.mes ?? ''}`)
            .reverse();
        const maxContext = Number(c.maxContext) || 4096;
        const globalScanData = {
            personaDescription: personaDescriptionOf(c),
            characterDescription: character?.description ?? character?.data?.description ?? '',
            characterPersonality: character?.personality ?? '',
            characterDepthPrompt: character?.data?.extensions?.depth_prompt?.prompt ?? '',
            scenario: character?.scenario ?? c.chatMetadata?.scenario ?? '',
            creatorNotes: character?.creator_notes ?? character?.data?.creator_notes ?? '',
            // 'normal' 是有意的：让导演看到"正常续写这局会看到的世界书"
            trigger: 'normal',
        };
        const result = await getWorldInfoPrompt(chat, maxContext, true, globalScanData);

        const parts = [];
        if (result?.worldInfoString) {
            parts.push(String(result.worldInfoString).trim());
        }
        // @D 深度条目不在 worldInfoString 里（world-info.js:854-859），要单独收
        const depth = Array.isArray(result?.worldInfoDepth) ? result.worldInfoDepth : [];
        for (const entry of depth) {
            const text = String(entry?.content ?? entry?.string ?? '').trim();
            if (text) {
                parts.push(text);
            }
        }
        // 示例对话单独标一下：它是对话样例，不是设定正文，免得导演把它当既成事实
        const examples = Array.isArray(result?.worldInfoExamples) ? result.worldInfoExamples : [];
        const exampleTexts = examples
            .map((entry) => String(entry?.content ?? entry?.string ?? '').trim())
            .filter(Boolean);
        if (exampleTexts.length > 0) {
            parts.push('（以下是世界书里的**示例对话**，只作语气参考，不是已经发生过的剧情）',
                ...exampleTexts);
        }

        const text = parts.filter(Boolean).join('\n\n').trim();
        lastWorldInfo = {
            at: new Date().toLocaleTimeString(),
            chars: text.length,
            entries: depth.length + examples.length,
            scanned: chat.length,
            maxContext,
            stringChars: String(result?.worldInfoString ?? '').length,
            why: text ? '' : '这本聊天没有激活任何世界书条目（没绑定世界书，或条目的关键词没在最近消息里命中）',
        };
        if (!text) {
            return null;
        }
        return { text, chars: text.length, entries: lastWorldInfo.entries };
    } catch (error) {
        warn('取世界书失败（这一轮当没有世界书处理）', error);
        lastWorldInfo = { at: new Date().toLocaleTimeString(), chars: 0, entries: 0, error: errorMessage(error) };
        return null;
    }
}

/** 最近一次取到的世界书规模（排障/看 token 用）。 */
let lastWorldInfo = null;

/**
 * 上一次推演时"上下文简报"有多少字 ✓。
 *
 * 为什么需要：用户报"导演看不到上下文" ✗ —— 而这个症状有两种完全不同的原因：
 *   ① 简报**没取到**（0 字）✗   ② 取到了但**太少**（只 6 条、每条 400 字）✗
 * 有一行数字就能立刻分辨 ✓，不用猜 ✗。
 */
let lastBriefChars = 0;

/**
 * 上一次请求**实际发送的采样参数**，以及每个值的来源 ✓。
 *
 * 为什么需要：用户看到 `temperature: 1.08 / top_p: 0.98 / max_tokens: 65535`
 * 反问"这是预设？这压根不是预设" ✗ —— 光看请求日志**分不清**
 * 哪个值来自预设 ✗、哪个是酒馆默认 ✗、哪个是面板 ✗。
 * 所以这里逐项记下来源（预设「名字」/ 面板 / 镜像酒馆额度）✓，并显示在面板上 ✓。
 */
let lastSendInfo = null;
let lastPresetGuidanceFrom = '';

/** 导演推演期间为 true —— 口径注入的 filter 靠它判断（平时不注入 ✓）。 */
let directorPresetGuidanceActive = false;

/**
 * 从 `powerUserSettings` 里挖出当前人设的描述。
 *
 * 结构是 `personas[人设名] = 头像 id`、`persona_descriptions[头像 id].description = 正文`，
 * 所以绕了两道。拿不到就返回空串 —— 世界书扫描不会因为少这个字段而崩。
 */
function personaDescriptionOf(c) {
    try {
        const pu = c?.powerUserSettings;
        const avatarId = pu?.personas?.[pu?.persona];
        return String(pu?.persona_descriptions?.[avatarId]?.description ?? '');
    } catch {
        return '';
    }
}

/**
 * 这段文本是不是我们推演出来的某份大纲。
 *
 * 用途：**不要把大纲再推演一遍**。已经投过骰子的大纲送进 chat 是正常流程的一部分
 * （推演 → 发送 → 演员写正文），自动推演不该在这时候又插一脚，
 * 否则会推演出"大纲的大纲"。
 */
function matchesRecentOutline(text) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed || !Array.isArray(ankoState.recentOutlines)) {
        return false;
    }
    return ankoState.recentOutlines.some((outline) => {
        const head = String(outline).slice(0, 24);
        return head.length > 8 && trimmed.startsWith(head);
    });
}

/**
 * 输入框里是不是还留着上一次推演出的大纲。
 *
 * 如果是，那就说明**玩家没有再输入**（上一幕还没发送）—— 按钮该提示他先发送，
 * 而不是把整份大纲当成"玩家想做的事"再推一遍。
 */
function inputHoldsLastOutline() {
    return matchesRecentOutline($('#send_textarea').val());
}

/**
 * 导演一次生成传多少 `max_tokens`。
 *
 * ⚠️ **不再写死数字**。查过源码之后定的（证据都在下面）：
 *
 * 1. 连接配置那条路把参数**原样**写进 payload，并**覆盖**预设：
 *    `shared.js:412` 的 `max_tokens: maxTokens`，加上 `custom-request.js:220` 的
 *    `requestData = { ...presetPayload, ...requestData }`（custom 在后 → 覆盖 preset）。
 *    所以**传什么就是什么，连 `undefined` 也会覆盖掉预设里那个值**。
 * 2. 预设的默认值小得不可用：`openai.js:373` 的 `openai_max_tokens: 300`
 *    —— 一张十行选项表就上百 token，推理模型的思考更是先吃预算。
 * 3. 不传时，服务端拿到的 `max_tokens` 是 `undefined`，`JSON.stringify` 会把这个键丢掉
 *    （各服务商分支都是 `max_tokens: request.body.max_tokens` 原样透传，如
 *    `chat-completions.js:630/705/803/…`）→ 服务商用**自己的默认上限**，通常几千。
 * 4. 只有 Claude 那条路会补偿过小的值：`chat-completions.js:250-254`
 *    （`if (max_tokens <= minThinkTokens) max_tokens += minThinkTokens`）。
 *
 * 结论：**面板填了就用面板的，没填（0）就干脆不传** —— 让它落到服务商默认，
 * 这是唯一能同时装下"思考 + 大纲"的选项。代理路径早就是这个规则，这里对齐它。
 *
 * 踩过的坑：写死 2048 时，推理模型把预算全用在思考上，返回 `{content:"", reasoning:"…"}`，
 * 看起来像"来源坏了"，其实是额度问题。
 *
 * @returns {number|undefined}
 */
/**
 * 读酒馆面板上的「Max Response Length」—— 也就是**酒馆自己发正文时用的 `max_tokens`**。
 *
 * 为什么要镜像它（两条都有出处，不再靠猜）：
 * 1. **ST 官方文档**（`docs.sillytavern.app/usage/prompts/reasoning` 的 Common issues 第 1 条）：
 *    "the model's internal reasoning process **consumes part of your response token allowance**…
 *     If you notice your responses are coming back **incomplete or empty**, you should try adjusting
 *     the **Max Response Length** setting… typically **1024 to 4096 tokens**" ✓
 * 2. 酒馆自己发请求时**一定带这个值**：`openai.js:2323` `'max_tokens': oai_settings.openai_max_tokens` ✓
 *    而面板上的 id 就是 `#openai_max_tokens`（`openai.js:312` 的 selector、`3838` 的回填）✓
 *
 * 同一页还写明：**Custom 来源只有模型在 OpenAI 官方名单里时才发推理力度** ✓
 *（"a reasoning effort is sent only if the model supports it on the official OpenAI source"）
 * → Gemini 3 不在名单里 → **没人限制思考** ✗ → 额度必须自己给足 ✓
 * 这就是"酒馆正文不空、我的请求空"的差别所在 ✓
 *
 * @returns {number} 读不到返回 0
 */
function stMaxResponseLength() {
    try {
        const value = Number($('#openai_max_tokens').val());
        return Number.isFinite(value) && value > 0 ? value : 0;
    } catch {
        return 0;
    }
}

/**
 * 导演的额度下限 —— 只用于**完全拿不到任何值**时的兜底 ✓。
 *
 * 依据（官方文档原文，不是拍脑袋 ✗）：
 *   https://docs.sillytavern.app/usage/prompts/reasoning/
 *   "If you notice your responses are coming back incomplete or empty, you should try
 *    adjusting the Max Response Length setting… For reasoning models, it's typical to use
 *    significantly higher token limits - anywhere from 1024 to 4096 tokens."
 * 取上限 4096 ✓：推理模型的思考与正文**共用**这个额度，给小了就会
 * `finish_reason: "length"` + `content: ""` ✗（我们自己在规范 §7.0.2 记过实测 ✓）。
 */
/**
 * 导演这次该给多少额度 —— **四条生成路径都走它** ✓。
 *
 * 为什么收成一个点（踩出来的 ✗）：同一个"空正文"故障，四条路里只有代理那条做了防护 ✗
 * （A 内置直连额度可能 null ✗、C 连接配置可能 undefined ✗、D generateRaw 原来完全没有 ✗）。
 * 根因是我"在哪看到症状就在哪修" ✗，没做横向对比 ✓。
 * 现在解析逻辑搬进 `src/tokens.js`（纯函数、可单测 ✓），这里只负责读两个来源 ✓：
 *   · 面板 `directorApiMaxTokens` ✓
 *   · 镜像酒馆自己的 Max Response Length ✓（`#openai_max_tokens`）
 * 取较大者 ✓ —— 比酒馆自己那条线还小必然是坏的 ✓（旧版本我拍 2048，比 65535 小 32 倍 ✗）。
 * 两个都没有 → 落到文档建议的上限 4096 ✓（不是 ST 默认的 300 ✗）。
 *
 * @returns {number} 一定是正整数 ✓，调用方不用再判空 ✗
 */
function directorMaxTokens() {
    return resolveDirectorTokens(getSettings().directorApiMaxTokens, stMaxResponseLength());
}

/**
 * 额度低到该提醒用户时返回一句人话，否则 null ✓。
 *
 * 只提醒、**不改用户的设置** ✗ —— 依据是官方文档的 1024–4096 建议
 * （https://docs.sillytavern.app/usage/prompts/reasoning/）✓
 */
function directorTokensWarning() {
    const tokens = directorMaxTokens();
    if (!isTokensSuspiciouslyLow(tokens)) {
        return null;
    }
    return `导演额度只有 ${tokens} token，低于酒馆文档对推理模型的建议（1024–4096），`
        + '思考可能吃光额度导致**正文为空**（可在面板里调高，或调高酒馆的 Max Response Length）';
}

/** `shared.js` 模块缓存（里面有 ConnectionManagerRequestService）。 */
let sharedModule = null;





/**
 * 收工时「进度」那一行该写什么。
 *
 * 关键是要让用户分清"没跑满"的两种含义 —— 这两种完全不同，但以前长得一模一样：
 *
 * - `done`：**这一回合已经演完了**。模型某一轮没再请求骰子，说明它觉得不用再投了。
 *   轮数上限是**上限**不是指标，跑不满很正常。
 * - `maxRounds`：**撞到上限被截断**，这一回合还没演完。
 *
 * @param {{rounds: number, reason: string, rolls: unknown[]}} result
 * @param {number} chars 本回合发出的提示词总字数
 */
function finishProgressText(result, chars = 0) {
    const rounds = Number(result?.rounds) || 0;
    const suffix = chars > 0 ? `　·　本回合发出 ${chars} 字` : '';
    switch (result?.reason) {
        case 'done':
            return `这一回合演完了：推演 ${rounds} 轮（模型某一轮没再请求骰子，自己收的尾）${suffix}`;
        case 'maxRounds':
            return `到轮数上限收尾：推演 ${rounds} 轮（上限到了，这一回合还没演完，可以用 /anko continue 接着推）${suffix}`;
        case 'aborted':
            return `已停止：推演了 ${rounds} 轮，已写好的部分保留${suffix}`;
        case 'stalled':
            return `卡住了，提前结束：推演了 ${rounds} 轮（连续几轮没有新内容，多半是模型空转，看下面的警告行）${suffix}`;
        case 'error':
            return `出错停下：推演了 ${rounds} 轮，已写好的部分保留（原因看下面的警告行）${suffix}`;
        default:
            return `推演结束：${rounds} 轮（${result?.reason ?? '未知原因'}）${suffix}`;
    }
}

/**
 * 「测试这个来源」：用**导演自己那条来源**打一次最短的请求。
 *
 * 走的是酒馆服务端代理（同源），所以这里**没有 CORS 之说** ——
 * 通不通只取决于来源/模型/密钥在酒馆那边配好没有。
 */
/**
 * ============================================================================
 *  酒馆预设：**照别人的写法**（getPresetManager + savePreset + 同步 oai_settings）
 * ============================================================================
 *  实证来源（都是本机已装的插件 ✓）：
 *    · LittleWhiteBox `modules/scheduled-tasks/scheduled-tasks.js`
 *        `getPresetManager('openai')` ✓ → `getPresetSettings(name)` ✓ →
 *        `savePreset(name, clone, { skipUpdate: true })` ✓ → **手动同步 `oai_settings`** ✓
 *    · 柏宝箱 `src/features/regexGroups.js:266` 同样只 `getPresetManager(apiId)` ✓
 *  没有任何插件克隆 `PromptManager`（2155 行 / 9 个内部依赖 ✗）→ 我们也不 ✗。
 *  本插件只做"**选 / 导入 / 导出**"，编辑预设仍用酒馆自带 Prompt Manager ✓。
 */

function presetManagerOai() {
    const pm = ctx().getPresetManager?.('openai');
    if (!pm) {
        throw new Error('这个酒馆版本没有 getPresetManager("openai")');
    }
    return pm;
}

function presetMsg(text, bad = false) {
    $('#anko_preset_msg').text(text);
    $('#anko_preset_msg').toggleClass('anko-warn', bad);
}

/** 刷新下拉：列出酒馆预设（`getPresetList('openai')` → `{ presets, preset_names, settings }` ✓）*/
function refreshPresetSelect() {
    try {
        const pm = presetManagerOai();
        // 照上游 ✓：列预设用 `getAllPresets()`（读 select 的 option 文本 ✓），
        // 当前预设用 `getSelectedPresetName()` ✓（`preset-manager.js` 里就这么写的 ✓）。
        // ⚠️ 以前我用 `getPresetList('openai').preset_names` 并判 `Array.isArray` ✗ ——
        //    上游源码里 openai 的 `preset_names = openai_setting_names` 是 **{名字: 下标} 的对象** ✗，
        //    判数组必然为空 ✓ → 面板显示「（没有预设）」✗ 就是这个 ✓。
        const names = (pm.getAllPresets?.() ?? []).map((item) => String(item).trim()).filter(Boolean);
        const current = String(getSettings().directorPresetName || pm.getSelectedPresetName?.() || '');
        const options = names.map((name) => {
            const value = escapeHtmlText(name);
            return `<option value="${value}" ${name === current ? 'selected' : ''}>${value}</option>`;
        });
        $('#anko_preset_select').html(options.join('') || '<option value="">（没有预设）</option>');
        presetMsg(names.length > 0
            ? `酒馆预设 ${names.length} 个，当前：${current || '（未知）'}`
            : '读不到酒馆预设列表（getAllPresets 为空）✗');
    } catch (error) {
        presetMsg('读不到酒馆预设列表：' + errorMessage(error), true);
    }
}


/** 导入：存成酒馆预设 → 选中它（照 LWB：savePreset + 同步实时设置 ✓）*/
async function importPresetToSt(file) {
    try {
        const text = await file.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (error) {
            presetMsg('不是合法 JSON：' + errorMessage(error), true);
            return;
        }
        if (data && typeof data === 'object' && !Array.isArray(data.prompts) && data.preset) {
            data = data.preset;
        }
        if (!data || !Array.isArray(data.prompts)) {
            presetMsg('这份 JSON 里没有 prompts —— 不像 Chat Completion 预设 ✗', true);
            return;
        }
        const name = String(data.preset_settings_openai || file.name?.replace(/\.json$/i, '') || '导入的预设');
        const pm = presetManagerOai();
        // 依据（本机逐行核实 ✓）：`preset-manager.js:466` 的 `savePreset` 在 `skipUpdate=false` 时
        // 会走 `:497 this.updateList(name, preset)` ✓ → 内部 `.trigger('change')` ✓ →
        // 触发 `onSettingsPresetChange` ✓ → **自动选中并应用** ✓。
        // 所以我**不需要** `skipUpdate: true` + 手工同步 `oai_settings` ✗（那是 LWB 为了"不改选中"才做的 ✓）。
        await pm.savePreset(name, data);
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        presetMsg(`已导入并应用酒馆预设「${name}」✓`);
        log('已导入预设：' + name);
        refreshPresetSelect();
    } catch (error) {
        presetMsg('导入失败：' + errorMessage(error), true);
        warn('导入预设失败', error);
    }
}

/** 导出当前预设成文件 ✓ */
function exportCurrentPreset() {
    try {
        const pm = presetManagerOai();
        const name = String(pm.getSelectedPresetName?.() ?? '');
        const data = name ? (pm.getPresetSettings?.(name) ?? pm.getCompletionPresetByName?.(name)) : null;
        if (!data) {
            presetMsg('读不到当前预设内容 ✗', true);
            return;
        }
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${name || 'preset'}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        presetMsg(`已导出「${name}」✓`);
    } catch (error) {
        presetMsg('导出失败：' + errorMessage(error), true);
    }
}
async function testDirectorApiSource() {
    const settings = getSettings();
    const model = String(settings.directorApiModel ?? '').trim();
    // 来源三种形态（和 buildDirectorGenerate 保持一致 ✓）：空 = 跟随当前设置 ✓；
    // 哨兵 = 同源换模型 ✓；其它 = 指定来源 ✓
    const rawSource = String(settings.directorApiSource ?? '').trim();
    const isSameSource = rawSource === SAME_SOURCE_SENTINEL;
    const source = isSameSource ? currentChatCompletionSource() : rawSource;
    const show = (text, bad = false) => {
        $('#anko_api_source_result').text(text);
        $('#anko_api_source_result').toggleClass('anko-warn', bad);
    };

    if (!rawSource && !model) {
        show('两个都没填 —— 导演会跟着正文走（用正文的模型与预设），没什么可测的。', true);
        return;
    }
    if (!rawSource && model) {
        show(`现在是「跟随当前设置」，填的模型「${model}」不会生效 ✓；`
            + '想测它，请把来源选成「同源换模型」。', true);
        return;
    }
    if (isSameSource && !model) {
        show('「同源换模型」必须填模型名 ✓（来源用正文当前的，模型用这个）。', true);
        return;
    }
    if (rawSource && !isSameSource && !model) {
        show('只选了来源、没填模型：跑不了 ✓。模型是必填的'
            + '（想跟正文同源就用「同源换模型」，想完全跟随就选「跟随当前设置」）。', true);
        return;
    }
    if (!source) {
        show('读不到正文当前的来源（酒馆面板里那个下拉没找到）—— 那就请手动选一个来源。', true);
        return;
    }

    show('测试中…');
    try {
        const { ChatCompletionService } = ctx();
        if (!ChatCompletionService?.processRequest) {
            throw new Error('这个酒馆版本没暴露 ChatCompletionService');
        }
        const data = await ChatCompletionService.processRequest({
            messages: [{ role: 'user', content: '只回复两个字：可以' }],
            ...buildProxyPayloadFields(source, model),
            // ⚠️ **故意不传 max_tokens**。
            // 这个按钮要回答的是"通不通"，不是"额度够不够" —— 而推理型模型的思考 token
            // **也计入 max_tokens**，所以任何写死的数字都可能是我拍脑袋
            // （64 试过不够；512 也一样没依据）。不传 → 用该来源/预设自己的默认值，
            // 这样测出来的才是连通性，不会把"额度不够"伪装成"来源坏了"。
        }, {}, true);
        const text = pickGeneratedText(data);
        if (!text.trim()) {
            const reasoning = String(data?.reasoning ?? '').trim();
            if (reasoning) {
                // 这个现象值得单独说：正文空、思考满 —— 与会话无关，是预算/模型特性
                throw new Error('模型把内容都写在**思考通道**里了，正文是空的。'
                    + '多半是 token 预算被思考吃光（面板里把「最大 token」调大，或换一个非推理模型）。'
                    + `思考片段：${reasoning.replace(/\s+/g, ' ').slice(0, 120)}`);
            }
            throw new Error('返回里没找到正文（模型名对不对？这个来源有 key 吗？）。'
                + `原始返回：${describeShape(data)}`);
        }
        show(`通 ✓ ${source} / ${model} 回了：${text.replace(/\s+/g, ' ').slice(0, 40)}`);
        toastr.success('导演的 API 来源连接正常', '安科导游');
    } catch (error) {
        // ⚠️ 必须用 describeError 而不是 errorMessage：酒馆那条路常常**抛对象**而不是 Error
        // （`throw await response.json()`），简版 `String(error?.message ?? error)` 只会给出
        // 一句 "[object Object]" —— 用户实测撞到的就是这个。describeError 会把对象串成 JSON。
        show(`不通：${describeError(error)}　（去酒馆的 API 面板确认这个来源的密钥与模型）`, true);
        toastr.error(describeError(error), '安科导游');
    }
}
/**
 * 「测试连接」：用一句最短的话打一次内置 API，把结果或原因写在按钮下面。
 *
 * 为什么要这个按钮：浏览器直连最大的坑是 CORS —— 打一次就知道通不通，
 * 不用等到推演到第 3 轮才发现"从来没发出去过"。
 */
async function testBuiltinApi() {
    const settings = getSettings();
    const show = (text, bad = false) => {
        $('#anko_api_result').text(text);
        $('#anko_api_result').toggleClass('anko-warn', bad);
    };

    if (!String(settings.builtinApiKey ?? '').trim()) {
        show('没填 API Key。', true);
        return;
    }
    if (!String(settings.builtinApiModel ?? '').trim()) {
        show('没填模型名。', true);
        return;
    }

    show('测试中…');
    try {
        const text = await callChatApi({
            kind: settings.builtinApiKind,
            baseUrl: settings.builtinApiBase,
            apiKey: settings.builtinApiKey,
            model: settings.builtinApiModel,
            temperature: Number.isFinite(settings.builtinApiTemperature)
                ? settings.builtinApiTemperature
                : null,
            maxTokens: 256,
            systemPrompt: '这是一次连通性测试。',
            prompt: '请只回复两个字：可以',
        });
        show(`通 ✓ 接口回了：${text.replace(/\s+/g, ' ').slice(0, 60)}`);
        toastr.success('内置 API 连接正常', '安科导游');
    } catch (error) {
        show(`不通：${errorMessage(error)}`, true);
        toastr.error(errorMessage(error), '安科导游');
    }
}

/**
 * 读酒馆**当前选中**的 `chat_completion_source`。
 *
 * `oai_settings` 没有导出（`openai.js:461` 是模块内的 `const`），但酒馆自己把
 * 这个值同步在 API 面板的下拉上（`openai.js:6388` 的 `#chat_completion_source` change），
 * 所以从那儿读是最省事也最可靠的办法 —— 这样"只换模型、不换来源"才成立。
 */
function currentChatCompletionSource() {
    try {
        return String($('#chat_completion_source').val() ?? '');
    } catch {
        return '';
    }
}

/**
 * 读酒馆「自定义 OpenAI 兼容」那个地址。
 *
 * 为什么必须要它：选了这个来源，**服务端要拼 `{custom_url}/chat/completions`** ——
 * 客户端不把地址传过去，服务器就拿到 `undefined`，报的就是
 * `Invalid URL: "undefined/chat/completions"`（用户实测撞到过两次）。
 * 酒馆把这个值同步在 `#custom_api_url_text`（`openai.js:6511`），从那儿读。
 */
/**
 * 自纠重试时用的"降思考"请求体。
 *
 * 取值**按来源分**，因为服务端翻译方式不同（都有出处）：
 *   · `openrouter`：服务端 `chat-completions.js:1834-1836` 把 `reasoning_effort`
 *     翻成 `reasoning: { effort: … }` → OpenRouter 认 low/medium/high → 给 **`low`**
 *     （ST 自己的枚举里有它 ✓，保守、不会被拒）
 *   · `custom`：服务端 custom 分支**只 merge `custom_include_body`**
 *     （`chat-completions.js:1863-1879`）→ 直接透给端点；Gemini 的 OpenAI 兼容层
 *     按 Google 官方表认 `minimal`（映射到最低思考档）→ 给 **`minimal`**
 *   · 其它来源：ST 有原生处理（如 makersuite/vertex 自己按比例算预算，
 *     `prompt-converters.js:1075-1101`），**别乱塞参数** ✗ → 返回空对象
 *
 * ⚠️ 未核实：OpenRouter 是否接受 `minimal`（其文档抓取失败 ✗）→
 * 所以对 openrouter 一律用 `low`，不用没把握的值 ✓。
 *
 * @param {string} source
 * @returns {object} 要并进请求体的字段
 */
function reduceThinkingBody(source) {
    if (source === 'custom') {
        // ⚠️ 必须是**字符串**，不能是对象 ✗ —— 服务端做的是
        // `mergeObjectWithYaml(bodyParams, request.body.custom_include_body)`
        // （`chat-completions.js:1863-1879`），而它内部是 `yaml.parse(yamlString)`
        // （`src/util.js:632-653`，**异常被空 catch 吞掉**）→ 传对象会**静默无效** ✗
        // （读者查出来的实测结论；我原来传的就是对象 ✓ 白传了）
        return { custom_include_body: 'reasoning_effort: minimal' };
    }
    if (source === 'openrouter') {
        return { reasoning_effort: 'low' };
    }
    return {};
}

/**
 * 从 `processRequest` 的返回值里取出正文。
 *
 * 为什么不能直接读 `data.content`：不同酒馆版本、不同来源，返回的形状不一样 ——
 * 实测（走 custom 来源）就拿到过空值，报"返回了空内容"，但请求其实是成功的 ✗。
 * 所以这里把所有见过的形状都认一遍；
 * **认不出来时，调用方会把原始形状塞进报错** —— 别再靠猜，让用户一眼看到真相。
 *
 * @param {unknown} data
 * @returns {string} 取不到就返回空串
 */
function pickGeneratedText(data) {
    if (typeof data === 'string') {
        return data;
    }
    if (!data || typeof data !== 'object') {
        return '';
    }
    const candidates = [
        data.content,
        data.message?.content,
        data.text,
        data.choices?.[0]?.message?.content,
        data.choices?.[0]?.delta?.content,
        data.choices?.[0]?.text,
        data.data?.content,
    ];
    for (const item of candidates) {
        if (typeof item === 'string' && item.trim()) {
            return item;
        }
    }
    return '';
}

/**
 * 正文取不到时的报错文本。
 *
 * 为什么要把 `reasoning` 摘出来：只有它能区分两种完全不同的情况 ——
 *   · 端点**压根没给正文**（思考满、正文空）→ 只能换模型 / 改端点参数
 *   · 正文**被 max_tokens 截断**（思考没写完就断了）→ 该调额度
 * 这两者的处置完全不同，所以报错必须同时给出「长度 + finish_reason + 思考摘录」。
 *
 * 依据（读者逐行核对过）：酒馆主聊天路径**不把"只有思考"当错误**
 * （`script.js:5025/5152` 专门为有思考的楼层保留空正文；
 * `custom-request.js:472-478` 给程序化调用者同时返回 `content` 与 `reasoning`），
 * 唯一抛 `No message generated` 的是 `generateRaw`（`script.js:3754-3755`）。
 *
 * @param {unknown} data
 * @param {string} source
 * @returns {string}
 */
function noContentError(data, source) {
    const reasoning = String(data?.reasoning ?? '').trim();
    const head = `走「${source}」来源没拿到正文（${describeShape(data)}）`;
    if (!reasoning) {
        return `${head}。这个来源既没正文也没思考 —— 先确认模型名和密钥。`;
    }
    return `${head}。模型**只写了思考、没写正文**（思考 ${reasoning.length} 字）：`
        + `${reasoning.replace(/\s+/g, ' ').slice(0, 160)}…\n`
        + '思考型模型常见这样；酒馆自己遇到这种情况也不当错误，但导演必须要正文。'
        + '两条出路：① 换一个不发思考的模型（最干净）；'
        + '② 自定义来源可以在酒馆的 custom_include_body 里加该端点的减思考参数'
        + '（参数名要查端点文档，酒馆源码里看不到）。';
}

/** 取不到正文时，把返回值的形状压成一行短的，方便用户直接发给我看。 */
function describeShape(data) {
    try {
        const content = String(data?.content ?? '');
        const reasoning = String(data?.reasoning ?? '');
        // ⚠️ 只截文本**不够**：看不出"思考是 150 字还是吃满了额度"。
        // 长度 + finish_reason 才能区分「端点压根不给正文」和「正文被 max_tokens 截断」。
        const facts = [
            `content 长度=${content.length}`,
            `reasoning 长度=${reasoning.length}`,
            data?.finish_reason ? `finish_reason=${data.finish_reason}` : '',
            data?.choices?.[0]?.finish_reason ? `choices[0].finish_reason=${data.choices[0].finish_reason}` : '',
            `顶层键=[${Object.keys(data ?? {}).join(',')}]`,
        ].filter(Boolean).join('，');
        const json = JSON.stringify(data);
        const head = json && json !== '{}' ? json.slice(0, 200) : String(data);
        return `${facts}｜${head}`;
    } catch {
        return String(data).slice(0, 300);
    }
}

function currentCustomApiUrl() {
    try {
        return String($('#custom_api_url_text').val() ?? '').trim();
    } catch {
        return '';
    }
}

/**
 * 拼"走酒馆代理"那次请求里**除 messages 之外**的连接字段。
 *
 * ⚠️ 抽出来共用是有原因的：这段逻辑以前在生成路径和「测试这个来源」里各写一份，
 * 结果一处改了另一处没改 —— 而且我上一轮那次编辑**失败后没重试**，
 * 于是 `custom_url` 从头到尾根本没发出去过 ✗。所以：只留这一个地方拼。
 *
 * 只有 `custom` 来源需要地址（和酒馆自己 `openai.js:4041` 的判断一致）；
 * 其它来源用服务端自己的配置，**密钥一律不传**（用酒馆 secrets 里那份）。
 *
 * @param {string} source
 * @param {string} model
 * @returns {object} 要并进 payload 的字段
 */
function buildProxyPayloadFields(source, model) {
    const fields = { chat_completion_source: source, model };
    if (source === 'custom') {
        const customUrl = currentCustomApiUrl();
        if (customUrl) {
            fields.custom_url = customUrl;
        }
    }
    return fields;
}

/**
 * 造一个给导演用的 `generate`。三条路的优先顺序：
 *
 * 1. **内置 API（直连，不走酒馆）** —— 面板里开了就用它
 * 2. **连接配置**（带它绑定的酒馆预设，不动主聊天设置）
 * 3. `generateRaw`（当前设置）
 *
 * 后两条任何一步失败都**退回 `generateRaw`** 并告警 —— 宁可少一个特性，
 * 不能让推演整个挂掉。但第 1 条失败**不退回**：用户明确选了直连，
 * 悄悄换一条路会让"我明明配了它为什么用别的模型"变成灵异事件。
 *
 * @param {object} settings
 * @returns {(request: {systemPrompt: string, prompt: string, prefill?: string}) => Promise<string>}
 */
function buildDirectorGenerate(settings) {
    if (settings?.useBuiltinApi) {
        return async (request) => {
            const settingsNow = getSettings();
            debug('导演走内置 API', {
                kind: settingsNow.builtinApiKind,
                model: settingsNow.builtinApiModel,
                base: settingsNow.builtinApiBase || '（官方默认）',
            });
            return callChatApi({
                kind: settingsNow.builtinApiKind,
                baseUrl: settingsNow.builtinApiBase,
                apiKey: settingsNow.builtinApiKey,
                model: settingsNow.builtinApiModel,
                temperature: Number.isFinite(settingsNow.builtinApiTemperature)
                    ? settingsNow.builtinApiTemperature
                    : null,
                maxTokens: Number(settingsNow.builtinApiMaxTokens) > 0
                    ? Number(settingsNow.builtinApiMaxTokens)
                    : directorMaxTokens(),
                systemPrompt: request.systemPrompt,
                prompt: request.prompt,
                prefill: request.prefill,
            });
        };
    }

    // ② 导演自己的来源 + 模型：**经酒馆服务端代理**发（同源，无 CORS，密钥用酒馆的）
    //
    // ⚠️ 设计要点（用户指出的）：**常见用法是"同一个来源、换一个模型"**
    // （正文用贵的、导演用便宜的），所以**模型才是主角**：
    //   · 填了模型 → 用它；来源留空 = 跟正文**同一个来源**（只换模型）
    //   · 只选了来源、没填模型 → 没法跑（`chat_completion_source` 只决定服务商，
    //     模型是另一个字段，我读不到"那个来源当前选中的模型"）→ 退回当前设置并告警
    //   · 两个都没填 → 跟随当前设置
    const model = String(settings?.directorApiModel ?? '').trim();
    // 来源：三种明确形态，**不再靠"模型填没填"来猜** ✗
    //   ''        → 跟随当前设置（generateRaw，用正文的模型 + 正文的预设）✓
    //   '__same__'→ 同源换模型（用正文当前的来源 + 下面填的模型，走服务端代理）✓
    //   其它值     → 用这个来源 + 下面填的模型，走服务端代理 ✓
    const rawSource = String(settings?.directorApiSource ?? '').trim();
    const isSameSource = rawSource === SAME_SOURCE_SENTINEL;
    const source = isSameSource ? currentChatCompletionSource() : rawSource;

    /**
     * 退回「跟随当前设置」时**统一走这个包装** ✓ —— 关键是带上 `responseLength`。
     *
     * 为什么必须带（这是从代码推出来的，不是猜 ✓）：
     *   · `generateRaw` 签名里有 `responseLength` ✓（`script.js:3635`），会
     *     `TempResponseLength.save(api, responseLength)` ✓
     *   · 不传 → 用正文当前的 Max Response Length ✓，而 ST 的默认是
     *     `openai_max_tokens: 300` ✗（`openai.js` 的 `default_settings`）→
     *     推理模型的思考就能把它吃光 → **正文为空** ✗
     *   · 而"只回思考 → 降思考重试"和 `noContentError` 诊断**只在代理分支里有** ✗，
     *     所以这条路以前是**保护最少**的一条 ✓（用户报的"跟随当前设置不对"就是这个 ✓）
     */
    // ★ 完全按酒馆来做 ✓：**用 `generateQuietPrompt`**，而不是自己拼提示词 ✗。
    //
    // 依据（官方文档 + 源码）：
    //   · 文档《Prompt Manager》：预设里的每条 prompt 带 `role / position / depth / order / triggers`
    //     ✓，由酒馆按这些维度**组装成 messages** ✓（[docs.sillytavern.app/usage/prompts/prompt-manager](https://docs.sillytavern.app/usage/prompts/prompt-manager/)）
    //   · `generateQuietPrompt`（`script.js:2832` ✓、`st-context.js:185` 暴露 ✓）走的正是这套组装 ✓：
    //     聊天历史 ✓ + 预设全部条目 ✓ + 世界书 ✓，然后把 `quietPrompt` **追加在最后** ✓
    //   · 而 `generateRaw` 是"**完全自己控制提示词**"（文档原话）✗ —— 它**不跑**这套组装 ✗，
    //     这就是"预设不生效 / 看不到上下文"的总根源 ✗。
    //
    // 所以：把导演的任务塞进 `quietPrompt` ✓（最后 = 优先级最高 ✓），其余交给酒馆 ✓。
    const rawGenerate = async (request) => {
        const c = ctx();
        if (typeof c.generateQuietPrompt === 'function') {
            const quiet = [DIRECTOR_SYSTEM_PROMPT, request.prompt].filter(Boolean).join('\n\n');
            const text = await c.generateQuietPrompt({
                quietPrompt: quiet,
                responseLength: directorMaxTokens(),
            });
            if (typeof text === 'string' && text.trim()) {
                return text;
            }
            // 酒馆那边没给出正文 → 再退回 generateRaw（至少把错误暴露出来 ✓）
            warn('generateQuietPrompt 没返回正文，本次退回 generateRaw');
        }
        return c.generateRaw({ ...request, responseLength: directorMaxTokens() });
    };

    // 「同源换模型」：缺东西就明确告警 + 退回 ✓（不许静默跑到别的路上 ✗）
    if (isSameSource && !model) {
        warn('选了「同源换模型」但没填模型名，这一轮按"跟随当前设置"跑');
        return rawGenerate;
    }
    if (isSameSource && !source) {
        warn('选了「同源换模型」但读不到正文当前的来源，这一轮按"跟随当前设置"跑');
        return rawGenerate;
    }
    if (source && !model) {
        warn(`选了来源「${source}」但没填模型名，这一轮按"跟随当前设置"跑`);
        return rawGenerate;
    }
    if (!source && model) {
        // 跟随当前设置时填的模型**不会生效** ✓ —— 以前它会偷偷把这条路改成"同源换模型" ✗
        warn(`现在是跟随当前设置，填的模型「${model}」不生效 ✓；`
            + '想用它请把来源选成「同源换模型」');
    }
    if (source && model) {
        return async (request) => {
            try {
                const { ChatCompletionService } = ctx();
                if (!ChatCompletionService?.processRequest) {
                    throw new Error('这个酒馆版本没暴露 ChatCompletionService');
                }
                const settingsNow = getSettings();
                const messages = [];
                if (request.systemPrompt) {
                    messages.push({ role: 'system', content: request.systemPrompt });
                }
                messages.push({ role: 'user', content: request.prompt });
                if (request.prefill) {
                    messages.push({ role: 'assistant', content: request.prefill });
                }
                // ── 预设：**这条路以前完全没应用预设** ✗ ──
                //
                // 语义（和面板文案一致 ✓）：
                //   来源 = 正文当前的来源 ✓  模型 = 你填的 ✓
                //   **其余采样参数 = 正文当前选中的那个预设** ✓；面板填了的覆盖预设 ✓
                // 依据：`ChatCompletionService.processRequest` 只有传了 `presetName` 才应用预设
                // （`custom-request.js:540`），这条路不传 ✗ → 1.14.0 里等于一个参数都不带 ✗。
                // 所以自己取一遍 ✓（映射照抄 `openai.js:264` 的 `settingsToUpdate` ✓）。
                let presetFields = {};
                // 预设名要在 try 外面可见 ✓（下面要写进"上次发送参数"面板行 ✓）
                let currentPresetName = '';
                try {
                    const pm = ctx().getPresetManager?.('openai');
                    currentPresetName = String(pm?.getSelectedPresetName?.() ?? '');

                    // ★ 第一优先：**酒馆的实时设置** ✓（`chatCompletionSettings` = `oai_settings`）
                    // 这才是酒馆自己每次发请求时用的那份 ✓（`st-context.js:206`）——
                    // 选中预设时酒馆已经把预设写进它了 ✓，所以我们读它等于**照抄酒馆** ✓，
                    // 不用赌"预设名对不对得上" ✗（那是我前面一直失败的地方 ✗）。
                    const live = ctx().chatCompletionSettings;
                    presetFields = settingsToPayload(live, { source });

                    if (Object.keys(presetFields).length > 0) {
                        log(`导演沿用酒馆当前设置（预设「${currentPresetName || '?'}」）：`
                            + Object.entries(presetFields).map(([k, v]) => `${k}=${v}`).join(' '));
                    } else {
                        // 实时设置里也没有 → 才退回去找预设对象 ✓（兜底 ✗ 不该是主路径 ✗）
                        const currentPreset = currentPresetName
                            ? pm?.getCompletionPresetByName?.(currentPresetName)
                            : null;
                        if (currentPreset) {
                            presetFields = presetToPayload(currentPreset, { source });
                            log(`（实时设置为空）改用预设对象「${currentPresetName}」：`
                                + Object.entries(presetFields).map(([k, v]) => `${k}=${v}`).join(' '));
                        } else {
                            warn('读不到酒馆当前的采样设置（chatCompletionSettings 为空且预设对象也没取到），'
                                + '本次只按面板参数跑');
                        }
                    }
                } catch (error) {
                    warn('读酒馆当前采样设置失败，本次只按面板参数跑', error);
                }

                const panelTemperature = Number.isFinite(settingsNow.directorApiTemperature)
                    ? settingsNow.directorApiTemperature
                    : null;
                const panelMaxTokens = Number(settingsNow.directorApiMaxTokens) > 0
                    ? Math.trunc(Number(settingsNow.directorApiMaxTokens))
                    : null;

                // ★ 记下"这次发了什么、每个值从哪来" ✓ 并打到面板 ✓。
                // 光看请求日志分不清哪个值来自预设 ✗、哪个是酒馆默认 ✗、哪个是面板 ✗ ——
                // 用户就是这样反问"这是预设？这压根不是预设"的 ✗。
                const presetTag = `预设「${currentPresetName || '(读不到名字)'}」`;
                lastSendInfo = {
                    source,
                    presetName: currentPresetName || '',
                    fields: {
                        temperature: panelTemperature !== null
                            ? { value: panelTemperature, from: '面板' }
                            : (Number.isFinite(presetFields.temperature)
                                ? { value: presetFields.temperature, from: presetTag }
                                : { value: null, from: '未发送' }),
                        top_p: Number.isFinite(presetFields.top_p)
                            ? { value: presetFields.top_p, from: presetTag }
                            : { value: null, from: '未发送' },
                        max_tokens: panelMaxTokens !== null
                            ? { value: panelMaxTokens, from: '面板' }
                            : (Number.isFinite(presetFields.max_tokens)
                                ? { value: presetFields.max_tokens, from: presetTag }
                                : { value: directorMaxTokens(), from: '镜像酒馆额度' }),
                    },
                };

                // 连接字段统一由 buildProxyPayloadFields 拼（含"自定义来源必须传地址"）
                // ⚠️ 必须是 let：下面"只回思考"时会把 data 换成重试后的响应
                // （原来写成 const ✗ → 实测报 `Assignment to constant variable`）
                let data = await ChatCompletionService.processRequest({
                    messages,
                    ...buildProxyPayloadFields(source, String(settingsNow.directorApiModel ?? '').trim()),
                    // 预设铺底 ✓ → 面板填了才覆盖 ✓
                    // ⚠️ 面板没填时**不要出现这个键** ✗：`custom-request.js:220` 是 custom 在后，
                    // 传 undefined 会把预设里的值顶掉 ✗（虽然随后会被删掉，但那时预设值已经丢了 ✗）
                    ...presetFields,
                    max_tokens: panelMaxTokens
                        ?? (Number.isFinite(presetFields.max_tokens) ? presetFields.max_tokens : null)
                        ?? directorMaxTokens(),
                    ...(panelTemperature === null ? {} : { temperature: panelTemperature }),
                }, {}, true);
                let text = pickGeneratedText(data);
                if (!text.trim()) {
                    // ── 只有思考、没有正文：**在插件内部自纠一次**，不把球踢给用户 ──
                    //
                    // 依据（都读过源码）：
                    // · 程序化调用**同时拿到** content 与 reasoning（`custom-request.js:472-478`）
                    //   → 思考文本就在我们手里，可以据此判断"它其实在干活，只是没写正文" ✓
                    // · 服务端在 **CUSTOM 分支只认 `custom_include_body`** 来改请求体
                    //   （`chat-completions.js:1863-1879`）→ 降思考参数只能从这里进 ✓
                    // · 字段名 `reasoning_effort` 是 Google 官方 OpenAI 兼容层认的
                    //   （`ai.google.dev/gemini-api/docs/openai`）；取值按"压到最低档"给 minimal，
                    //   端点若拒绝 minimal 就改 low（两个来源在这一点上打架，见规范 §7.0）
                    //
                    // ⚠️ 只在**失败之后**才这样重试一次：正常出正文时不碰请求，行为零变化 ✓
                    const reasoning = String(data?.reasoning ?? '').trim();
                    if (reasoning) {
                        log(`「${source}」只回了思考（${reasoning.length} 字）、没有正文 → `
                            + '自动降思考重试一次（custom_include_body.reasoning_effort=minimal）');
                        const retryMessages = [...messages, {
                            role: 'user',
                            content: '你上一条只写了思考过程，没有输出正文。'
                                + '这一次**直接输出正文本身**，不要输出思考、不要解释你要怎么做。',
                        }];
                        const retryData = await ChatCompletionService.processRequest({
                            messages: retryMessages,
                            ...buildProxyPayloadFields(source, String(settingsNow.directorApiModel ?? '').trim()),
                            // 预设参数也要带上 ✓ —— 否则"重试一次"等于把用户的预设丢了 ✗
                            ...presetFields,
                            // 降思考：取值按来源分（openrouter→low；custom→minimal；其它不乱塞）
                            ...reduceThinkingBody(source),
                            // ⚠️ **同时把输出上限放宽**：ST 官方文档写明推理模型的思考会吃掉响应额度、
                            // 导致"回复不完整或为空"，并建议 1024–4096+
                            //（`docs.sillytavern.app/usage/prompts/reasoning` Common issues #1）✓
                            // 所以光降思考不够，还得给"思考+正文"留出总额度 ✓
                            // 取 directorMaxTokens()（面板值 → 镜像酒馆的 Max Response Length）；
                            // 重试时也用统一额度解析（现在它一定给正整数，不再需要 ?? 兜底 ✗）
                            max_tokens: directorMaxTokens(),
                            temperature: Number.isFinite(settingsNow.directorApiTemperature)
                                ? settingsNow.directorApiTemperature
                                : undefined,
                        }, {}, true);
                        text = pickGeneratedText(retryData);
                        if (text.trim()) {
                            log('降思考重试成功 ✓');
                            return text;
                        }
                        data = retryData; // 报错用重试后的响应（更真实）
                        warn('降思考重试后仍然没有正文');
                    }

                    // 走到这里说明自纠也没用 → 报第一因（**不退回 generateRaw**：
                    // 同一响应它会再抛一次 `No message generated`，`script.js:3754-3755`，
                    // 只会掩盖真因；而主聊天路径遇到这种响应**不报错**，见 `script.js:5025/5152`）
                    const error = new Error(noContentError(data, source));
                    error.ankoNoContent = true;
                    throw error;
                }
                return text;
            } catch (error) {
                if (error?.ankoNoContent) {
                    warn(`走「${source}」来源没有产出正文，且**退回也救不了**（同一响应会再抛一次），`
                        + '所以这次不退回，直接报出来', error);
                    throw error;
                }
                // 安全策略拦截（Gemini 的 `PROHIBITED_CONTENT` 这一类）：
                //   · **不是插件的问题** ✓ —— 酒馆已经把四类安全阈值全设成 OFF ✓
                //     （`src/constants.js` 的 `GEMINI_SAFETY` ✓），所以这不是"阈值没放开" ✗
                //   · **退回 generateRaw 没用** ✗：同模型同内容，照样被拦 ✗
                //   · **降思考重试没用** ✗：拦的是内容本身 ✗
                // 所以直接报一条能指导行动的错 ✓，不做无意义的重试/回退 ✗。
                if (isPolicyBlocked(errorMessage(error))) {
                    const blocked = new Error(
                        '上游把这次请求**拦在内容安全策略**上了（' + errorMessage(error) + '）。\n'
                        + '这不是插件的错，也不是额度问题 —— 换模型/来源通常就能过去：\n'
                        + '  · 同一模型换个来源（例如走 OpenRouter，而不是 Google 直连）\n'
                        + '  · 或换个模型（不同模型的内容阈值不一样）\n'
                        + '  · 或把这一段情节写得含蓄一点',
                    );
                    blocked.ankoBlocked = true;
                    throw blocked;
                }
                warn(`走「${source}」来源失败（${errorMessage(error)}），本次退回当前设置`, error);
                return rawGenerate(request);
            }
        };
    }
    // 三条路都不匹配时（没选来源/没填模型等）→ 一律走「跟随当前设置」✓
    // ⚠️ 我删连接配置分支时把这行一起删了 ✗ → 函数返回 undefined ✗ → 推演报
    //    "runDirector 需要一个 generate 回调" ✓（33 条红的根因 ✓）。
    return rawGenerate;
}


/**
 * 跑一次导演推演。
 *
 * @param {string} userInput 玩家这一回合想做什么；空串表示"接着前情往下推一幕"
 * @param {object} [options]
 * @param {string} [options.reason] 谁触发的（按钮/命令/自动/续推），只用于提示与日志
 * @param {boolean} [options.quiet] 不弹成功提示（失败一律照报）
 * @param {'input'|'chat'} [options.deliver] 大纲送到哪：
 *        `input` 写进输入框（按钮/命令路径）；
 *        `chat` 交给调用方塞进聊天消息（自动推演路径）—— **这时候绝不能碰输入框**，
 *        因为推演要几十秒，用户很可能已经在里面打下一句话了。
 * @returns {Promise<string>} 大纲（失败返回空串或半成品）
 */
async function runDirectorOnce(userInput, { reason = '手动', quiet = false, deliver = 'input' } = {}) {
    const settings = getSettings();
    const continuing = !String(userInput ?? '').trim();
    abortRequested = false;
    setRunning(true);

    // 额度太低就**先说一声** ✓ —— 推理模型的思考会吃光额度，表现为"正文为空" ✗
    // （依据 ST 文档的 1024–4096 建议；只提醒，不改用户设置 ✗）
    const tokenWarning = directorTokensWarning();
    if (tokenWarning) {
        warn(tokenWarning);
    }

    /**
     * 推演开始时是哪个聊天。
     *
     * 一轮推演要调十几次模型、几十秒，用户完全可能中途切走。如果不管，
     * 结果会写进**切过去之后**那个聊天的状态与前情里 —— 跨聊天串台。
     * 所以发现聊天变了就中止，并且**什么都不写**。
     */
    const startingChatId = currentChatId();
    /**
     * 这次推演属于哪个"聊天纪元"。
     *
     * 只比 chatId 不够稳：`getCurrentChatId()` 在**没有选中角色 / 聊天还没保存过**时会返回
     * `undefined`，于是两边都变成空串 → `chatSwitched()` 恒为 false，守卫失效、整份大纲串台。
     * 所以再叠一个由 `CHAT_CHANGED` 递增的计数器：**只要切过一次聊天就一定认得出来**。
     */
    const startingEpoch = chatEpoch;
    const chatSwitched = () => chatEpoch !== startingEpoch || currentChatId() !== startingChatId;

    /** 本回合实际发出去的提示词总字数（每轮一份，用来对照 token 代价）。 */
    let promptCharsTotal = 0;

    const handle = openLoader('导演推演中…（点面板上的「停止」可以中断）');

    try {
        const { generateRaw } = ctx();
        if (typeof generateRaw !== 'function') {
            throw new Error('这个酒馆版本没有 generateRaw，无法推演');
        }

        // 简报先算出来，**并把大小写进日志/调试** ✓ —— "导演看不到上下文"这类问题，
        // 只要有一行"N 字"就能立刻分辨是"没取到"✗ 还是"取到了但太少"✗。
        const brief = await currentContextBrief();
        lastBriefChars = brief.length;
        debug(`上下文简报 ${brief.length} 字（最近 ${Math.min(20, (ctx().chat ?? []).length)} 条消息）`);

        // ★ 预设的**提示词口径**（用户选 B ✓）：那几十条 system 指令才是"预设的主体" ✗
        //   （他那份是 67 条 ✓，只有采样参数等于什么都没抄 ✗）。
        //   顺序：**先口径 → 再导演任务** ✓，并在任务开头写明"任务优先于文风" ✓，
        //   否则"别把玩家当主角"这类口径会和"推进剧情"直接打架 ✗。
        // ★ 权威来源（照 MVU 的思路：**注入**，不碰预设）：
        //   ① 选了「导演用哪个预设」→ 读**那份**预设的 prompts（getPresetSettings(name)）
        //   ② 没选 → 用酒馆当前实时设置（chatCompletionSettings）
        //   全程**不调用 selectPreset** —— 不改你酒馆的当前预设、不动正文。
        let guidanceSource = ctx().chatCompletionSettings;
        let guidanceLabel = '当前预设';
        const wantedPreset = String(settings.directorPresetName ?? '').trim();
        if (settings.usePresetPrompts !== false && wantedPreset) {
            try {
                const pm = ctx().getPresetManager?.('openai');
                const presetData = pm?.getPresetSettings?.(wantedPreset)
                    ?? pm?.getCompletionPresetByName?.(wantedPreset);
                if (presetData && Array.isArray(presetData.prompts)) {
                    guidanceSource = presetData;
                    guidanceLabel = wantedPreset;
                } else {
                    warn('读不到预设「' + wantedPreset + '」的条目，这次按当前预设跑');
                }
            } catch (error) {
                warn('读导演专用预设失败，这次按当前预设跑', error);
            }
        }
        const guidance = settings.usePresetPrompts === false
            ? { text: '', count: 0, truncated: false }
            : presetGuidanceFromSettings(guidanceSource, { maxChars: 8000 });

        // ★ MVU 式：口径**不塞进 quietPrompt** ✗，而是用 `setExtensionPrompt` **注入** ✓。
        //   为什么：quietPrompt 会和**当前预设**的条目叠加（`populateChatCompletion` 把整份当前预设都加进去 ✗），
        //   而注入是"加法"，还能用 `filter` 精确限定在**导演推演期间** ✓ —— 平时对正文零影响 ✓。
        const directorSystemPrompt = DIRECTOR_SYSTEM_PROMPT;
        if (guidance.count > 0) {
            ctx().setExtensionPrompt(
                PRESET_GUIDANCE_KEY,
                '# 写作口径（来自你选的那份预设，必须遵守；与下面的导演任务冲突时以任务为准）\n' + guidance.text,
                PROMPT_POSITION.IN_PROMPT,
                0,
                false,
                PROMPT_ROLE.SYSTEM,
                // filter：酒馆每次组装提示词都会调用 ✓ —— 只有导演推演期间才返回 true ✓
                () => directorPresetGuidanceActive,
            );
            lastPresetGuidanceFrom = guidanceLabel;
            log(`已注入预设口径 ${guidance.count} 条（来源：${guidanceLabel}，${guidance.text.length} 字`
                + `${guidance.truncated ? '，已截断' : ''}）`);
        } else {
            // 没有口径 → 清空这个键 ✓（否则上一次的内容会残留 ✗）
            ctx().setExtensionPrompt(PRESET_GUIDANCE_KEY, '', PROMPT_POSITION.NONE, 0, false);
        }

        directorPresetGuidanceActive = true;   // ← filter 只在推演期间放行 ✓
        let result;
        try {
        result = await runDirector({
            userInput: continuing ? CONTINUE_INPUT : userInput,
            contextBrief: brief,
            generate: buildDirectorGenerate(settings),
            rng: defaultRng,
            maxRounds: settings.maxRounds,
            strictCausality: Boolean(settings.strictCausality),
            continuation: settings.usePrefill ? 'prefill' : 'prompt',
            hitMark: String(settings.hitMark ?? ''),
            person: settings.narrationPerson,
            systemPrompt: directorSystemPrompt,
            shouldStop: () => abortRequested || chatSwitched(),
            sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
            onProgress: (event) => {
                if (event.phase === 'generating') {
                    // 累计本回合实际发出去的提示词字数 —— 调轮数/世界书开关时靠它对照
                    if (Number.isFinite(event.promptChars)) {
                        promptCharsTotal += event.promptChars;
                    }
                    setProgress(`第 ${event.round}/${event.maxRounds} 轮：生成中…`
                        + (promptCharsTotal > 0 ? `（已发出 ${promptCharsTotal} 字）` : ''));
                } else if (event.phase === 'rolled') {
                    const summary = event.rolls.map((r) => `${r.expr}=${r.total}`).join('，');
                    setProgress(`第 ${event.round} 轮：投了 ${summary}`);
                    // ⚠️ 切走之后**绝不能**再往日志里写：`rollLog` 是模块级单例，
                    // CHAT_CHANGED 时已经被 hydrate 成**新聊天**的日志了（见 roll-log.js），
                    // 这时候 add 就是把旧聊天的骰子塞进别人的聊天记录里、还会被收尾落盘。
                    if (chatSwitched()) {
                        debug('推演期间切过聊天，这一轮的骰子不再记入日志');
                    } else {
                        for (const roll of event.rolls) {
                            rollLog.add(roll, { kind: roll.kind, context: `${reason}·第${event.round}轮` });
                        }
                    }
                    refreshPanel();
                } else if (event.phase === 'prefill-fallback') {
                    setProgress(`第 ${event.round} 轮：这个 API 不接受模型回合结尾，已改用内嵌续写重试…`);
                } else if (event.phase === 'error') {
                    setProgress(event.willRetry
                        ? `第 ${event.round} 轮生成失败（第 ${event.attempt} 次），等一会儿重试…`
                        : `第 ${event.round} 轮生成失败`);
                    lastRequestShape = {
                        round: event.round,
                        attempt: event.attempt,
                        promptChars: event.promptChars,
                        systemPromptChars: event.systemPromptChars,
                        prefillChars: event.prefillChars,
                        message: event.message,
                    };
                    warn('这一轮请求失败了，请求体积如下（用来排除"太长被拒"）', lastRequestShape);
                }
            },
        });
        } finally {
            // 无论成功 / 失败 / 中止都要关掉口径注入 ✓（否则下次正文也会被注入 ✗）
            directorPresetGuidanceActive = false;
        }

        lastDirectorRun = {
            at: new Date().toLocaleTimeString(),
            reason,
            userInput,
            finishReason: result.reason,
            rounds: result.rounds,
            rollCount: result.rolls.length,
            outlineChars: result.outline.length,
            error: String(result.error ?? ''),
            warnings: result.warnings,
            transcript: result.transcript,
            requestShape: lastRequestShape,
            promptShape: lastPromptShape,
            promptCharsTotal,
            worldInfoChars: lastWorldInfo?.chars ?? 0,
        };
        lastRequestShape = null;

        // 收工时**必须**把「进度」那行改掉 —— 否则它会永远停在最后那句"生成中…"，
        // 看起来像推演没跑完（用户就是这么报的："进度没跑满就结束了"）。
        setProgress(finishProgressText(result, promptCharsTotal));

        // API 不接受以模型回合结尾 → 推演已经自己回退到内嵌续写；
        // 顺手把那个开关也关掉，免得用户下次又踩（并明确告诉他我们动了什么）。
        if (result.prefillFallback && getSettings().usePrefill) {
            getSettings().usePrefill = false;
            ctx().saveSettingsDebounced();
            syncPanelFromSettings();
            warn('这个 API 不接受以模型回合结尾的请求，已自动关掉 prefill 开关');
            toastr.warning('这个 API（Gemini 等）不接受以模型回合结尾的请求 —— 已自动关掉「用 prefill 续写」，本次已改用内嵌续写跑完', '安科导游');
        }

        refreshPanel();

        if (result.warnings.length > 0) {
            warn('推演过程有警告', result.warnings);
        }

        // 服务端拒绝时的提示。
        //
        // 为什么只能让用户去看酒馆的提示：ST 的 `tryParseStreamingError` 里写着
        // 「these do not throw correctly (equiv to Error("[object Object]"))」——
        // 它 `throw new Error(data)`（data 是对象，message 变成 "[object Object]"），
        // 而且那个 throw 还被它自己的 `catch {}` 吞掉了。**服务端原文只出现在
        // 它弹出的「Chat Completion API」那条 toastr 里**，异常对象里拿不到。
        const errorText = String(result.error ?? '');
        const serverRejection = /got response status|bad request|\b4\d\d\b|\[object/i.test(errorText);
        const hint = /model turn|ending with/i.test(errorText)
            ? '　→ 这个 API 不允许请求以模型回复结尾：把面板里的「用 prefill 续写」关掉再试'
            : (serverRejection
                ? '　→ 服务端拒绝了这次请求。真原因在酒馆自己弹的那条「Chat Completion API」提示里（酒馆把服务端错误对象丢了，我们这边拿不到原文）'
                : '');

        const reasonText = {
            maxRounds: '轮数用完了',
            stalled: '模型没有继续写',
            aborted: '被中断了',
            error: '生成出错',
        }[result.reason] ?? '未知原因';

        const detail = errorText
            || result.warnings.at(-1)
            || '没有更多信息，用 /anko last 看过程记录';

        // ⚠️ 失败**必须**报出来，哪怕是在自动模式里。
        // 之前这里被 quiet 一起吞掉了，导致"勾了自动推演却什么都没发生" —— 静默失败最难查。
        // ★ 剥掉 MVU 那类"变量更新"内容 ✗ —— 用户明确不要它出现在大纲里 ✓。
        //   为什么这里还要剥（注入那边已经过滤过 ✗）：**跟随当前设置**时，酒馆会把
        //   整份当前预设交给导演 ✓，而预设里可能就教了 `<UpdateVariable>` ✗ ——
        //   注入过滤管不到"导演自己写出来" ✓，所以出口必须再剥一次 ✓。
        const beforeStrip = String(result.outline ?? '');
        result.outline = stripVariableUpdateBlocks(beforeStrip);
        if (result.outline !== beforeStrip) {
            log(`已从大纲里剥掉变量更新内容（${beforeStrip.length - result.outline.length} 字）✓`);
        }

        if (!result.outline) {
            fail('推演没有产出内容', { reason: result.reason, error: errorText, warnings: result.warnings });
            toastr.error(`推演没有产出内容（${reasonText}：${detail}）${hint}`, '安科导游');
            return '';
        }

        const suffix = {
            done: '',
            maxRounds: '（达到轮数上限，已用现有定稿收尾）',
            stalled: '（模型没有继续写，已用现有定稿收尾）',
            aborted: '（被中断，这是半成品）',
            error: `（半成品：${errorText || '生成出错'}）${hint}`,
        }[result.reason] ?? '';

        // 半成品用 error 提示，别伪装成成功 —— 否则用户以为跑完了
        if (result.reason === 'error' || result.reason === 'aborted') {
            toastr.error(`只推演出半成品（${reasonText}：${detail}）`, '安科导游');
        } else if (!quiet) {
            toastr.success(`第 ${result.rounds} 轮，投了 ${result.rolls.length} 次骰子${suffix}`, '安科导游');
        }

        // 中途切了聊天 → 这份大纲不属于任何一边，丢掉
        if (chatSwitched()) {
            warn('推演期间切换了聊天，这次结果已丢弃');
            toastr.warning('你在推演期间切换了聊天 —— 这次大纲已丢弃，没有写进任何聊天', '安科导游');
            return '';
        }

        if (deliver === 'input') {
            writeToInput(result.outline);
        }
        // 记进前情 —— 玩家不一定马上发送，下一次推演得靠这个才知道故事走到哪了
        pushOutline(ankoState, result.outline);
        if (settings.directSend) {
            // 不用额外的标志位：大纲已经进了 recentOutlines，
            // 自动推演那边的 matchesRecentOutline() 自然会跳过它（不会推演出"大纲的大纲"）
            sendNow();
        }

        return result.outline;
    } finally {
        // ⚠️ 清理必须**自己也不会炸**：hide() 抛错不能让 setRunning(false) 落空，
        // 否则面板永远停在"正在推演"（停止按钮不消失），只能刷新页面。
        try {
            await handle.hide();
        } catch (error) {
            warn('收起加载提示失败（继续清理）', error);
        } finally {
            setRunning(false);
        }
        // 中途切过聊天就别存 —— 此时 ankoState / rollLog 已经是**另一个聊天**的了，
        // 无条件 saveChatState() 会把这次推演的数据写进别人的聊天文件（串台）。
        if (chatSwitched()) {
            debug('推演期间切过聊天，跳过收尾保存');
        } else {
            saveChatState();
        }
    }
}

/**
 * 面板上「推演本回合」按钮。
 *
 * **按钮只做一件事：推演输入框里那句话。** 不做任何"猜你的意思"的事 ——
 * 空着就提示你写一句，不会偷偷接着往下推演。
 *
 * （一个反面教材：之前这里写成"输入框空着就自动续推一幕"，
 * 结果按钮的含义取决于隐藏状态，用户得靠**连点两次**才能推进 —— 那是胡闹。
 * 想不用打字就推进，请用明确的 `/anko continue`。）
 */
async function handleDirectorButton() {
    if (directorBusy) {
        toastr.warning('正在推演，等这一轮结束（或点「停止」）', '安科导游');
        return;
    }

    const input = String($('#send_textarea').val() ?? '').trim();

    if (!input) {
        toastr.warning(
            hasStoryMemory()
                ? '输入框是空的 —— 写一句玩家想做什么；想不写就直接往下推一幕，用 /anko continue'
                : '输入框是空的 —— 先写一句玩家想做什么',
            '安科导游',
        );
        return;
    }

    // 输入框里还是上一次的大纲：那不是"玩家想做的事"，别拿它去推演
    if (inputHoldsLastOutline()) {
        toastr.warning(
            '输入框里是上一次的大纲 —— 先把它发送出去（或改完再发），再写下一句行动',
            '安科导游',
        );
        return;
    }

    try {
        await runDirectorOnce(input, { reason: '按钮' });
    } catch (error) {
        fail('推演失败', error);
        toastr.error(errorMessage(error), '安科导游');
    }
}

/**
 * 结算**正文 AI 自己写的**骰子（可选，默认关）。
 *
 * 挂 `MESSAGE_RECEIVED`：这条消息已经写进 chat、但还没渲染，
 * 所以改 `mes` 再 `updateMessageBlock` 就能就地替换（规范 §6 里列的那条路）。
 * 两个必须的守卫：① 别理 `quiet`/`impersonate`（后台生成、替身发言）；
 * ② 用户消息与系统消息不碰。
 *
 * @param {number} messageId
 * @param {string} type
 */
async function onMessageReceived(messageId, type) {
    if (!getSettings().resolveAiDice || isDisabledByUser()) {
        return;
    }
    if (type === 'quiet' || type === 'impersonate') {
        return;
    }
    const chat = ctx().chat;
    const message = chat?.[messageId];
    if (!message || message.is_user || message.is_system) {
        return;
    }
    const text = String(message.mes ?? '');
    // 廉价预筛：注意用单字符量词，别用 `\d+[dD]\d+`（那个在长数字串上是 O(n²)，见 inline.js）
    if (!text || !/\d[dD]\d/.test(text)) {
        return;
    }

    try {
        const resolved = resolveDiceInText(text, '正文');
        if (resolved.count === 0) {
            return;
        }
        message.mes = resolved.text;
        try {
            ctx().updateMessageBlock?.(messageId, message);
        } catch (error) {
            warn('重绘消息失败（存档里已经是结算后的文本）', error);
        }
        saveChatState();
        refreshPanel();
        debug('已结算正文里的骰子', { messageId, count: resolved.count, marked: resolved.marked });
        if (resolved.invalid.length > 0) {
            toastr.warning(`正文里有 ${resolved.invalid.length} 段像骰子但解析不过去：`
                + `${resolved.invalid.map((x) => x.raw).join('、')}`, '安科导游');
        }
    } catch (error) {
        // 酒馆会吞掉监听器的异常（只进控制台），所以自己报
        fail('结算正文骰子失败', error);
    }
}

/**
 * 发送前自动推演。
 *
 * ⚠️ **挂的是 `MESSAGE_SENT`，不是 `GENERATION_AFTER_COMMANDS`。这是实跑踩出来的设计错误。**
 *
 * 1.14.0 的 `Generate()` 里的真实顺序（逐行核对）：
 *   · L3925  `processCommands(输入框)` —— 斜杠命令在这里执行，命令不会变成聊天消息
 *   · L3935  `emit(GENERATION_AFTER_COMMANDS, type, options, dryRun)`   ← 我原来挂这里
 *   · L4066  `await sendMessageAsUser(textareaText, …)` —— **用户消息在这里才进 chat**
 *   · L4110+ 提示词组装
 *
 * 也就是说 `GENERATION_AFTER_COMMANDS` 触发时，**最后一条还是角色的上一句回复** ——
 * 「最后一条是用户消息」这个前提根本不成立，监听器每次都从那里返回，自动推演永远不生效。
 *
 * 而 `MESSAGE_SENT` 是在 `sendMessageAsUser` 里 `chat.push(message)` **之后**发的
 * （L5520 / L5526），并且在提示词组装之前。它还自带三道免费的过滤：
 *   · L4060 的守卫已经排除了 `quiet` / `dryRun` / `automatic_trigger`
 *   · 滑动、重新生成、续写都不加用户消息 → 这个事件压根不发
 *   · `emit` 会 await 监听器，所以返回 Promise 就能挡住流程，等推演完再组装提示词
 *
 * @param {number} messageId 刚插进 chat 的那条用户消息的下标
 */
async function onMessageSent(messageId) {
    const trace = {
        at: new Date().toLocaleTimeString(),
        messageId: messageId ?? null,
        autoDirector: Boolean(getSettings().autoDirector),
        busy: directorBusy,
        chatLength: Array.isArray(ctx().chat) ? ctx().chat.length : -1,
        lastIsUser: null,
        decision: '（还没判定）',
    };
    autoTrace.count += 1;
    autoTrace.last = trace;

    /**
     * 记下判定结果并**立刻刷新面板**。
     *
     * 必须刷新：否则钩子即使触发了，面板上还挂着旧数字 ——
     * 那这个诊断就没法用（我自己就先被它坑过一次）。
     */
    const stop = (why) => {
        trace.decision = why;
        refreshPanel();
        debug('自动推演判定：', why);
        return undefined;
    };

    log('MESSAGE_SENT 触发', { messageId: trace.messageId });

    if (isDisabledByUser()) {
        return stop('跳过：扩展已被禁用（1.14.0 不调 disable 钩子，所以这里自己判断）');
    }
    if (!getSettings().autoDirector) {
        return stop('跳过：面板里的「发送前自动推演」没开');
    }
    if (directorBusy) {
        return stop('跳过：上一次推演还在跑');
    }

    const c = ctx();
    const chat = c.chat;
    if (!Array.isArray(chat) || chat.length === 0) {
        return stop('跳过：chat 是空的');
    }
    const index = Number.isInteger(messageId) && messageId >= 0 ? messageId : chat.length - 1;
    const last = chat[index];
    trace.lastIsUser = Boolean(last?.is_user);
    if (!last?.is_user) {
        return stop('跳过：这条不是用户消息');
    }
    if (!String(last.mes ?? '').trim()) {
        return stop('跳过：用户消息是空的');
    }
    if (matchesRecentOutline(last.mes)) {
        return stop('跳过：这条消息本身就是一份大纲，不重复推演');
    }

    trace.decision = '通过守卫，开始推演';
    refreshPanel();
    const originalText = String(last.mes);
    /**
     * 推演要几十秒，期间用户完全可能在输入框里开始打下一句。
     * 只有输入框**没被碰过**时才清空它 —— 否则会擦掉人家刚打的字。
     */
    const inputAtStart = readInput();
    try {
        const outline = await runDirectorOnce(originalText, {
            reason: '自动',
            quiet: true,
            deliver: 'chat', // 大纲要塞进聊天消息，别碰输入框
        });
        if (outline) {
            // 推演要几十秒，期间那条消息可能被编辑/删除，甚至整个 chat 被 reload
            // （`export let chat` 不被重新赋值，但 reloadCurrentChat 会原地换掉内容）。
            //
            // ⚠️ 判断标准是**那个位置还是不是一条用户消息**，**不是文本相等** ——
            // 文本相等太严：酒馆自己（宏替换、重载聊天）或别的扩展动一下就会误判成
            // "消息被改动了"，于是自动推演明明跑完了却什么都不做（真踩过这个假阴性）。
            const fresh = ctx().chat?.[index];
            if (fresh?.is_user) {
                const textChanged = String(fresh.mes) !== originalText;
                fresh.mes = outline;
                try {
                    c.updateMessageBlock?.(index, fresh);
                } catch (error) {
                    warn('重绘用户消息失败（提示词仍会用到大纲）', error);
                }
                trace.textChanged = textChanged;
                trace.decision = `已替换用户消息（大纲 ${outline.length} 字`
                    + `${textChanged ? '，期间文本被别的扩展改过' : ''}）`;
                toastr.info('已用大纲替换本回合的输入', '安科导游');
            } else {
                trace.decision = '推演期间那条消息被删掉了 / 换成了别的，已放弃替换';
                warn('推演期间那条消息不在了，已放弃替换', { index });
            }
            if (readInput() === inputAtStart) {
                writeToInput('');
            } else {
                debug('推演期间输入框被改动过，保留用户新打的内容');
            }
        } else {
            trace.decision = '推演没有产出内容，用户消息没动';
        }
    } catch (error) {
        trace.decision = `抛异常：${errorMessage(error)}`;
        fail('自动推演失败', error);
        toastr.error(errorMessage(error), '安科导游');
    }
    refreshPanel();
}

// ---------------------------------------------------------------------------
// 提示词注入（D8：默认不注入，靠模板开关）
// ---------------------------------------------------------------------------

/** 按模板渲染注入文本；模板为空就清空注入。 */
function renderInjection() {
    const template = String(getSettings().injectTemplate ?? '');
    if (!template.trim()) {
        return '';
    }
    const attrs = Object.entries(ankoState.attributes).map(([k, v]) => `${k} ${v}`).join('　') || '（无）';
    const combat = ankoState.combat && !ankoState.combat.finished ? describeCombat(ankoState.combat) : '无战斗';
    return template
        .replaceAll('{{attrs}}', attrs)
        .replaceAll('{{combat}}', combat)
        .replaceAll('{{story}}', storySoFarText() || '（无）');
}

function applyInjection() {
    try {
        const text = renderInjection();
        ctx().setExtensionPrompt(INJECTION_KEY, text, PROMPT_POSITION.IN_CHAT, INJECTION_DEPTH, false);
    } catch (error) {
        warn('注入状态失败', error);
    }
}

/**
 * 最近几条消息里有没有已经投好的骰子（`【1d10=7】` 这种）。
 *
 * 这是格式约束的**过滤器**：平时返回 false，那份约束就完全不注入、不占 token；
 * 只有真的出现了骰子内容时才注入。1.14.0 的 `setExtensionPrompt` 支持 filter
 * （`script.js` 里 `if (hasFilter && !await prompt.filter())`），所以能做这件事。
 *
 * 注意先做一次 `includes('【')` 的廉价预筛：没有方括号就根本不必跑正则
 * （这段代码在**每次组装提示词**时都会跑，包括别的扩展触发的生成）。
 */
/** 最近一次格式约束过滤器的决策（排障用）。 */
let lastFilterTrace = null;

function hasDiceContent() {
    try {
        // 被禁用之后别再往别人的提示词里插东西（1.14.0 不调 disable 钩子，见 isDisabledByUser）
        if (isDisabledByUser()) {
            lastFilterTrace = { at: new Date().toLocaleTimeString(), result: false, why: '插件被禁用' };
            return false;
        }
        const chat = ctx().chat;
        if (!Array.isArray(chat)) {
            lastFilterTrace = { at: new Date().toLocaleTimeString(), result: false, why: 'chat 不是数组' };
            return false;
        }
        const tail = chat.slice(-4);
        const hit = tail.findIndex((message) =>
            typeof message?.mes === 'string'
            && message.mes.includes('【')
            && /【\d+[dD]\d+=/.test(message.mes));
        lastFilterTrace = {
            at: new Date().toLocaleTimeString(),
            result: hit >= 0,
            why: hit >= 0 ? `最近 4 条里第 ${hit + 1} 条有骰子回执` : '最近 4 条里没有骰子回执',
            scanned: tail.length,
            enabled: Boolean(getSettings().formatLock),
        };
        return hit >= 0;
    } catch (error) {
        warn('判断骰子内容时出错，按"没有"处理', error);
        lastFilterTrace = { at: new Date().toLocaleTimeString(), result: false, why: '判断时出错' };
        return false;
    }
}

/**
 * 注入（或撤销）给正文 AI 的格式约束。
 *
 * ⚠️ **role 必须用 USER，不能用 SYSTEM** —— 这是实测撞出来的：
 *
 * 1. 酒馆在同一深度上按 `['system','user','assistant']` 的顺序生成消息
 *    （`openai.js:764-786`），并且**同深度同角色的注入会被 `\n` 拼成一条**（`jointPrompt`）。
 * 2. 用 SYSTEM 的实际后果（用户 `/anko debug` 录到的原文）：
 *    `格式约束：在（第 13 条，role=system，1667 字）` —— 那条消息 1667 字，
 *    而我的约束只有 239 字，**其余是别的扩展的 system 注入**。
 *    也就是说我被焊在一堵 system 墙的正中间，模型最后读到的是**别人的**约束。
 * 3. 换成 USER：同一深度里 user 排在 system **之后**，于是它成为模型最后读到的一条 ✓
 * 4. 不能用 ASSISTANT：那会让请求以模型回合结尾 → Gemini 直接 400（见 D25）。
 */
function applyFormatLock() {
    try {
        const enabled = Boolean(getSettings().formatLock);
        ctx().setExtensionPrompt(
            FORMAT_LOCK_KEY,
            // 按**当前的标记符号**现拼：符号是可配置的（可能改成 ★，也可能留空关掉打标）
            enabled ? buildFormatLockText(getSettings().hitMark) : '',
            PROMPT_POSITION.IN_CHAT,
            0, // depth 0 = 紧贴生成点
            false,
            PROMPT_ROLE.USER, // 见上面 ②③：SYSTEM 会被埋进 system 墙里
            enabled ? hasDiceContent : null,
        );
    } catch (error) {
        warn('注入格式约束失败', error);
    }
}

// ---------------------------------------------------------------------------
// 核心操作：子系统
// ---------------------------------------------------------------------------

function doSheet() {
    const sheet = rollAttributeSheet({ rng: defaultRng, names: DEFAULT_ATTRIBUTE_NAMES, target: ankoState });
    saveChatState();
    refreshPanel();
    return `车卡完成（${sheet.expr}）：\n${formatAttributes(ankoState)}`;
}

function doGrowth(name) {
    if (!name) {
        return '用法：/anko growth <属性名>，例：/anko growth 话术';
    }
    const result = growthCheck(ankoState, name, { rng: defaultRng });
    rollLog.add({ ...result.roll, kind: 'check', label: result.label }, {
        kind: 'check',
        context: `成长检定·${result.name}`,
    });
    saveChatState();
    refreshPanel();
    return result.grown
        ? `${result.name} 成长检定：1d100 = ${result.roll.total} > ${result.before} → 成长 +${result.gain} → ${result.after}${result.capped ? '（已到上限 99）' : ''}`
        : `${result.name} 成长检定：1d100 = ${result.roll.total} ≤ ${result.before} → 没长进`;
}

/** 战斗里我方单位的数值来自属性表，缺失就给默认值并写回属性表。 */
function syncCombatAttributes() {
    const ensure = (key, fallback) => {
        if (!Number.isFinite(Number(ankoState.attributes[key]))) {
            ankoState.attributes[key] = fallback;
        }
        return Number(ankoState.attributes[key]);
    };
    return {
        hp: ensure(ATTR_HP, COMBAT_DEFAULTS.hp),
        atk: ensure(ATTR_ATK, COMBAT_DEFAULTS.atk),
        def: ensure(ATTR_DEF, COMBAT_DEFAULTS.def),
    };
}

function doCombatBegin(tokens) {
    const [name, hp, def, atk] = tokens;
    if (!name || !Number.isFinite(Number(hp))) {
        return '用法：/anko combat begin <敌人名> <敌人HP> <敌人DEF> [敌人ATK]\n例：/anko combat begin 打手 12 10 45';
    }

    const mine = syncCombatAttributes();
    ankoState.combat = createCombat({
        self: { name: '我', hp: mine.hp, atk: mine.atk, def: mine.def },
        enemy: {
            name,
            hp: Number(hp),
            def: Number.isFinite(Number(def)) ? Number(def) : 0,
            atk: Number.isFinite(Number(atk)) ? Number(atk) : 50,
        },
        maxRounds: COMBAT_MAX_ROUNDS,
        rng: defaultRng,
    });

    saveChatState();
    refreshPanel();

    const init = ankoState.combat.initiative;
    return [
        `战斗开始：我 vs ${name}`,
        `      先攻：我 1d100=${init.selfRoll.total}（+${ankoState.combat.self.initMod}）=${init.self}　`
            + `${name} 1d100=${init.enemyRoll.total}（+${ankoState.combat.enemy.initMod}）=${init.enemy}`,
        `      出手顺序：${init.order.map((k) => (k === 'self' ? '我' : name)).join(' → ')}`,
        `      ${describeCombat(ankoState.combat)}`,
    ].join('\n');
}

function doCombatRound() {
    const combat = ankoState.combat;
    if (!combat) {
        return '现在没有战斗。用 /anko combat begin 开一场。';
    }
    if (combat.finished) {
        return `战斗已经结束了（${resultLabel(combat.result)}）。用 /anko combat begin 开新的一场。`;
    }

    const round = resolveRound(combat, { rng: defaultRng });

    for (const action of round.actions) {
        rollLog.add(action, { kind: 'check', context: `战斗·第${round.round}轮·${action.actorName}` });
    }

    // 我方的 HP 同步回属性表，面板上就能看到
    ankoState.attributes[ATTR_HP] = Math.max(0, combat.self.hp);

    const lines = [`—— 第 ${round.round}/${combat.maxRounds} 轮 ——`];
    for (const action of round.actions) {
        const who = action.actor === 'self' ? '我' : action.actorName;
        const arrow = action.hit ? `命中，伤害 ${action.damage}` : action.fumble ? `大失败，反伤 ${action.recoil}` : '未命中';
        lines.push(`  ${who} 1d100=${action.total}（目标值 ${action.target}）→ ${action.label}，${arrow}`);
    }
    lines.push(`  ${describeCombat(combat)}`);

    if (round.gracefulEnd) {
        lines.push(`  ★ 第 ${combat.maxRounds} 轮仍未分出胜负 → 丝滑收场`);
        lines.push(`    ${round.gracefulEnd.replacement}`);
        lines.push(`    ${round.gracefulEnd.text}`);
    } else if (round.finished && round.result === 'selfDead') {
        const info = markDead(ankoState, `第 ${round.round} 轮被 ${combat.enemy.name} 打倒`);
        lines.push(`  ★ ${combat.enemy.name} 把 HP 打到了 0 —— **玩家角色战死**`);
        lines.push('    这是真死：已落成持久状态，下一次推演会告诉 agent「人已经死了」，不许假装他还活着。');
        lines.push(`    想反悔就 /anko revive（已记录的死亡原因：${info.note}）`);
        toastr.warning('玩家角色已战死。下一轮推演会按「人已经死了」来写。', '安科导游');
    } else if (round.finished) {
        lines.push(`  ★ 战斗结束：${resultLabel(round.result)}（敌方是死是活，留给描写决定）`);
    }

    saveChatState();
    refreshPanel();
    return lines.join('\n');
}

function doCombatStatus() {
    if (!ankoState.combat) {
        return '现在没有战斗。';
    }
    const combat = ankoState.combat;
    const lines = [
        describeCombat(combat),
        `  我：ATK ${combat.self.atk} / DEF ${combat.self.def}`,
        `  ${combat.enemy.name}：ATK ${combat.enemy.atk} / DEF ${combat.enemy.def}`,
    ];
    return lines.join('\n');
}

function doCombatEnd() {
    if (!ankoState.combat) {
        return '现在没有战斗。';
    }
    ankoState.combat.finished = true;
    ankoState.combat.result = 'aborted';
    saveChatState();
    refreshPanel();
    return '战斗已中止。';
}

function doTableRoll(name) {
    if (!name) {
        return `用法：/anko table roll <表名>\n现有的表：${listTables(ankoState.customTables).join('、')}`;
    }
    const table = getTable(name, ankoState.customTables);
    const result = rollTable(table, { name, rng: defaultRng });
    rollLog.add({ ...result, kind: 'roll' }, { kind: 'roll', context: `查表·${name}` });
    saveChatState();
    refreshPanel();
    return [`【${name}】${result.expr} = ${result.total}`, `      ${result.text}`, `      ${result.detail}`].join('\n');
}

function doTableShow(name) {
    const table = getTable(name, ankoState.customTables);
    const normalized = normalizeTable(table, name);
    const lines = [`【${name}】${normalized.dice}，共 ${normalized.entries.length} 段：`];
    for (const entry of normalized.entries) {
        lines.push(`  ${String(entry.from).padStart(3)}–${String(entry.to).padStart(3)}  ${entry.text}`);
    }
    return lines.join('\n');
}

function doTableAdd(tokens) {
    const [name, dice, ...rest] = tokens;
    const texts = rest.join(' ').split('|').map((s) => s.trim()).filter(Boolean);
    if (!name || !dice || texts.length === 0) {
        return '用法：/anko table add <表名> <1dN> <选项1|选项2|…>\n例：/anko table add 今晚吃什么 1d4 面|饭|火锅|随便';
    }
    // 先校验，错了就别写进去
    normalizeTable({ dice, texts }, name);
    ankoState.customTables[name] = { dice, texts };
    saveChatState();
    return `已建表「${name}」（${dice}，${texts.length} 项）。用 /anko table roll ${name} 投它。`;
}

function doBidDraw() {
    const result = bidDraw(ankoState, { rng: defaultRng });
    rollLog.add(result.roll, { kind: 'roll', context: `安价·${result.title || '无标题'}` });
    saveChatState();
    refreshPanel();
    return [
        `${result.title ? `【${result.title}】` : ''}共 ${result.total} 项，投 ${result.roll.expr} = ${result.index}`,
        `      → ${result.option}`,
    ].join('\n');
}

// ---------------------------------------------------------------------------
// 帮助
// ---------------------------------------------------------------------------

function helpText() {
    return [
        '安科导游',
        '',
        '【推演】',
        '  /anko direct [玩家输入]     跑一次导演推演，大纲写进输入框（不给输入就用输入框里的内容）',
        '',
        '【骰子】',
        '  /anko roll <表达式>          投骰，例：3d6k2+1',
        '  /anko check <技能> <成功率>   COC 房规3 检定',
        '  /anko option [项数]          孔明式选项骰（默认 10 项）',
        '  /anko inline <文本>          结算文本里的内联骰子（1d3 →【1d3=2】，支持 1d100【话术40】、1d10【选项】）',
        '  /anko log [条数]             查看骰点日志',
        '  /anko help                   看这份帮助',
        '  别名：d=direct r=roll c=check o=option i=inline a=attr g=growth l=log t=table b=bid h=help；undo=prev cont=continue',
        '',
        '【属性】',
        '  /anko attr show',
        '  /anko attr set <名字> <值>',
        '  /anko attr add <名字> <±差值>',
        '  /anko attr del <名字>',
        '  /anko attr clear             清空所有属性',
        '  /anko attr sheet [1d100]     车卡（默认八项各投一次）',
        '  /anko growth <属性名>        成长检定',
        '  /anko die [原因]             标记玩家角色已战死（真死，会告诉 agent）',
        '  /anko revive                 撤销死亡状态',
        '  /anko prev                   撤回上一幕（退回一版大纲）',
        '  /anko export [all|attrs|settings]  导出为 JSON 文件',
        '  /anko import [JSON]          导入属性/预设（不给 JSON 就开文件选择器）',
        '  /anko float                  面板在侧栏 / 常驻浮窗之间切换',
        '  /anko last                   看最近一次推演的过程记录（失败排障用）',
        '  /anko story [clear]          看 / 清空前情记忆（连续推演靠它）',
        '  /anko continue               不写输入，直接接着前情往下推一幕',
        '  /anko debug                  排障：自动推演钩子走到哪一步了',
        '',
        '【战斗】最多 5 轮，打不完强制丝滑收场',
        '  /anko combat begin <敌人名> <HP> [DEF] [ATK]',
        '  /anko combat round           结算一轮',
        '  /anko combat status',
        '  /anko combat end             中止',
        '',
        '【随机表】',
        '  /anko table list',
        '  /anko table roll <表名>',
        '  /anko table show <表名>',
        '  /anko table add <表名> <1dN> <选项1|选项2|…>',
        '  /anko table del <表名>           删一张表',
        '',
        '【安价】',
        '  /anko bid add <选项1|选项2|…>',
        '  /anko bid list / del <序号> / clear / title <标题>',
        '  /anko bid draw               均等抽一个',
        '',
        '文法：NdM、+/-、X/*（乘）、k（取大）。不支持 # b/p h 骰池 括号 除法。',
    ].join('\n');
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

const cmdRoll = guard((_n, _u, raw) => (raw.trim() ? doRoll(raw.trim(), '斜杠命令') : '用法：/anko roll <表达式>'));
const cmdInline = guard((_n, _u, raw) => doInline(raw));
const cmdLog = guard((_n, _u, raw) => {
    const tokens = tokenize(raw);
    const count = tokens.length > 0 && Number.isFinite(Number(tokens[0])) ? Math.trunc(Number(tokens[0])) : 10;
    return `骰点日志（共 ${rollLog.size()} 条）\n${rollLog.formatLast(count)}`;
});
const cmdCheck = guard((_n, _u, raw) => {
    const tokens = tokenize(raw);
    if (tokens.length < 2) {
        return '用法：/anko check <技能名> <成功率>，例：/anko check 话术 40';
    }
    const rate = Number(tokens[tokens.length - 1]);
    if (!Number.isFinite(rate)) {
        return `最后一项应该是成功率（数字），收到「${tokens[tokens.length - 1]}」`;
    }
    return doCheck(tokens.slice(0, -1).join(' '), Math.trunc(rate), '斜杠命令');
});
const cmdOption = guard((_n, _u, raw) => {
    const tokens = tokenize(raw);
    const count = tokens.length > 0 ? Number(tokens[0]) : DEFAULT_OPTION_COUNT;
    if (!Number.isFinite(count)) {
        return `项数应该是数字，收到「${tokens[0]}」`;
    }
    return doOption(Math.trunc(count), '斜杠命令');
});

const cmdDirector = guard((_n, _u, raw) => {
    const input = raw.trim() || String($('#send_textarea').val() ?? '').trim();
    if (!input) {
        return '用法：/anko direct [玩家输入]。不给输入就用输入框里的内容；\n'
            + '输入框也是空的、而你想不写就直接往下推一幕，用 /anko continue。';
    }
    if (directorBusy) {
        return '正在推演，等这一轮结束（或点面板上的「停止」）。';
    }
    return runDirectorOnce(input, { reason: '命令' })
        .then((outline) => (outline ? '大纲已写进输入框。' : '推演没有产出内容。'))
        .catch((error) => `推演失败：${errorMessage(error)}`);
});

/**
 * 不写玩家输入，直接接着前情往下推一幕。
 *
 * 这是**明确**的一条命令 —— 代替掉之前那个"输入框空着点按钮就自动续推"的隐藏魔法。
 * 用户的原话："为什么要连点两次，这不是胡闹吗"。
 */
const cmdContinue = guard(() => {
    if (directorBusy) {
        return '正在推演，等这一轮结束（或点面板上的「停止」）。';
    }
    if (!hasStoryMemory()) {
        return '还没有可以接着推的剧情 —— 先写一句玩家想做什么，推演出第一幕。';
    }
    // 输入框里还留着上次的大纲时，先清掉，免得又被当成玩家输入
    if (inputHoldsLastOutline()) {
        writeToInput('');
    }
    return runDirectorOnce('', { reason: '续推' })
        .then((outline) => (outline ? '已接着往下推一幕，大纲写进输入框。' : '推演没有产出内容。'))
        .catch((error) => `推演失败：${errorMessage(error)}`);
});

const cmdAttr = guard((_n, _u, raw) => {
    const tokens = tokenize(raw);
    const [sub, name, value] = tokens;

    switch ((sub ?? '').toLowerCase()) {
        case 'show':
        case '':
            return formatAttributes(ankoState);
        case 'sheet': {
            const expr = tokens[1] ?? '1d100';
            const sheet = rollAttributeSheet({ rng: defaultRng, names: DEFAULT_ATTRIBUTE_NAMES, expr, target: ankoState });
            saveChatState();
            refreshPanel();
            return `车卡完成（${sheet.expr}）：\n${formatAttributes(ankoState)}`;
        }
        case 'set': {
            if (!name || value === undefined) {
                return '用法：/anko attr set <名字> <值>';
            }
            const result = setAttribute(ankoState, name, value);
            saveChatState();
            refreshPanel();
            return `${result.name} = ${result.value}`;
        }
        case 'add': {
            if (!name || value === undefined) {
                return '用法：/anko attr add <名字> <±差值>，例：/anko attr add HP -3';
            }
            const result = adjustAttribute(ankoState, name, value);
            saveChatState();
            refreshPanel();
            return `${result.name}：${result.before} → ${result.after}`;
        }
        case 'del': {
            if (!name) {
                return '用法：/anko attr del <名字>';
            }
            const result = removeAttribute(ankoState, name);
            saveChatState();
            refreshPanel();
            return `已删除 ${result.name}（原值 ${result.value}）`;
        }
        case 'clear': {
            const count = Object.keys(ankoState.attributes).length;
            ankoState.attributes = {};
            saveChatState();
            refreshPanel();
            return `已清空 ${count} 个属性。`;
        }
        default:
            return `不认识的子命令「${sub}」。可用：show / set / add / del / clear / sheet`;
    }
});

const cmdGrowth = guard((_n, _u, raw) => doGrowth(tokenize(raw)[0]));

/** 手动标记玩家战死（战斗之外也可能被骰子弄死）。 */
const cmdDie = guard((_n, _u, raw) => {
    const info = markDead(ankoState, raw.trim() || '手动标记');
    saveChatState();
    refreshPanel();
    return `已记录玩家角色战死（${info.note}）。下一次推演会按「人已经死了」来写。\n想反悔就 /anko revive。`;
});

/** 撤销死亡状态。 */
const cmdRevive = guard(() => {
    const info = revive(ankoState);
    saveChatState();
    refreshPanel();
    return info.was ? '已撤销死亡状态。' : '本来就没死（状态里没有死亡标记）。';
});

/** 撤回上一幕：退回一版大纲（前情里存着最近 3 版）。 */
const cmdPrev = guard(() => {
    const info = rollbackOutline();
    if (!info.ok) {
        return info.why;
    }
    return info.restored
        ? `已撤回上一幕：前一版大纲已放回输入框，前情还剩 ${info.left} 版。`
        : `已撤回上一幕：更早的大纲没有留底，前情还剩 ${info.left} 版。`;
});

/** 导出属性 / 预设为 JSON 文件。 */
const cmdExport = guard((_n, _u, raw) => {
    const scope = normalizeScope(raw || panelScope());
    const payload = buildExportPayload(scope);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const result = downloadJson(payload, `anko-${scope}-${stamp}.json`);
    if (!result.ok) {
        return result.why;
    }
    return `已导出${EXPORT_SCOPES[scope]}（浏览器应该开始下载了；失败的话看控制台，JSON 也在那里）。`;
});

/** 导入属性 / 预设。给 JSON 就当场导入，不给就开文件选择器。 */
const cmdImport = guard((_n, _u, raw) => {
    const text = raw.trim();
    if (!text) {
        if (openImportPicker()) {
            return '已打开文件选择器 —— 选一个之前导出的 .json。也可以直接把 JSON 贴在命令后面：/anko import {…}';
        }
        return '这个环境不能开文件选择器，请把 JSON 直接贴在命令后面：/anko import {…}';
    }
    const result = applyImportedJson(text);
    return result.ok ? `已导入：${result.applied.join('；')}` : `导入失败：${result.why}`;
});

/** 面板在侧栏 / 常驻浮窗之间切换。 */
const cmdFloat = guard(() => {
    const info = toggleFloat();
    if (!info.ok) {
        return '切换浮窗失败，看控制台。';
    }
    return info.open
        ? '面板已挂成常驻浮窗（拖标题栏可以移动，点 ⇱ 收回侧栏）。'
        : '面板已收回右侧扩展设置。';
});

/**
 * 排障：自动推演到底走到哪一步了。
 *
 * 自动推演"没效果"有三种截然不同的原因，现象却一模一样：
 *   ① 钩子根本没触发（事件没发 / 监听器没挂上）
 *   ② 触发了但被守卫挡掉（开关没开、这条不是用户消息……）
 *   ③ 通过了、推演跑了、但产出是空的
 * 这条命令把三者区分开 —— 别靠猜。
 *
 * 文本直接复用面板那行的详细版（`statusDetail`），**不再各写一份** ——
 * 之前两份文本分开维护，改了面板忘了命令，测试立刻抓出来了。
 */
const cmdDebug = guard(() => statusDetail());

/**
 * 前情记忆：看 / 清空。
 *
 * 这份记忆就是"连续推演"的命根子 —— 大纲只躺在输入框里，没发送的话
 * 聊天记录里就没有这一回合，下一次推演会从头推演开场。
 */
const cmdStory = guard((_n, _u, raw) => {
    const action = raw.trim().toLowerCase();
    if (action === 'clear' || action === 'reset') {
        const info = clearOutlines(ankoState);
        saveChatState();
        return `已清空前情（原本记着 ${info.cleared} 份大纲）。下一次推演会重新开局。`;
    }
    const text = storySoFarText();
    if (!text) {
        return '现在没有前情记忆：要么还没推演过，要么都已经发送进聊天记录了。';
    }
    return `记着 ${ankoState.recentOutlines.length} 份最近大纲`
        + `（已经发送进聊天记录的那部分不会重复喂）：\n\n${text}`;
});

/**
 * 最近一次推演到底怎么了。
 *
 * 存在的理由：推演失败的原因大多在 API 那一侧（限流、超时、审核拒绝），
 * 只弹一个 toastr 说不清。这个命令把逐轮记录摊开，一眼能看出是"根本没跑"还是"跑到第 3 轮断了"。
 */
const cmdLast = guard(() => {
    if (!lastDirectorRun) {
        return '这次会话里还没跑过推演。';
    }
    const run = lastDirectorRun;
    const lines = [
        `时间：${run.at}　触发：${run.reason}`,
        `结束原因：${run.finishReason}　轮数：${run.rounds}　骰子：${run.rollCount} 次　大纲：${run.outlineChars} 字`,
    ];
    if (run.error) {
        lines.push(`错误：${run.error}`);
    }
    if (run.warnings.length > 0) {
        lines.push('警告：', ...run.warnings.map((item) => `  · ${item}`));
    }
    if (run.promptCharsTotal > 0) {
        const rounds = Number(run.rounds) || 0;
        lines.push(
            `本回合发出去的提示词：**${run.promptCharsTotal} 字**（${rounds} 轮，每轮一份）`,
        );
        if (run.worldInfoChars > 0 && rounds > 0) {
            const repeated = run.worldInfoChars * rounds;
            lines.push(
                `  其中世界书每轮重复 ${run.worldInfoChars} 字 × ${rounds} 轮 = **${repeated} 字**`
                + `（占全部的 ${Math.round(repeated / run.promptCharsTotal * 100)}%）`,
            );
        }
    }
    if (run.requestShape) {
        lines.push(
            '失败那一轮的请求体积（用来排除"太长被拒"）：',
            `  第 ${run.requestShape.round} 轮·第 ${run.requestShape.attempt} 次`
            + `　提示词 ${run.requestShape.promptChars} 字`
            + `（其中系统提示 ${run.requestShape.systemPromptChars} 字`
            + `${run.requestShape.prefillChars ? `、prefill ${run.requestShape.prefillChars} 字` : '、prefill 0 字'}）`,
        );
    }
    if (run.promptShape) {
        const shape = run.promptShape;
        lines.push(
            '失败时那条请求的消息结构：',
            `  ${shape.count} 条：[${shape.roles.join(', ')}]　最后一条=${shape.lastRole}`
            + `${shape.lastRole === 'assistant' ? '  ← 就是它触发了「不能以模型回合结尾」' : ''}`,
        );
    }
    if (run.transcript.length > 0) {
        lines.push('逐轮记录：');
        for (const item of run.transcript) {
            lines.push(`  第 ${item.round} 轮：模型吐出 ${item.chars} 字（上一轮已定稿 ${item.settledBefore} 字）`);
        }
    }
    return lines.join('\n');
});

const cmdCombat = guard((_n, _u, raw) => {
    const tokens = tokenize(raw);
    const [sub, ...rest] = tokens;
    switch ((sub ?? '').toLowerCase()) {
        case 'begin':
        case 'new':
            return doCombatBegin(rest);
        case 'round':
        case 'r':
            return doCombatRound();
        case 'status':
        case 's':
        case '':
            return doCombatStatus();
        case 'end':
        case 'stop':
            return doCombatEnd();
        default:
            return `不认识的子命令「${sub}」。可用：begin / round / status / end`;
    }
});

const cmdTable = guard((_n, _u, raw) => {
    const tokens = tokenize(raw);
    const [sub, ...rest] = tokens;
    switch ((sub ?? '').toLowerCase()) {
        case 'list':
        case '':
            return `可用的表：${listTables(ankoState.customTables).join('、')}`;
        case 'roll':
            return doTableRoll(rest[0]);
        case 'show':
            return doTableShow(rest[0]);
        case 'add':
            return doTableAdd(rest);
        case 'del': {
            const name = rest[0];
            if (!name || !Object.hasOwn(ankoState.customTables, name)) {
                return `没有自定义表「${name}」`;
            }
            delete ankoState.customTables[name];
            saveChatState();
            return `已删除自定义表「${name}」`;
        }
        default:
            return `不认识的子命令「${sub}」。可用：list / roll / show / add / del`;
    }
});

const cmdBid = guard((_n, _u, raw) => {
    const tokens = tokenize(raw);
    const [sub, ...rest] = tokens;
    const restRaw = rest.join(' ');

    switch ((sub ?? '').toLowerCase()) {
        case 'add':
        case '+': {
            const result = bidAdd(ankoState, restRaw);
            saveChatState();
            refreshPanel();
            return `已加 ${result.added.length} 项，共 ${result.total} 项。`;
        }
        case 'list':
        case '':
            return formatBid(ankoState);
        case 'del':
        case '-': {
            const result = bidRemove(ankoState, rest[0]);
            saveChatState();
            refreshPanel();
            return `已移除「${result.removed}」，还剩 ${result.total} 项。`;
        }
        case 'clear': {
            const result = bidClear(ankoState);
            saveChatState();
            refreshPanel();
            return `已清空 ${result.cleared} 项。`;
        }
        case 'title': {
            const title = bidSetTitle(ankoState, restRaw);
            saveChatState();
            return `本轮安价标题：${title || '（空）'}`;
        }
        case 'draw': {
            const text = doBidDraw();
            return text;
        }
        default:
            return `不认识的子命令「${sub}」。可用：add / list / del / clear / title / draw`;
    }
});

const cmdAnko = guard((named, unnamed, raw) => {
    const tokens = tokenize(raw);
    if (tokens.length === 0) {
        return helpText();
    }
    const [sub, ...rest] = tokens;
    const restRaw = rest.join(' ');

    switch (sub.toLowerCase()) {
        case 'direct':
        case 'd':
            return cmdDirector(named, restRaw);
        case 'roll':
        case 'r':
            return cmdRoll(named, restRaw);
        case 'check':
        case 'c':
            return cmdCheck(named, restRaw);
        case 'option':
        case 'o':
            return cmdOption(named, restRaw);
        case 'inline':
        case 'i':
            return cmdInline(named, restRaw);
        case 'log':
        case 'l':
            return cmdLog(named, restRaw);
        case 'attr':
        case 'a':
            return cmdAttr(named, restRaw);
        case 'growth':
        case 'g':
            return cmdGrowth(named, restRaw);
        case 'die':
            return cmdDie(named, restRaw);
        case 'revive':
            return cmdRevive(named, restRaw);
        case 'prev':
        case 'undo':
            return cmdPrev(named, restRaw);
        case 'export':
            return cmdExport(named, restRaw);
        case 'import':
            return cmdImport(named, restRaw);
        case 'float':
            return cmdFloat(named, restRaw);
        case 'last':
            return cmdLast(named, restRaw);
        case 'story':
            return cmdStory(named, restRaw);
        case 'continue':
        case 'cont':
            return cmdContinue(named, restRaw);
        case 'debug':
            return cmdDebug(named, restRaw);
        case 'combat':
            return cmdCombat(named, restRaw);
        case 'table':
        case 't':
            return cmdTable(named, restRaw);
        case 'bid':
        case 'b':
            return cmdBid(named, restRaw);
        case 'help':
        case 'h':
            return helpText();
        default:
            return `不认识子命令「${sub}」。\n\n${helpText()}`;
    }
});

function registerCommands() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx();

    const commands = [
        { name: 'anko', callback: cmdAnko, description: '安科导游（22 个入口，敲 /anko help 看全部）：direct / roll / check / option / inline / attr / growth / die / revive / prev / export / import / float / last / story / continue / debug / combat / table / bid / log' },
        { name: 'anko-direct', callback: cmdDirector, description: '跑一次导演推演，大纲写进输入框' },
        { name: 'anko-roll', callback: cmdRoll, description: '投骰，如 3d6k2+1' },
        { name: 'anko-check', callback: cmdCheck, description: 'COC 房规3 检定' },
        { name: 'anko-option', callback: cmdOption, description: '孔明式选项骰' },
        { name: 'anko-inline', callback: cmdInline, description: '结算文本里的内联骰子' },
        { name: 'anko-attr', callback: cmdAttr, description: '属性：show / set / add / del / clear / sheet' },
        { name: 'anko-growth', callback: cmdGrowth, description: '成长检定' },
        { name: 'anko-die', callback: cmdDie, description: '标记玩家角色已战死' },
        { name: 'anko-revive', callback: cmdRevive, description: '撤销死亡状态' },
        { name: 'anko-prev', callback: cmdPrev, description: '撤回上一幕（退回一版大纲）' },
        { name: 'anko-export', callback: cmdExport, description: '导出属性/预设为 JSON' },
        { name: 'anko-import', callback: cmdImport, description: '导入属性/预设 JSON' },
        { name: 'anko-float', callback: cmdFloat, description: '面板在侧栏/常驻浮窗之间切换' },
        { name: 'anko-last', callback: cmdLast, description: '查看最近一次推演的过程记录（排障）' },
        { name: 'anko-story', callback: cmdStory, description: '查看或清空前情记忆' },
        { name: 'anko-continue', callback: cmdContinue, description: '不给输入，直接接着前情往下推一幕' },
        { name: 'anko-debug', callback: cmdDebug, description: '排障：自动推演钩子走到哪一步了' },
        { name: 'anko-combat', callback: cmdCombat, description: '战斗：begin / round / status / end' },
        { name: 'anko-table', callback: cmdTable, description: '随机表：list / roll / show / add / del' },
        { name: 'anko-bid', callback: cmdBid, description: '安价：add / list / del / clear / title / draw' },
        { name: 'anko-log', callback: cmdLog, description: '查看骰点日志' },
    ];

    let registered = 0;
    const errors = [];
    for (const item of commands) {
        try {
            SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name: item.name,
                // ⚠️ 必须用 displayed() 包一层：guard 只做错误处理、不显示（见它的注释），
                // 显示只发生在"注册出去的那一层" —— 否则 /anko xxx 会弹两遍。
                callback: displayed(item.callback),
                returns: '文本结果',
                unnamedArgumentList: [
                    SlashCommandArgument.fromProps({
                        description: '[参数]',
                        typeList: [ARGUMENT_TYPE.STRING],
                        isRequired: false,
                    }),
                ],
                helpString: `<div>${item.description}</div>`,
            }));
            registered += 1;
        } catch (error) {
            errors.push(`/${item.name}：${errorMessage(error)}`);
            fail(`注册 /${item.name} 失败`, error);
        }
    }

    log(`已注册 ${registered}/${commands.length} 个斜杠命令`);
    return { registered, total: commands.length, errors };
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

let initialized = false;

function registerListeners() {
    const { eventSource, eventTypes } = ctx();

    // 切聊天要重新装载状态；切之前必须**立即**存，防抖版会放弃保存
    // 投骰工具：来源/模型一变，`isToolCallingSupported()` 的答案就可能变
    listen(eventTypes.MAIN_API_CHANGED, () => {
        const state = syncDiceTool(true);
        debug(`API 变了 → 投骰工具：${state.registered ? '已注册' : state.reason}`);
    });
    listen(eventTypes.CHATCOMPLETION_SOURCE_CHANGED, () => {
        const state = syncDiceTool(true);
        debug(`来源变了 → 投骰工具：${state.registered ? '已注册' : state.reason}`);
    });
    listen(eventTypes.CHATCOMPLETION_MODEL_CHANGED, () => {
        syncDiceTool(false);
    });

    listen(eventTypes.CHAT_CHANGED, () => {
        chatEpoch += 1; // 推演中途切走的判定靠它（见 chatSwitched）
        // 清掉**模块级排障缓存**：它们不属于任何聊天，留着就会让面板的 ⚠ 行、
        // `/anko last`、状态里的"世界书取了 N 字"显示**上一个聊天**的数据。
        lastDirectorRun = null;
        lastWorldInfo = null;
        lastRequestShape = null;
        lastPromptShape = null;
        lastFilterTrace = null;
        autoTrace.count = 0;
        autoTrace.last = null;
        loadChatState();
        applyInjection();
        applyFormatLock();
        debug('已切换聊天，状态重新装载');
    });

    // 发送前自动推演。
    //
    // ⚠️ 挂 MESSAGE_SENT，**不是** GENERATION_AFTER_COMMANDS —— 用户消息是在
    // `sendMessageAsUser` 里才进 chat 的，而那个事件发得更早，那时最后一条还是角色的回复。
    // 详见 onMessageSent 的注释。
    // 注意：**必须把 Promise 返回给事件系统**（不能 `void` 掉）——
    // 酒馆会 await 监听器的返回值，返回了才会等推演完再组装提示词。
    listen(eventTypes.MESSAGE_SENT, (messageId) => onMessageSent(messageId));

    // 结算正文 AI 自己写的骰子（可选，默认关）
    listen(eventTypes.MESSAGE_RECEIVED, (messageId, type) => onMessageReceived(messageId, type));

    // 记录"即将发出的请求"的消息角色结构（排障用，只读）。
    //
    // 用 `makeLast` 注册 —— 这样看到的是**所有扩展都处理完之后**的最终数组：
    // 如果最后一条真是 assistant，就能确认是结构问题而不只是内容问题。
    // 某些版本/分支没有 makeLast，那就退化成普通监听（顺序仍是最后注册的最后跑）。
    if (typeof eventSource.makeLast === 'function') {
        eventSource.makeLast(eventTypes.CHAT_COMPLETION_PROMPT_READY, recordPromptShape);
        listeners.push([eventTypes.CHAT_COMPLETION_PROMPT_READY, recordPromptShape]);
    } else {
        listen(eventTypes.CHAT_COMPLETION_PROMPT_READY, recordPromptShape);
    }

    listenersRegistered = true;
}

async function init() {
    if (initialized) {
        return;
    }
    initialized = true;

    try {
        // ⚠️ 顺序要紧：**必须在 getSettings() 之前**读旧版本号。
        // getSettings() 会用默认值补齐缺失的键（包括 settingsVersion），
        // 那样 fromVersion 先被补成最新值，`fromVersion < SETTINGS_VERSION` 永远为 false
        // —— 迁移一次都不会跑（没有该键的老存档就永远停在旧默认值上）。
        const fromVersion = Number(ctx().extensionSettings?.[MODULE_NAME]?.settingsVersion ?? 0);
        const store = getSettings();
        if (fromVersion < SETTINGS_VERSION) {
            lastSettingsMigration = migrateSettings(store, fromVersion);
            store.settingsVersion = SETTINGS_VERSION;
            ctx().saveSettingsDebounced();
            if (lastSettingsMigration.length > 0) {
                // 改的是用户的设置，必须说出来，不能偷偷改
                log('设置已迁移：', lastSettingsMigration);
            }
        }

        loadChatState();
        registerListeners();
        await mountPanel();
        applyInjection();
        // 投骰工具（P2）：设置加载完、面板挂上之后再裁决一次
        syncDiceTool(true);
        applyFormatLock();
        log('初始化完成');
    } catch (error) {
        fail('初始化失败', error);
    }
}

// (`teardown()` 已随 hooks 一起删掉 ✓ —— 它原本只被 onDisable/onDelete 调用 ✗。
//  如果将来要做"禁用时清理"，应该挂官方支持的钩子，而不是留一个没人调的清理函数 ✗)

// 命令同步注册（越早越好）
try {
    const stats = registerCommands();
    commandStats.registered = stats.registered;
    commandStats.total = stats.total;
    commandStats.errors = stats.errors;
} catch (error) {
    commandStats.errors.push(errorMessage(error));
    fail('注册斜杠命令时出错', error);
}

try {
    getSettings();
} catch (error) {
    fail('初始化设置失败', error);
}

// 异步初始化挂 APP_READY：它在页面已就绪时会对新监听者自动重放，所以不会错过时机
try {
    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.APP_READY, () => {
        setTimeout(() => void init(), 0);
    });
} catch (error) {
    fail('挂 APP_READY 失败', error);
}

// 排障入口
try {
    ctx().registerDebugFunction?.(
        'anko_dump',
        '安科导游：导出状态',
        '把每聊天状态与骰点日志打到浏览器控制台',
        async () => {
            log('状态', ankoState);
            log('骰点日志', rollLog.toJSON());
        },
    );
} catch (error) {
    warn('注册 Debug 函数失败（不影响使用）', error);
}

// ---------------------------------------------------------------------------
// 生命周期钩子 —— **已删除** ✓（用户定：不保留）
// ---------------------------------------------------------------------------
// 原来这里导出了 onInstall / onUpdate / onDelete / onClean / onEnable / onDisable /
// onActivate，manifest 里也声明了 `hooks` ✓。删掉的原因：
//   · 实测本地 **ST 1.14.0** 的 `public/scripts/extensions.js` 里**搜不到 `hooks`** ✓
//     → 这个版本根本不调用它们 ✗，声明的 7 个 hook 是**不会执行的死配置** ✗
//   · 里面的逻辑都有替代/冗余 ✓：
//       onUpdate 的迁移 → `init()` 里已经做过（L4171 同一段 migrateSettings ✓）
//       onDisable/onDelete 的 `teardown()` → 只为它们存在 ✗（禁用/删除时酒馆会重载页面 ✓）
//       onClean 的清数据 → **没有替代** ✗（如果以后要"一键清空"，
//                            应该做成 `/anko clear` 斜杠命令 ✓，而不是指望 hook）
// 如果将来酒馆版本开始调用 hooks、而你需要"删除时清数据"这类能力，
// 再按当时的官方文档重新加 ✓ —— 不要提前声明不会生效的东西 ✗。

// 给测试和将来的模块用
export {
    ankoState as _state,
    helpText as _helpText,
    runDirectorOnce as _runDirectorOnce,
    // 测试缝：导入预设（集成测试要断言"不许传 skipUpdate: true" ✓）
    importPresetToSt as _importPresetToSt,
};