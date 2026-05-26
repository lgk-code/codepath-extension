# CodePath 浏览器扩展

[中文](README.md) | [English](README.en.md)

CodePath 是一个面向 GitHub 源码阅读的浏览器插件。安装后，它会在 GitHub 仓库页面右侧显示一个侧边栏，帮助你快速理解项目结构、技术栈、功能实现路径、当前文件和后续追问。

## 下载使用

最新版 Chrome / Edge 扩展下载：

- [下载 CodePath.zip](https://github.com/lgk-code/codepath-extension/releases/latest/download/CodePath.zip)
- [备用：打开最新版 Release 页面](https://github.com/lgk-code/codepath-extension/releases/latest)

安装步骤：

1. 下载 `CodePath.zip` 并解压到一个固定目录。
2. 打开 Chrome 的 `chrome://extensions` 或 Edge 的 `edge://extensions`。
3. 开启“开发者模式”。
4. 点击“加载已解压的扩展程序”或“加载解压缩”，选择刚解压出来的扩展目录。
5. 打开任意 GitHub 仓库页面，右侧会出现 CodePath 侧边栏。

首次配置：

- 打开 CodePath 设置页，填写 Qwen 或 OpenAI-compatible 模型的 API Key。
- Base URL 默认是 `https://dashscope.aliyuncs.com/compatible-mode/v1`，也可以直接粘贴完整 `/chat/completions` 或 `/models` 地址，保存时会自动归一化。
- 点击“获取模型”自动拉取模型列表；如果接口不支持 `/models`，仍可手动填写模型名。
- 点击“保存并校验设置”，CodePath 会检查模型连接并探测当前接口是否支持流式输出。
- GitHub Token：可选，用于提高 GitHub API 限额和访问私有仓库。

Release 包不内置 API Key 或 GitHub Token。你的密钥只保存在当前浏览器扩展环境的本地存储中。

## 主要功能

- 在 GitHub 仓库页面显示可调整宽度的 CodePath 侧边栏。
- 分析项目概览：用途、技术栈、目录职责、入口文件和推荐阅读路线。
- 分析功能路径：例如登录、上传、搜索、训练流程、缓存管理等目标功能。
- 解释当前 GitHub 文件页面。
- 支持连续追问，并根据当前分析结果生成推荐问题。
- 支持 Markdown 渲染、源码路径链接、流式输出探测和普通返回回退。
- 显示回答耗时、缓存状态和模型 / GitHub 连接诊断。

## 演示

演示网站位于 [docs/index.html](docs/index.html)，包含浏览器插件使用流程和真实项目分析案例。

## 常见问题

- 浏览器里没有变化：在 `edge://extensions` 重新加载 CodePath，并刷新 GitHub 页面。
- GitHub 404 或私有仓库无法访问：配置具备 Contents read 权限的 GitHub Token。
- GitHub rate limit：配置 GitHub Token 后重试。
- 模型 401/403：检查 API Key、模型访问权限和服务商账号状态。
- 模型 404：检查 Base URL 是否是 OpenAI-compatible `/v1` 地址，或直接粘贴完整 `/chat/completions` 地址让 CodePath 自动归一化，并确认模型名正确。
- 回答慢：查看结果中的阶段耗时，区分 GitHub 请求、文件读取、上下文构造和模型请求耗时。
- 流式看起来像一次性返回：设置页会显示实时流式、疑似缓冲、不支持流式或失败回退；部分代理会缓冲 SSE。

## 安全说明

CodePath 会把你配置的 API Key 和 Token 存在当前浏览器扩展环境的本地存储中，不会写入仓库，也不会包含在 Release 下载包里。不要在 issue、PR 或聊天记录中粘贴真实密钥。
