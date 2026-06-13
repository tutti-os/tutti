<div align="center">

<img src="docs/assets/tutti-logo.png" alt="Tutti logo" width="120" />

# Tutti

**人与 Agent「同频」协作的地方。**

[官网](https://tutti.sh) · [文档](docs/README.md) · [参与贡献](CONTRIBUTING.zh-CN.md)

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-tutti.sh-black.svg)](https://tutti.sh)

<!-- TODO: banner 图 / 产品截图 -->

</div>

---

## Tutti 是什么？

Agent 默认各做各的。Tutti 提供了一个共享的实时工作空间：上下文、文件、应用、任务，全部打通。

Codex 能看到 Claude 的产出。一个 Agent 调完应用，产出的结果下一个 Agent 就能接着用，无需重复说明。

无需命令行工具 / 终端，上手简单。

## 功能

### 实时工作空间

Agent 不再简单交接摘要，而是共享同一个实时工作空间。你的 Codex 能看到 Claude 改了什么、什么正在运行、项目现在处于什么状态。

共享：上下文 · 文件与产物 · 运行态 · 应用

<!-- TODO: workspace 截图 -->

### 原生应用

Tutti 里的应用，你和你的 Agent 都可以使用。你可以亲自上手，也可以让任意 Agent 调用。支持图像、视频等内容的生成，来源包括官方、社区共建，或者你自己搭建。

<!-- TODO: 应用截图 -->

### 任务编排

无需手动拆分每一步。你只需要描述目标。Tutti 会把它拆解为清晰的任务。你只需要审核，再分配给合适的 Agent。

<!-- TODO: 任务截图 -->

### 统一管理

不用再在多个 Tab 中来回切换。一个视图看全局：所有 Agent 对话、待你审批的操作、正在运行的任务。需要你确认的地方，快速定位一键批。

<!-- TODO: 控制中心截图 -->

## 你可以用 Tutti 做什么

- 让 Codex 继续 Claude 的工作，不用重新交代背景
- 让 Claude 写 PRD，然后在同一个工作空间里调用设计应用
- 在云端工作空间里打开队友的本地网站，不需要先部署
- 直接引用队友的 Agent 线程，不用再让对方总结一遍
- 把任务分配给队友的 Agent，让工作不再只围绕一个人流转

## Tutti · 本地版 vs Tutti · 云端版

|              | Tutti · 本地版                                                    | Tutti · 云端版                                                        |
| ------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| **适合场景** | 单人 + 多 Agent                                                   | 多人 + 多 Agent                                                       |
| **运行环境** | 本地电脑                                                          | 云端工作空间（跨设备）                                                |
| **共享能力** | 上下文、文件、输出、任务、运行状态，在你自己的多个 Agent 之间共享 | 上下文、文件、输出、任务、运行状态，在团队所有人及所有 Agent 之间共享 |
| **订阅**     | 使用你自己的 Claude、Codex、Gemini 等订阅                         | 同左                                                                  |
| **价格**     | 免费                                                              | 早期体验免费；后续按席位订阅                                          |

Tutti 兼容你已有的 Claude、Codex、Gemini 或其他 Agent 订阅。无论本地版还是云端版，都不需要额外购买模型套餐。

本仓库包含的是 **Tutti · 本地版**：桌面应用与本地守护进程，基于 Apache-2.0 协议免费开源。Tutti · 云端版是独立的托管服务，其代码不在本仓库中。

## FAQ

### 我需要重复购买 Agent 订阅吗？

不用。Tutti 直接使用你已有的 Claude、Codex、Gemini 或其他订阅 / API 访问。

### 如果我现在没有任何 Agent 订阅怎么办？

你之后可以在 Tutti 内直接使用 Tutti Agent。Tutti Agent 早期体验期免费，后续可能按量计费。

### Tutti · 本地版和 Tutti · 云端版有什么区别？

本地版适合你自己一个人和多个 Agent 协作。云端版适合团队成员、多个设备、共享云端产物都需要进入同一个工作空间的场景。

### 队友能看到我的未公开内容吗？

只有你主动共享到云端工作空间的内容，队友才能看到。本地工作始终保留在你自己的电脑上。

### Tutti 会取代我现有的 coding agent 吗？

不会。Tutti 是围绕 Agent 的工作空间。你可以继续使用你信任的 Claude Code、Codex、Gemini 等智能体。

### Tutti 只适合写代码吗？

不止。编程、设计、内容、应用流程，以及任何需要多人或多 Agent 共享上下文和产物的工作，都可以用 Tutti。

## 快速开始

### 下载

<!-- TODO: Tutti · 本地版下载链接 -->

下载 Tutti · 本地版 —— 即将开放。

<!-- TODO: Tutti · 云端版 waitlist 链接 -->

加入 Tutti · 云端版 waitlist —— 即将开放。

### 从源码构建

环境要求：

- Node.js `24` 或更高（`.node-version` 固定了基线版本）
- pnpm `10.11.0`
- Go `1.24`

```sh
pnpm install
pnpm setup:dev
make dev-gui
```

完整开发指南见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。

## 社区与贡献

欢迎参与贡献——请先阅读[贡献指南](CONTRIBUTING.zh-CN.md)，并了解我们的[行为准则](CODE_OF_CONDUCT.md)。

报告安全漏洞请参见 [SECURITY.md](SECURITY.md)。

<!-- TODO: 社区渠道（Discord / X / 微信群） -->

## 协议

Tutti 基于 [Apache License 2.0](LICENSE) 开源。

> 注：本代码库使用内部代号 `tutti`，你会在目录和二进制命名中看到它（如 `services/tuttid`）。

> 翻译说明：本文档与英文版内容同步，如有出入，以 [英文版](README.md) 为准。
