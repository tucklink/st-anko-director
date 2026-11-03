# 文档索引（关键词 → 文件:行）

> 用途：**改代码前先查这里** ✓。行号会随编辑漂移，所以更稳的做法是
> `npm run ask <关键词>` ✓（它直接在当前文本里搜）。

## 一、规则 / 玩法

| 关键词 | 位置 |
| --- | --- |
| 安科是什么 | `docs/安科规则调研.md:8` |
| 孔明式（十项表、加权、大成功/大失败） | `docs/安科规则调研.md:27` |
| 1D100 检定与大成功阈值 | `docs/安科规则调研.md:69` |
| 骰点文法 | `docs/安科规则调研.md:97` · `README.md:180` |
| 判定双轨 | `docs/设计书.md:359` · `README.md:195` |
| 选项表命中标注（♛） | `docs/设计书.md:310` · `README.md:248` |

## 二、导演 agent

| 关键词 | 位置 |
| --- | --- |
| 为什么用 generateRaw | `docs/设计书.md:197` |
| 循环结构（截断续写） | `docs/设计书.md:207` |
| 内联骰子写法（prompt 要教死四条） | `docs/设计书.md:262` |
| 导演能看世界书吗 | `docs/设计书.md:631`（D52：看不到，要自己塞） |
| 连续推演与前情记忆 | `README.md:304` |
| 锁死正文格式 | `README.md:365` |

## 三、酒馆交互（最常翻车的区域）

| 关键词 | 位置 |
| --- | --- |
| **不许猜（铁律）** | `docs/开发规范与踩坑清单.md:12` |
| 扩展怎么被加载 | 同 `:88` |
| `loading_order` 的 NaN 坑 | 同 `:101` |
| **生命周期钩子（1.14.0 忽略）** | 同 `:140` |
| 生成拦截器 | 同 `:167` |
| 常用事件实参 | 同 `:226` |
| `Generate()` 内部真实顺序 | 同 `:258` |
| `manifest.json` 字段全表 | 同 `:284` |
| `getContext()` 能拿到什么 | 同 `:306` |
| 初始化时序怎么选 | 同 `:377` |
| 状态放哪里（settings / chatMetadata / 角色卡 / 预设） | 同 `:395` |
| 提示词注入五条路 | 同 `:407` |
| **预设 / 连接配置的契约** | `docs/设计书.md:630`（D51）· `docs/开发规范与踩坑清单.md:565` · `README.md:484` |
| **传 `max_tokens` 会覆盖预设** | `docs/开发规范与踩坑清单.md:565` |
| 预设默认 300 | 同 `:567` |
| `reasoning_effort` 会随请求发出 | 同 `:546` |

## 四、额度 / 空正文

| 关键词 | 位置 |
| --- | --- |
| 空正文（思考吃光额度） | `docs/开发规范与踩坑清单.md` §7.0 · §7.0.2 |
| 官方文档：推理模型 1024–4096 | <https://docs.sillytavern.app/usage/prompts/reasoning/> |
| `generateRaw` 的 `responseLength` | `public/script.js:3635`（酒馆源码） |

## 五、桌面版 / 打包

| 关键词 | 位置 |
| --- | --- |
| Electron 起不来（命名管道） | `docs/独立桌面版.md` §5 |
| npm 缓存 EPERM | 同 §1 |
| `.cmd` 不能写中文/带 BOM | 同 §6 |
| SEA 单文件 exe | `tools/build-sea.mjs` · `docs/独立桌面版.md:25` |

## 六、官方规范（外部）

| 主题 | 链接 |
| --- | --- |
| UI 扩展开发（manifest / 初始化 / 状态 / 命令 / i18n / hooks） | <https://docs.sillytavern.app/for-contributors/writing-extensions/> |
| 连接配置 | <https://docs.sillytavern.app/usage/core-concepts/connection-profiles/> |
| 推理模型与额度 | <https://docs.sillytavern.app/usage/prompts/reasoning/> |
