# 阅读 · Reading

一个 DSH 阅读域插件：本地 EPUB 书架、阅读器、选中文本向 AI 提问、把问答整理成笔记，支持书签与阅读进度。

入口在左侧栏的**阅读**图标；阅读页是一个独立主面板（与「插件」「自动化任务」同级）。

## 功能

- **书架**：导入本地 EPUB（浏览器文件选择或 Host 路径），封面、作者、章节数、阅读进度；搜索、排序、删除。
- **阅读器**：按 EPUB 源文件排版渲染（标题、段落、引文、列表、注音 `ruby`、插图），目录跳转、字号/行距/字体/内容宽度/纸张主题、阅读进度自动保存、书签。
- **左书右对话**：阅读页固定分栏——左侧正文，右侧「阅读对话」常显（窄屏自动改为上下排布）。中间分隔条可按住向左拖，对话区最宽 45%，也可用 ←/→ 调整。对话按书独立，切换书籍自动清空。
- **对话与 DSH 一致**：流式输出、可展开的「思考过程」（reasoning）、每条回答标注所用模型、左下角模型选择器（跟随默认 / 指定 provider+model，目录来自 `ctx.llm.listModels`）、停止与失败重试、复制、存笔记、带入主对话。选定的模型会随之后每次提问发送。
- **选段提问**：左键选中文字（或右键）后浮出意图菜单「解释这段 / 字词训诂 / 典故出处 / 译成现代汉语 / 自己提问 / 记笔记 / 复制」→ 回答流式写入右侧对话；**右键点击已选中的文字会直接按「解释这段」提问**；可继续追问、停止、重试。
- **整理成笔记**：任意一条回答可「存为笔记」（原文 + 问题 + 回答），按书/章节归集，可补记、编辑、删除、导出 Markdown。
- **带入对话**：把某条问答写成一条待发送消息并打开新对话，交给主 agent 继续深挖（agent 可调用阅读工具）。
- **Agent 工具**：`reading_shelf`、`reading_chapter`、`reading_search`、`reading_import`、`reading_notes`，让 agent 直接读取书架、章节、检索原文、整理笔记。

## 数据位置

默认 `$DSH_HOME/reading`（Windows 上通常是 `C:\Users\<user>\.dsh\reading`）：

```
reading/
  library.json          书架、进度、书签、界面设置
  notes.json            笔记
  books/<id>/meta.json  单本书元数据
  books/<id>/content.json  归一化章节（块模型）
  books/<id>/cover.*    封面
  books/<id>/assets/    内联图片
  books/<id>/source/    原始 EPUB
```

书架数据在 Host 上，换浏览器、换端口都不会丢；agent 也能读到同一份数据。

## 配置

在 `cordis.patch.yml` 的 `reading` 行里可选配置：

```yaml
- id: reading
  config:
    libraryDir: reading          # 绝对路径，或相对 $DSH_HOME；支持 ~/ 开头
    maxImportBytes: 209715200    # 单本导入上限，默认 200 MiB
    ask:
      provider: deepseek         # 留空则用当前默认模型
      model: deepseek-chat
      contextChars: 6000         # 选段前后原文上下文预算
      maxTokens: 1200
```

## 桥接方式

浏览器半（`client.js`）与 Host 之间全部走 Connection 的认证路由：一元请求 POST 到
`/api/reading/rpc`（`{ endpoint, payload }`），文件字节与流式回答走 `/api/reading/*`。
所有通道都由浏览器带签名 Cookie 访问，无需额外令牌。

> 注意：不要用 `ctx.connection.rpc.handle('/reading', ...)` 注册专用 RPC 通道。该 API 在当前
> DSH 运行时里会在内部解析 `owner.webServer` 时抛出 `cannot get property "webServer" without inject`；
> 若在异步回调里调用，未处理的 Promise 拒绝会让整个 Host 进程退出（表现为 DSH 崩溃）。
> 这条教训来自 2026-11-09 的真实崩溃：在异步续体里调用 `rpc.handle`，Host exit 1，DSH 连续崩溃三次。

## 开发与预检（重要）

**改完代码先跑预检，绿了再启用，绝不用"装进主力 profile 试一下"当验证手段。**

```powershell
cd D:\Personal\dsh-plugins\dsh-plugin-reading
node scripts/preflight.mjs
```

预检依次执行：语法检查 → 重建 `client.js` → EPUB 解析 34 项 → Host 书库/工具 16 项 →
Host 路由 17 项（浏览器真正调用的 5 条路由 + SSE）→ **`apply()` 冒烟（复刻会崩的那一类）** →
客户端 wire 10 项（fetch/上传/SSE 解析）→ 客户端 bundle 注册 6 项 → 无头渲染 21 个视图状态。
任一红灯即退出非零。

## 测试与当前验证状态

| 套件 | 覆盖 | 结果 |
|---|---|---|
| `test/epub.test.mjs` | ZIP/OPF/spine/NCX/块模型/古籍自动分章 | 34/34 |
| `test/host-smoke.mjs` | 导入、进度、书签、笔记、检索、RPC、agent 工具 | 16/16 |
| `test/routes-smoke.mjs` | `/api/reading/*` 五条路由 + 流式 SSE + 错误码 | 17/17 |
| `test/apply-smoke.mjs` | `apply()` 不产生未处理拒绝、路由/工具注册齐全 | 3 组 |
| `test/client-api-smoke.mjs` | 客户端 RPC/上传/SSE + store 打开书/跳章/进度/书签/笔记/设置/带入对话 | 20/20 |
| `test/client-bundle-smoke.mjs` | bundle 物化、主面板+侧栏+词典注册 | 6/6 |
| `test/render-smoke.mjs` | 视图状态渲染 + 目录/内链/书签/存笔记/设置点击链路 + 真实宋词目录页 | 27/27 |

2026-11-09 实机状态：bundle 已安装并写入 desktop profile 的 `dsh.profile.bundles`（重启不丢）；
运行中的页面里 `sidebar.panellist` 与 `main` 槽位均实测含 `reading`；已导入 4 本真实 EPUB
（論語 22 章、論語集註 23 章、唐诗三百首 1 章、宋词鉴赏辞典 729 章）；agent 阅读工具实测可用。

人工验收（2026-11-09，用户确认）：书架/阅读器正常；书内目录页链接可跳章；选中文本 → 问 AI →
**流式回答整条链路正常**；「存为笔记」后笔记页可见；书签写入目录抽屉；滚动后重新打开书籍能回到
上次位置。

已知问题修复记录：

- 书内「目录页」链接点不动 → 相对内链改为按标题匹配章节目录后跳转（宋词鉴赏辞典目录页
  870 条内链中 682 条可定位，其余降级为普通文字）；目录抽屉与正文内链的点击跳章均已加回归测试。

开发期推荐用 DSH 的独立 dev server（源码检出执行 `pnpm dsh web --patch ./cordis.patch.yml`），
验证通过后再对 desktop profile 启用；插件里的未捕获异步异常会直接带走 Host 进程。

**宿主半（`index.js` / `host/*.js`）的改动不会热更**：启用中的进程仍跑旧模块，改完需要重启 DSH
（退出并重新打开应用）才生效；只改 `client-src/` 并重新构建 `client.js` 时，刷新页面即可。

## v1 范围与已知限制

- 仅支持 EPUB；PDF 留待后续版本。
- EPUB 支持 stored/deflate 压缩；bzip2/lzma/zstd 压缩的极端文件会给出警告并跳过。
- 扫描版/图片型 PDF 不在范围内。
- 章节识别：优先按 EPUB 内 `<h1>`–`<h3>` 拆分；无标题的古籍长文按「學而第一 / 第X篇」等
  篇名自动切分（论语实测 22 章）；诗集类（如《唐诗三百首》单文件无篇目标记）可能仍是一整章。
- 部分公版书（如 Gutenberg）的版权页章节会被自动丢弃，书名中的 Gutenberg 前缀会被清理。
- 书内「目录页」里的相对链接按**链接文字匹配章节目录**跳转（宋词鉴赏辞典实测 682/870 条可定位）；
  无法定位的内链降级为普通文字，不会再打开无效的应用 URL。同名篇目（如不同作者的同一词牌）
  可能落到第一个同名章节。
