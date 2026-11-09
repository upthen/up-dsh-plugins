# up-dsh-plugins

DSH Plugins of upthen

## 插件 · Plugins

| 插件 | 说明 |
|---|---|
| [阅读 · Reading](dsh-plugin-reading/) | 本地 EPUB 书架与阅读器：左书右 AI 对话（流式回答 / 思考过程 / 模型切换）、选段提问、笔记、书签与阅读进度；数据持久化在宿主用户目录，并向 agent 提供阅读工具。 |

## 安装 · Install

每个插件目录都自带 `package.json`、`cordis.patch.yml` 与 README。通过 DSH 的插件管理器安装本地目录：

```powershell
plugin_manager install_bundle target=<绝对路径>/dsh-plugin-reading
```

安装前先在该插件目录运行预检（各插件 README 有说明），例如：

```powershell
cd dsh-plugin-reading
node scripts/preflight.mjs
```

## License

[MIT](LICENSE)
