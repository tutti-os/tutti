<div align="center">

<img src="docs/assets/banner.jpg" alt="Tutti" width="100%" />

**人与 Agent「同频」协作的地方。**

[官网](https://tutti.sh/?tc=25q) · [文档](docs/README.md) · [参与贡献](CONTRIBUTING.zh-CN.md)

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-tutti.sh-black.svg)](https://tutti.sh/?tc=25q)

</div>

---

如果你喜欢 Tutti，欢迎给我们一个 Star，或者 Fork 仓库、提交 Issue、发起 PR。

也欢迎感兴趣的朋友加入我们的微信群，分享反馈、提出问题，一起定义人与 Agent 协作的未来。

<img src="docs/assets/zh/wechat-group.png" alt="扫码加入 Tutti 微信群" width="240" />

**Tutti，现已开源。**

**Tutti · VM 正在路上，有兴趣的各位，欢迎到官网加入我们的 Waitlist：**

**[tutti.sh →](https://tutti.sh/?tc=25q)**

## 快速开始

[下载 Tutti · Local macOS 版](https://tutti.sh/desktop/download?platform=macos&arch=universal&format=dmg)

Windows 版本即将推出。

<!-- TODO: Tutti · VM waitlist 链接 -->

加入 [Tutti · VM waitlist](https://tutti.sh/waitlist) —— 即将开放。

完整开发指南见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。

## Tutti 是什么？

你的 Claude Code 很强，Codex 也很强，Canvas 很强，Claude Design 也很强。

可涉及到真实的工作流，需要互相依赖、彼此接力的时候。

这其中，最忙的常常是你。

Claude 写完接口，Codex 要接前端，你复制接口文档、补充当前进度，再解释刚才为什么这么写。前端之前，想要页面好看还涉及到设计、做图，总结一下再用生图应用出了图。又下载、上传、贴给下一个 Agent，再去描述一下需求。

说好是让 Agents 帮你干活，最后你成了它们之间的传话筒。

### Tutti 提供了一个实时共享的工作空间：上下文、文件、应用、任务，全部打通

![Tutti 的实时共享工作空间](docs/assets/zh/workspace-hero.jpg)

Codex 能无缝使用 Claude 的产出，彼此不丢任何上下文，一致得像「共脑」。

不仅如此，Tutti 还有自己的应用生态：生图、UI/UX 设计、写文档、做 PPT；你能用，Agent 也能用。

Codex 调用原型设计应用做好了设计，就像拥有了 Claude Design 的能力；Claude Code 可以直接拿去做页面开发，不用你来回复制粘贴。

**一切在 Tutti 中彼此可见、互相依赖。任何产物，包括应用生成的输出，都能在不同 Agent 之间流转、传递，直接用于下一步。**

## 如果这是你，欢迎你来用用！

- 同时用多个 AI Agent（Codex、Claude Code、Canvas 等等）
- 不止一次在 Agent 之间复制过上下文，甚至自己搭了个 Markdown 文档交接的工作流
- 什么事都想让 AI 做，却总觉得还没那么顺手，换个新 Agent 上下文都得从头再来
- 尝试过订阅其他 AI 产品，却又觉得不够划算
- 面对更复杂的工作流时：不同产品之间是孤岛，来回搬运同步的步骤只会变得更多

**Tutti 不是替代你的 coding agent，而是 Agent-Agent 实时共享的工作空间。**

<p align="center">
  <img src="docs/assets/zh/why-tutti.jpg" alt="Tutti 是 Agent 与 Agent 实时共享的工作空间" width="70%" />
</p>

## 三大核心功能

### 1）实时共享的工作空间

Agent 不再简单交接摘要，而是共享同一个实时工作空间：共享上下文、文件、在跑的任务、应用。你的 Codex 能看到 Claude 改了什么、正在运行什么、项目当前处于什么状态。

所以你解锁了三项能力：

#### Big「@」

- 你可以在 Codex 中 @ 历史对话、文件、应用、任务；无需反复粘贴、上传。
- 你也可以在 Codex 中 @ Claude Code 的历史对话、文件、应用、任务，并在此基础上构建，无需手动搬运上下文。
- 你也可以在 Codex 中，让 Codex 指挥、@ Claude Code（应用）干活。

<p align="center">
  <img src="docs/assets/zh/at-history.jpg" width="32%" />
  <img src="docs/assets/zh/at-claude.jpg" width="32%" />
  <img src="docs/assets/zh/at-command.jpg" width="32%" />
</p>

#### 引用「+」

在 Agent 对话框点击「+」：引用本地文件、引用应用生成的产物。

<p align="center">
  <img src="docs/assets/zh/plus-reference.jpg" width="60%" />
</p>

#### 任务编排与多项目构建

各 Agent 彼此「可见」，因此可以自动回避或处理冲突，自己判断该并行还是串行。跨不同服务提供方的 Agent，比如 Claude 和 Codex、OpenClaw 和 Hermes，一样不打架。

**Tutti · VM 中：**

- 「@」流动在协同者之间，你可以 @ 朋友与他任意 Agent 的对话、文件、任务，也可以点击「+」引用朋友调用应用生成的产物。

### 2）人-Agent 共用的「应用」

完整的工作很少只靠一个 Agent。

做一个页面，可能要先出原型，再写代码，再补图。写一篇文章，也可能要配图、排版、导出。这些能力都有很强大的 Agent 承接，你挨个付费，然后来回打开、下载、上传、截图、粘贴。工作还没变难，搬东西先搬烦了。

Tutti 里有自己的应用中心，也实时共享整个工作空间。这些应用你可以自己使用，也可以被你的 Agent 调用。

<img src="docs/assets/zh/apps-1.jpg" width="49%" /> <img src="docs/assets/zh/apps-2.jpg" width="49%" />

<img src="docs/assets/zh/apps-3.jpg" width="49%" /> <img src="docs/assets/zh/apps-4.jpg" width="49%" />

**比如：**

- 在 Codex @ 原型设计应用生成 UI 稿，让 Codex 长出 Claude Design 的能力，生成好的东西再让 Codex 拿去开发。
- 你自己用生图应用（AI Canvas）生成了配图，让 Claude Code 或 Codex 帮你放进页面里。
- 讨论好文章框架，@ Codex 用文档应用起草、整理，再帮你生成一个 HTML。
- 过几天要做个 Pre？有个产品介绍想对外发一发？@ Claude Code 用 PPT 应用生成演示文稿。几处细节想手动调一调？不用担心，这里的 AI PPT 支持你自由拖拽模块、编辑文案。

<img src="docs/assets/zh/ppt-1.jpg" width="49%" /> <img src="docs/assets/zh/ppt-2.jpg" width="49%" />

<img src="docs/assets/zh/ppt-3.jpg" width="49%" /> <img src="docs/assets/zh/ppt-4.jpg" width="49%" />

应用产物都会留在同一个工作空间里。下一步需要时，一个「+」引用一下，就能接上。

这些应用也都复用你已有的 Agent 订阅，不把这些能力包一层再卖给你。你可以使用官方、社区创建的应用，也可以自己创建。

### 3）少操作，多产出（Less work about work）

#### 从目标到任务

不用手动拆分、规划每一步。你只需要描述目标，比如「我想做一个网页」。Tutti 会把它拆解为清晰的子任务。你只需要审核，再分配给合适的 Agent。

<p align="center">
  <img src="docs/assets/zh/goal-to-tasks.jpg" width="60%" />
</p>

#### 控制中心

不用在多个 Tab 中来回切换。一个视图看全局：所有 Agent 对话、待你审批的操作、正在运行的任务。需要你确认的地方，快速定位，一键处理。

<p align="center">
  <img src="docs/assets/zh/control-center.jpg" width="60%" />
</p>

#### GUI 界面

无需命令行。打开 Tutti，就能使用 Agents、应用、任务和文件。重度 AI 用户可以少折腾几步，不想碰终端的产品、设计、内容创作者也能直接上手。

## 复用你原有的订阅

直接接入你已有的 Claude、Codex 等订阅。所有应用和 Agent 都在此基础上运行，零额外费用。

<img src="docs/assets/zh/subscriptions-1.jpg" width="49%" /> <img src="docs/assets/zh/subscriptions-2.jpg" width="49%" />

## Tutti vs Tutti · VM

|              | Tutti（开源）                                                                                       | Tutti · VM（即将上线）                                                                                                                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **适合谁**   | 一个人，多个 Agent                                                                                  | 一个人，多个 Agent<br>一个人，多台设备<br>两人及以上，各自带着自己的 Agent                                                                                                                                                       |
| **跑在哪**   | Agent 跑在本地，工作态在本地                                                                        | 采用多层虚拟机技术，把你的本地 Agent 虚拟化进一个实时共享的云端工作空间。<br><br>Agent 仍然跑在本地，工作态实时进云端：正在聊的、正在跑的、做好了的……于是你能跨设备、跨人、跨 Agent 协作，彼此不丢任何上下文，一致得像「共脑」。 |
| **共享什么** | 多个 Agent 之间共享上下文、应用、产物、任务和运行状态                                               | 包含本地版的全部内容，另外支持在多人、多设备之间共享                                                                                                                                                                             |
| **订阅**     | 你自己的 Claude、Codex 等订阅<br>（目前仅支持 Claude Code、Codex；OpenClaw、Hermes 正在开发接入中） | 你自己的 Claude、Codex 等订阅<br>（目前仅支持 Claude Code、Codex；OpenClaw、Hermes 正在开发接入中）                                                                                                                              |

### Tutti：你可以用它来做什么？

- 让 Codex 接着 Claude 的工作继续做，不用重新说明上下文。
- 让 Claude 写完 PRD 后，直接调用设计应用生成图片。
- 用你已有的 Agent 订阅，调用 Tutti 内的所有应用。
- 描述一个目标，让 Tutti 拆成多个子任务，再把每个分配给合适的 Agent 执行。

### Tutti · VM：你可以用它来做什么？

**包含 Tutti 的全部能力，额外实现：**

- 开一个云端房间，让多台设备在里面工作，就像在用同一台电脑。
- 和朋友协作时，不用互相发文件、贴进度、复述 Agent 刚做了什么。只要在同一个云端房间，就能看到彼此在房间里的对话、文件、产物、任务进展和应用生成的结果。
- 用「@」引用同事的文件、与 Agent 的对话等，让你的 Agent 在此基础上继续构建。
- 你本地跑起来的网站（localhost），不用先部署上线，朋友就能在云端房间里直接打开预览，给你提意见、帮你改。
- 当一件事需要多人，把任务分配给同事的 Agent 执行。

> ⚠️ 以上共享以房间为维度：邀请人与受邀人需加入同一房间，只有在同一房间内产出的内容才会被共享，其余内容都保持私密。

## Tutti 适合谁？

任何用 AI Agent 来 build 的人：只要你受够了在不同 Agent、应用之间来回切换，受够了反复重新交代背景、手动搬运产物，受够了为每份订阅单独花钱，Tutti 就是为你设计的。

- **独立开发者**：让 Claude 出方案，Codex 接力开发，不用再重复解释项目背景。
- **设计师**：用设计应用出设计稿，直接让 Codex 拿去开发落地。
- **产品经理**：让 Codex 写完 PRD 后，自动调用 UI/UX 设计应用出原型，不用再打开 Figma。
- **内容创作者**：脚本、配图，在同一个工作空间里一站式产出。

无论你是什么角色，都能在这里找到各环节里摩擦最低的使用组合。全 GUI 界面，无需终端命令行，打开就能用。

### Tutti · VM 呢？

Tutti 先解决你和你的 Agents。

Tutti · VM 要解决的是：当工作往外走，不同人、不同设备、彼此的 Agents 怎么待在同一个实时共享空间里 —— 即多人的 Agent-Agent 协作。

**通过多层虚拟机技术，把你的本地 Agent 虚拟化进一个实时共享的云端工作空间。**

在这里，Agent 仍然跑在你的本地，继续使用你自己的订阅和配置。但工作态会在神奇的云端：正在聊的、正在做的、已经做好的，都会留在同一个 Room 里。网站、图片、文档、PPT 不需要再上传下载，复制链接就能分享。

你和朋友进入同一个 Room，你可以「@」他昨晚做到一半的任务，也可以把一段工作交给他的 Agent 接着跑。

**Room 在这里，是边界，也是绿洲。**

## FAQ

### 我需要另外购买一个 Agent 订阅吗？

不需要。Tutti 可以使用你已经在用的 Claude、Codex 以及其他受支持订阅。

### 如果我没有 Agent 订阅怎么办？

你可以在 Tutti 内使用 Tutti Agent。Tutti Agent 在 Early Access 期间免费，之后可能会采用按用量计费。

### Tutti 和 Tutti · VM 有什么区别？

如果你想和团队成员协作、跨多台设备工作，或者希望把产物保存在一个共享的云端工作空间里，可以使用 Tutti · VM。

### 在 Tutti · VM 版本里，我的团队成员能看到我的私人工作内容吗？

只有在 Tutti · VM 的房间内创建的内容，才会被你邀请进该空间的人看到。其他内容都会保持私密。

### Tutti 会替代我的 coding agent 吗？

不会。Tutti 是围绕你的 agents 构建的工作空间。你仍然可以继续使用你已经信任的 Claude Code、Codex 和其他受支持 agents。

### Tutti 只适合 coding 吗？

不是。Tutti 适用于 coding、设计、内容创作、应用工作流，以及任何需要多个 agents 或团队成员共享同一上下文和产物的工作场景。

## Star 趋势

<a href="https://www.star-history.com/?repos=tutti-os%2Ftutti&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=tutti-os/tutti&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=tutti-os/tutti&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=tutti-os/tutti&type=date&legend=top-left" />
 </picture>
</a>

## 贡献者

[![Contributors](https://contrib.rocks/image?repo=tutti-os/tutti)](https://github.com/tutti-os/tutti/graphs/contributors)

## 社区与贡献

欢迎参与贡献——请先阅读[贡献指南](CONTRIBUTING.zh-CN.md)，并了解我们的[行为准则](CODE_OF_CONDUCT.md)。

报告安全漏洞请参见 [SECURITY.md](SECURITY.md)。

## 协议

Tutti 基于 [Apache License 2.0](LICENSE) 开源。

> 注：本代码库使用内部代号 `tutti`，你会在目录和二进制命名中看到它（如 `services/tuttid`）。

> 翻译说明：本文档与英文版内容同步，如有出入，以 [英文版](README.md) 为准。
