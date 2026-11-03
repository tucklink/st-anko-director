# 扩展骨架（SillyTavern 前端扩展范本）

一套「照官方规范写、把已知坑都绕开」的 SillyTavern（酒馆）**前端扩展**起手模板。
纯 ESM、零依赖、无需构建：改完存盘、刷新酒馆页面就能看到效果。

它不是成品插件，而是**骨架 + 规范**：把扩展该有的生命周期、设置持久化、面板 UI、
提示词注入、事件监听、斜杠命令、i18n、生命周期钩子全部搭好，你只需要往里面填业务逻辑。

> 配套的规范与踩坑说明在 [docs/开发规范与踩坑清单.md](docs/开发规范与踩坑清单.md)，
> 每一条结论都标了官方文档出处或源码位置。**建议先读那份，再动这里的代码。**

---

## 目录结构

```
.
├── manifest.json          # 扩展清单：ST 靠它发现并加载扩展
├── index.js               # 入口（ESM）。生命周期、设置、UI、事件、拦截器、斜杠命令
├── settings.html          # 设置面板模板（Handlebars），由 renderExtensionTemplateAsync 渲染
├── style.css              # 样式，全部作用域限定在扩展自己的根类名下
├── i18n/
│   ├── zh-cn.json         # 简体中文（键 = 英文原文）
│   └── zh-tw.json         # 繁体中文
├── install.ps1            # 用目录联接把本仓库挂进酒馆，方便边改边测
├── LICENSE                # AGPL-3.0（官方推荐；要投稿官方内容库必须有 libre 许可证）
├── docs/                  # 规范与踩坑清单
└── _research/             # 调研底稿（已 gitignore，不属于扩展本体）
```

---

## 安装

### 方式 A：目录联接（推荐，边改边测）

```powershell
.\install.ps1 -StPath 'D:\SillyTavern'
```

脚本会把本目录联接为 `<ST>\public\scripts\extensions\third-party\st-extension-skeleton`。
联接不复制文件，改本仓库即改酒馆加载的代码。删除联接：

```powershell
.\install.ps1 -StPath 'D:\SillyTavern' -Remove
```

### 方式 B：手工复制

把整个文件夹（除 `_research/`、`docs/` 外都行）复制到
`<ST>\public\scripts\extensions\third-party\` 下，目录名建议 `st-extension-skeleton`。

### 方式 C：发布后从酒馆里安装

推到 Git 仓库，然后 酒馆 → **扩展** → **Install extension** → 粘贴仓库地址。
（注意：从 UI 安装时扩展挂在 `third-party/` 下，无论「仅自己」还是「所有用户」，
HTTP 路径都是 `/scripts/extensions/third-party/<目录名>/`。）

装好后刷新页面，在「扩展」面板里确认它已被识别并启用。

---

## 改造清单（改名时这几处必须一起改）

| 位置 | 常量 / 字段 | 说明 |
| --- | --- | --- |
| `manifest.json` | `display_name`、`author`、`homePage`、`version` | 展示信息 |
| `manifest.json` | `generate_interceptor` | 必须等于 `index.js` 里的 `INTERCEPTOR_NAME` |
| `manifest.json` | `i18n` | 只列**非英文**语言；英文是回退语言，没有语言文件 |
| `index.js` | `MODULE_NAME` | `extensionSettings` 的键，全局唯一 |
| `index.js` | `EXTENSION_PATH` | 必须是 `third-party/<实际安装目录名>`，否则面板模板 404 |
| `index.js` | `INTERCEPTOR_NAME` | 挂到 `globalThis` 的名字 |
| `index.js` | `INJECTION_KEY` | `setExtensionPrompt` 的键，全局唯一 |
| `index.js` | `COMMAND_NAME` | 斜杠命令名 |
| `index.js` | 所有 `#st_ext_skeleton_*` | 面板 DOM id；同时改 `settings.html` |
| `install.ps1` | `-Name` 默认值 | 目录名 |
| `i18n/*.json` | 键 | 键必须与 HTML 里的英文原文**逐字一致** |

改完记得把 `defaultSettings.settingsVersion` 和 `SETTINGS_VERSION` 一起动，
并在 `migrateSettings()` 里写上对应迁移——否则老用户的设置结构会停在旧版本。

---

## 这个骨架已经处理好的事

- **初始化时序**：同步部分（拦截器、斜杠命令）在模块加载时完成；依赖 DOM 的部分挂在 `APP_READY`
  上。`APP_READY` 在页面已就绪时会对新监听者自动重放，所以不存在「错过时机」的问题。
- **设置持久化**：默认值自动补齐（升级后新增的键对老用户也生效）+ 版本化迁移 + 防抖保存。
- **面板 UI**：`renderExtensionTemplateAsync` 渲染独立模板，自带 DOMPurify 清洗与 `data-i18n` 翻译。
- **监听器治理**：全部登记在册，`onDisable` 时整批摘除，不会因为反复启用而重复触发。
- **提示词注入**：用 `setExtensionPrompt` 而不是改写 `chat`（`chat` 是真实存档）；
  关闭时主动清空注入；静默生成（`type === 'quiet'`）跳过，避免自我污染；带重入保护。
- **每聊天数据**：用 `chatMetadata` + `saveMetadataDebounced`，切聊天时经 `CHAT_CHANGED` 重新装载。
- **生命周期钩子**：`install/update/activate/enable/disable/clean/delete` 七个都已接好。
- **日志前缀**：统一 `[扩展骨架]`，方便在控制台过滤。

---

## 调试要点

- 打开浏览器控制台：加载失败、模板 404、i18n 缺失都会在这里报。
  ST 加载扩展失败时会写 `Could not activate extension third-party/<name>`。
- 只改 `index.js` / `style.css` / `i18n/*.json` → 刷新页面即可。
  改 `manifest.json` → 建议重启酒馆进程，或至少强刷（缓存会咬人）。
- 面板控件不响应 → 多半是 `settings.html` 里的 id 与 `index.js` 里选择器不一致。
- 面板没出现 → 检查 `EXTENSION_PATH` 是否等于真实安装目录名。
- 中文没生效 → 确认酒馆界面语言是「简体中文」，并且 `i18n/zh-cn.json` 的键与
  `data-i18n` 里的英文原文完全一致（键就是英文原文本身）。
- 想暴露个诊断入口：用 `registerDebugFunction(id, name, desc, fn)`，它会出现在 Debug 菜单里。

---

## 已知限制（都源于 ST 的设计，不是骨架的问题）

- 前端扩展**无法安全保存密钥**：`extensionSettings` 是明文且所有扩展都能读。需要密钥就走
  服务端插件（Server Plugin），但依赖服务端插件的扩展不能被官方内容库收录。
- `extension_prompt_types` / `extension_prompt_roles` 这两个枚举**没有**暴露在 `getContext()` 里，
  骨架因此在本地按源码值定义了 `PROMPT_POSITION` / `PROMPT_ROLE`。
- 消息渲染钩子 `messageFormatter.addHook()` 官方仍标为 **staging 特性**。`release` 分支源码里代码与
  `getContext().messageFormatter` 都已存在，但你的发行版能不能用要先探测一下再依赖。
- 用户点「启用/禁用扩展」时酒馆默认会刷新页面，所以运行时状态不需要自己重建；
  但用 API 关掉刷新（`reload=false`）时就必须依赖 `onDisable` 里的清理。

---

## 许可

AGPL-3.0-only，见 [LICENSE](LICENSE)。这是官方对投稿扩展的推荐许可证。

## 参考

- 官方文档：[UI Extensions](https://docs.sillytavern.app/for-contributors/writing-extensions/)
- 官方基础模板：[city-unit/st-extension-example](https://github.com/city-unit/st-extension-example)
- 官方构建模板：[SillyTavern/Extension-WebpackTemplate](https://github.com/SillyTavern/Extension-WebpackTemplate)
- 前端加载源码：[public/scripts/extensions.js](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions.js)
- `getContext` 全部字段：[public/scripts/st-context.js](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/st-context.js)
