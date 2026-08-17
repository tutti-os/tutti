# Mobile AgentGUI And DeviceLink Design

Status: accepted product direction; Personal direct-lane MVP currently disabled

## Implementation progress (2026-08-11)

The release-enabled `packages/device-link` core now preserves the production ICE,
QUIC, certificate-pinning, candidate filtering and privacy behavior extracted
from TSH. It also owns the shared generation fence, authenticated link pool,
per-peer establishment serialization, connection race, annealed path-probe
cache, trickle-ICE facade, and rolling ALPN compatibility seam. Product
adapters still own room/device identity, rendezvous, Relay credentials and
fallback policy. Personal Desktop and Android consume the same authenticated
facade; the direct lane includes paired-device rendezvous, framed Agent HTTP,
request deadlines, event streaming and foreground/background close behavior.
The shared `candidateexchange` coordinator now owns immediate ICE credential
publication, local candidate coalescing and exact-snapshot retries, plus remote
push-with-poll reconciliation. Personal Desktop consumes it directly; the
gomobile `ActionPump` facade lets Android and iOS start `Connect` before STUN
gathering finishes while Go owns publication/refresh workers, retry timers, and
polling. TypeScript performs signed rendezvous I/O and validates the returned
authoritative attempt before resolving an action. TSH still consumes the
lower-level Trickle primitives and remains a post-release adapter migration
rather than a workspace replacement.
Android 15 ARM64 emulator build/install/start and authenticated loopback
integration pass. Mobile's Relay stream race and native consumer integration are
now implemented; real-account physical-device network transitions and end-to-end
Relay verification remain hardening work. A stable
tag still requires the authenticated lifecycle checks and reproducible Mobile
AAR consumer build to pass at the release head. TSH cutover to the shared
manager remains a consumer-side rollout step.

The Mobile shell now uses mutually exclusive unauthenticated/authenticated DI
children and one active workspace child. Login, pairing, DeviceLink lifecycle,
workspace catalog, Agent Target directory, navigation identity, drafts,
polling, and command execution live in pure TypeScript services rather than
screen effects. Workspace state is projected from one
`AgentSessionEngine`; Desktop and Mobile share generated-tuttid DTO mapping
through `@tutti-os/agent-activity-tuttid-adapter`, shared realtime-observation
rules through `@tutti-os/agent-activity-core`, and DOM-free conversation and
Rail projections through `@tutti-os/agent-gui`. Mobile Rail state contains only
membership and pagination metadata; canonical Session entities remain in the
Engine. Conversation-list visual alignment remains the next UI milestone.

## 1. 背景

Tutti Personal 已经拥有本机 Agent Host、Agent Activity、AgentGUI 和完整的会话交互能力。TSH 已经拥有 DeviceLink、ICE/QUIC 打洞、STUN rendezvous 和 Relay fallback。下一步需要把两者组合成一个 Android-first 的移动端 AgentGUI，让同一账号下的手机可以连接用户自己的电脑并操作 Agent 会话。

这不是 Remote SSH、远程桌面或本机任意端口隧道。移动端消费现有公开 Agent/Workspace API，并以适合移动设备的方式呈现会话列表、对话流和 Composer。

本设计先在 Tutti Personal 验证。TSH/VM 在第二阶段接入同一移动端核心和 DeviceLink 基础设施，不建立另一套协议、会话实体或 UI 业务核心。

## 2. 目标

1. Android 手机与登录同一账号的 Tutti Personal 电脑完成显式配对。
2. 连接优先使用 P2P，失败时自动切换到 tsh-tunnel-relay。
3. 手机通过现有生成客户端、Agent Activity 和 Agent Host 完成会话读取与操作。
4. 移动端主视图为对话流，会话列表通过侧边抽屉打开。
5. Personal、TSH/VM 共用 canonical Agent 协议和 DeviceLink 核心。
6. Agent 数据保留在电脑端；控制面和 Relay 不持久化会话内容。
7. MVP 优先验证完整可用闭环，不被跨平台 UI 组件统一阻塞。

## 3. 非目标

MVP 不包含：

- Remote SSH、Terminal、远程桌面或任意 localhost 端口转发；
- iOS 真机验收、TestFlight、App Store 和 release 签名；
- 后台长期运行、系统推送和通知操作；
- 离线读取、离线写队列和会话内容持久缓存；
- 文件上传、图片输入、语音输入、富文本编辑器、`@` 引用选择器；
- 完整复制桌面右侧面板；
- TSH/VM 用户入口；
- Web 与 React Native 组件源码的全面统一；
- 长期多版本协议兼容矩阵；只保留 TSH 切换期间有界、可观测、可删除的临时 ALPN
  seam。

## 4. 设计原则

### 4.1 一个事实，一个所有者

- Session、Turn、Interaction、Goal 和 runtime operation 的生命周期仍由 `packages/agent/host` 唯一定义。
- 移动端使用同一个 workspace `AgentSessionEngine` 语义，不创建 `MobileSession`、`RemoteSession` 或第二套会话状态机。
- `tsh-server` 只拥有账号、设备、配对、在线发现和短期 rendezvous 状态。
- DeviceLink 只拥有认证链路、product-neutral 双路径竞速和双向流，不解释 Agent
  DTO；direct/Relay 身份认证与选路策略由产品 adapter 注入。
- React Native 只拥有导航、展示和设备本地的临时 UI 状态。

### 4.2 复用协议，不镜像页面

移动端不传输桌面 HTML，也不复制 DOM。它通过现有 Agent OpenAPI DTO、事件协议和生成客户端获取结构化数据，再使用 Native 组件渲染。

移动端可以暂时只展示完整协议中的一部分设置，但不得增加简化版创建接口或写死 Agent、模型、权限和运行模式。后续补齐 Composer 设置只能是增加 UI 暴露面，不应重做底层协议。

### 4.3 事件降低延迟，快照负责校准

事件流不是独立真相。进入 workspace、打开会话、事件缺口、网络重连和前台恢复都通过权威快照校准。手机不持久化可恢复的 Agent 状态机。

### 4.4 先闭环，再统一组件实现

MVP 从第一天复用行为、projection、状态语义和现有视觉语言。Web 与 Native 的 React 组件源码、图标实现和 token 物理来源可以在闭环验证后渐进统一。

## 5. 产品导航

Tutti Personal 移动端包含四个导航层级：

```text
登录页
└─ 设备选择页
   └─ 会话列表页
      └─ 会话详情页
```

规则：

- 未登录时停留在登录页。
- 完成登录前，登录页是唯一可用路由；登录后设备选择页是固定首屏。
- Device 是用户选择的远端电脑和 DeviceLink 连接上下文，因此保留独立页面。
- Tutti Personal 约定每台 Device 恰好包含一个 workspace。`workspaceId` 仍是所有
  Agent 请求的 canonical scope，但不建立 workspace 选择路由；返回零个或多个
  workspace 时连接失败并显示明确错误，不静默选择。
- TSH 的 `roomId` 在产品适配层一对一映射为 canonical `workspaceId`。
- 进入唯一 workspace 后先展示会话列表；只有用户选择会话或新建会话时才进入详情路由。
- 会话列表和会话详情是两个真实路由；会话详情顶部始终展示当前设备和 workspace。
- 会话详情路由的 `agentSessionId` 是详情导航的唯一所有者；workspace activity 只消费该
  选择，不得在 reconcile 时静默切换详情路由。当前会话失效时返回会话列表。
- Android 返回键和边缘返回手势由原生导航栈处理：详情返回会话列表，会话列表返回
  设备页并释放 DeviceLink，设备根页面再按系统规则退出。返回设备页时先同步失效旧
  device/workspace scope，并在旧 DeviceLink 完成关闭前阻止新的连接操作。

会话列表复用桌面当前的 membership、分组、排序、置顶和运行状态语义，但布局与信息密度由移动端独立设计。MVP 不做跨设备聚合会话列表；每次只展示当前设备唯一 workspace 下的会话。

## 6. 系统结构

```text
apps/mobile (bare React Native)
  -> @tutti-os/agent-gui/agent-conversation platform-neutral projection
  -> @tutti-os/agent-activity-core
  -> @tutti-os/client-tuttid-ts
       -> injected DeviceLink fetch adapter
       -> injected DeviceLink event socket adapter
  -> Android TurboModule / JNI
  -> packages/device-link Go core compiled as AAR
       -> ICE + QUIC P2P
  -> Personal host adapter
       -> authenticated device lifecycle + managed Relay fallback
  -> Tutti Desktop / tuttidd public Agent and Workspace API adapter
  -> packages/agent/host
  -> canonical local store and provider runtime
```

控制面：

```text
mobile account session
  -> tsh-server device registry and pairing
  -> short-lived rendezvous / candidates / online presence
  -> direct DeviceLink or tsh-tunnel-relay
```

Agent 请求和响应不经过 tsh-server 业务存储。Relay 只转发已认证的加密字节流。

### 6.1 Mobile DI 和页面边界

Mobile 使用稳定 Bootstrap container。未登录 child 与登录后 child 互斥；账号变化
销毁并重建完整登录后子树。登录后 child 同时拥有账号会话、单个 DeviceLink、
动态 Agent Target 目录和 workspace catalog，不再增加语义重复的 Device child。
它下面最多持有一个 workspace child，后者拥有唯一
`AgentSessionEngine`、会话导航和进程内草稿。

`services/**` 是不依赖 React 的纯 TypeScript 服务。页面 binding 通过
`useSyncExternalStore` 订阅服务快照，props-only View 只持有抽屉、滚动、焦点、
键盘和 Interaction 输入等 UI 状态。数据加载、轮询、重连、DI scope、会话命令和
快照复制不得由页面 `useEffect` 驱动。

设备级快捷提示词由登录后的设备 scope 中的独立 service 读取，不进入 workspace
`AgentSessionEngine`、Session 或移动端持久存储。该 service 通过生成客户端读取电脑端
`agent.quickPromptLibrary` 开关和 canonical 提示词顺序；开关打开时，Composer 的 `+`
菜单提供搜索与只读选择，点选后在当前输入位置添加文本，不替换已有草稿，恢复输入焦点且不自动发送。
新增、编辑、删除和排序仍由电脑端负责。DeviceLink 只为此能力开放精确的桌面偏好和
快捷提示词列表 GET 路由，不开放 mutation 或单条记录路由。

## 7. DeviceLink 边界

### 7.1 共享核心

新增一个先由 Personal 验证、随后再稳定为跨消费者边界的 `packages/device-link`：

- 从 TSH 现有生产实现提炼 Go ICE、STUN candidate、QUIC、证书 pinning、连接竞速、
  负缓存，以及供产品 adapter 注入 direct/Relay 的生命周期 seam；
- 暴露认证后的双向流，不包含 Session、Turn、Composer 或 Workspace 业务实体；
- 提供 gomobile/AAR 构建入口；
- 在 Personal Desktop 和 Android 闭环验收后，成为 Tutti Desktop、TSH Desktop 和 Android 的共同源头。

不拆分 `device-link-core`、`device-link-protocol`、`device-link-react-native` 等额外包。平台桥接留在消费端：tuttid 负责 Desktop adapter，`apps/mobile/android` 负责 Android 生命周期和 TurboModule，TSH 负责其产品 adapter。

TSH 当前代码作为 donor implementation。Personal 验收前不要求 TSH 切换；稳定
发布后 TSH 才依赖上游版本并删除长期复制实现。

### 7.2 Android 形态

移动端采用 bare React Native，不依赖 Expo Go。Go 核心通过 gomobile 产出 AAR，Kotlin/TurboModule 层保持薄：

- 登录后配置设备身份和 rendezvous endpoint；
- 建立、关闭和观测一个活动 DeviceLink；
- 打开 request stream 和 event stream；
- 投影 Android 网络变化与前后台生命周期；
- 返回经过清洗的连接状态和错误分类。

ICE、QUIC、证书校验、连接竞速和探测退避不得在 Kotlin 中重写。direct/Relay
身份认证、fallback 延迟和错误分类仍由产品 adapter 决定，并通过共享 manager
提供的 dial、race 和 probe seam 接入。

### 7.3 业务传输

DeviceLink 不新增 Agent RPC，也不解释应用流 prelude；它只提供经过 peer
fingerprint 校验的通用双向字节流。Personal host adapter 定义极薄的 prelude：

- service kind：Agent HTTP request 或 Agent event stream；
- `protocolEpoch`；
- request/stream identity；
- 已认证 peer identity，由 host adapter 在建立 link 时强制传入，并交给 Desktop handler。

HTTP 流携带 fetch 所需的 method、public API path、headers 和 body；Desktop adapter 将其交给公开 Agent/Workspace API handler。事件流承载现有事件帧。它不是任意 TCP 代理，也不能选择任意 localhost 端口。

TypeScript 侧继续使用：

- `createTuttidClient({ fetch })` 注入 DeviceLink fetch；
- 事件客户端的 `webSocketFactory` 注入 DeviceLink event socket；
- 概念 URL `tutti-device://<desktopDeviceId>` 只用于路由到当前设备，不成为新业务 API。

### 7.4 P2P 与 Relay

- P2P 与 Relay 同时受同一设备身份和配对授权约束。
- Mobile 的 Agent HTTP/live 数据流 direct 与 Relay 同时立即开始，首个成功的
  authenticated stream 获胜；TSH Desktop 的默认 3 秒 Relay 兜底窗口由其产品策略
  保持不变。
- 第一条完成认证的可用链路获胜，晚到链路关闭。
- 主界面和连接详情继续复用现有状态与 path scope，不新增 P2P/Relay 展示分支；选路
  只在 native transport 内部生效。
- 具体选路、耗时和 fallback reason 只进入清洗后的诊断与指标，不记录 candidate、IP、token 或 Agent payload。

## 8. 账号、配对和设备身份

### 8.1 同账号约束

Mobile、Tutti Personal 和 TSH 使用同一 tsh-server 账号体系。Tutti Personal 只有在登录功能开启且用户已登录时，才能开启移动端连接能力。

“同账号”以账号服务返回的 canonical `user_id` 为准，不以界面展示的邮箱字符串
判断。GitHub 登录与邮箱验证码登录即使展示相同邮箱，也可能对应不同账号 identity；
Mobile 应优先允许用户复用 Desktop 的登录方式，不能通过邮箱相等放宽配对校验。
Mobile GitHub 登录直接打开现有 Web 登录页，通过只监听 `127.0.0.1` 的短时 bridge
接收一次性 transfer code，再复用账号服务兑换会话；App 不接触 GitHub 凭据或网页
Cookie，也不新增移动端账号实体。Android 在浏览器 provider 支持时使用 Auth Tab，
不支持时降级到外部系统浏览器；iOS 使用 `ASWebAuthenticationSession`。平台认证会话
只负责 callback 匹配与回到前台，不拥有账号 session 或 provider OAuth 流程。

配对必须同时满足：

1. 手机拥有有效账号登录态；
2. Desktop 拥有同一账号的有效登录态；
3. Desktop 显式打开连接手机流程；
4. 手机扫描短时一次性 QR challenge；
5. tsh-server 校验同账号和 challenge 状态；
6. Desktop 显式确认配对。

Desktop 的账号登录入口与手机远程访问入口独立发布。手机远程访问当前已停用；
`mobile.remoteAccessSettings` 仅作为旧 profile 的持久化兼容键保留，desktop daemon
会强制忽略它，不启动 owner-side discovery，也不提供手机配对 UI。「连接」页仍承载
账号登录、退出和刷新。该开关不创建第二套登录态、设备实体或协议能力。

QR 不包含 bearer token、私钥、原始候选或可长期使用的连接凭据。

### 8.2 持久设备身份

- Mobile 和 Desktop 各自生成持久设备密钥；公开测试前私钥只保存在设备安全存储中。
- tsh-server 持久化账号绑定的设备公钥、设备元数据、配对关系和撤销状态。
- 短期 link identity 必须与已配对设备身份绑定，继续复用 DeviceLink 的 QUIC 双向认证和 pinning。
- 手机退出登录会立即断开并清除账号 token，但不自动撤销配对。
- 再次登录同一账号可以恢复配对；其他账号看不到且不能使用该配对。
- 主动移除设备才撤销配对。撤销必须让新连接和已建立连接上的后续业务调用失效。

MVP 不增加生物识别二次确认。后续可在不改变 DeviceLink 业务协议的前提下增加本机安全门。

Personal daemon 的第一阶段实现先把 Ed25519 私钥保存在 daemon state root 下权限为
`0600` 的独立文件中，且只向 service 层返回签名能力；本地 HTTP API 不返回私钥、
账号 cookie 或签名原文。这是端到端联调前的临时落地方式，不改变设备 identity
协议；公开测试前必须迁移到系统安全存储。Android 从首次实现起使用 Keystore。

### 8.3 控制面存储

MySQL 持久化：

- 设备公开身份和账号归属；
- 配对关系；
- 撤销状态和必要的审计时间。

Redis 短期保存：

- 一次性配对 challenge；
- DeviceLink attempt；
- candidate 与短期 link material；
- 设备在线状态和 Relay/rendezvous 协调信息。

Redis TTL 不因普通 candidate 更新无限延长。Agent 会话、消息、Interaction payload 和 Composer 内容不得进入这些存储。

### 8.4 M2 最小持久模型（已确认并实现服务端基础）

现有 `user_device` 已经是同账号 canonical 设备实体，保存名称、平台、版本和最近
出现时间；M2 直接让它同时拥有设备的公开身份，不再创建一张一对一的
`user_device_identity` 表。现有 `device_authority` 继续只负责 Desktop
runtime/Relay 路由，不能拿来代表 Mobile 或配对关系。

M2 建议只新增一张表：

1. 扩展现有 `user_device`
   - 增加公钥算法、公钥、key fingerprint、identity revision 和撤销时间；
   - 私钥永不上传；更换设备公钥必须递增 revision，并让旧配对失效；
   - 没有注册公开身份的历史设备仍可展示，但不能参与 Mobile 配对或 DeviceLink。
2. 新增 `device_pairing`
   - 保存 `pairing_id`、`user_id`、controller `user_device_id`、target `user_device_id`、状态、revision、确认和撤销时间；
   - controller 是 Mobile，target 是 Desktop；两端必须属于同一 `user_id`；
   - 同一有向设备对只有一条记录，重新配对更新该记录而不是制造第二套关系实体。

一次性 QR challenge 仍只进入 Redis：记录 challenge ID、同账号 user ID、target
device、claiming controller device、随机 nonce 的摘要、状态和固定过期时间。Desktop
创建 challenge，Mobile claim，Desktop confirm 后才在 MySQL 激活 pairing；claim、
confirm 和 revoke 都必须幂等。QR 本身不携带账号 token、私钥、公钥私密材料、
candidate 或长期授权。

DeviceLink attempt 继续使用同一短期实体和 Redis repository。内部把当前
`roomId` key 泛化为 `scopeKind + scopeId`：TSH 使用 `room` scope，Mobile Agent
channel 使用 `paired_device` scope。HTTP 可以保留产品适配入口，但不能复制一份
Mobile attempt model、candidate 校验或 ready 状态机。

该 schema 已由用户明确确认。`tsh-server` 已实现 additive migration、设备公开身份
注册、五分钟一次性 challenge、双端 Ed25519 签名、配对列表/撤销，以及
`room | paired_device` 共用的 DeviceLink attempt scope。短期 DeviceLink 指纹还会由
配对设备的持久 Ed25519 identity 签名，撤销 pairing 后 attempt 访问立即失败关闭。

配对 proof 的 canonical bytes 是：

```text
tutti-device-pairing/1\n<claim|confirm>\n<challengeId>\n<base64urlSecret>
```

paired-device DeviceLink proof 的 canonical bytes 是：

```text
tutti-device-link/1\ncreate\n<pairingId>\n\n<ephemeralFingerprint>
tutti-device-link/1\nupdate\n<pairingId>\n<attemptId>\n<ephemeralFingerprint>
```

## 9. Workspace 和产品适配

移动端 canonical identity 始终是 `workspaceId`：

- Tutti Personal：一台设备当前只有一个 workspace，仍返回真实 `workspaceId`，不省略此层实体；
- TSH/VM：adapter 将 `roomId` 一对一映射为 `workspaceId`；
- 零个 workspace 显示空态；一个自动进入；多个展示独立选择页。

Personal 和 VM 的差异通过服务端实际 capability/catalog 表达。移动端不得根据 provider 名称或硬编码的产品枚举推断 Agent 行为。Capability 只描述功能可用性，不承担前期版本兼容。

## 10. Agent 数据与同步

### 10.1 初始读取与实时更新

1. 进入 workspace 时获取会话列表快照。
2. 打开会话时获取完整 session snapshot。
3. 在线期间通过现有 Agent Activity 事件流增量更新。
4. 连续且版本完整的 message update 可以直接合并。
5. 事件缺口、重连、前台恢复和关键状态变化触发权威读取。
6. 重连成功后先校准，再恢复交互。

Mobile 不建立 SQLite 会话库。允许保存的设备本地状态仅包括：

- Android Keystore 中的设备私钥；
- 配对设备标识；
- 上次选择的设备、workspace 和 session；
- 当前进程内的会话快照与 per-session 草稿。

### 10.2 并发和幂等

Desktop 与 Mobile 可以同时打开并操作同一 Session。Host 继续负责 canonical winner 和 lifecycle transition。

- create/send 使用稳定 `clientSubmitId`；
- Interaction response 使用准确的 `(workspaceId, agentSessionId, turnId, requestId)`；
- 超时后先读取 authoritative state，再决定是否用相同 identity 重试；
- 不盲目重放 delivery state 不明确的操作；
- 手机草稿和本地 prompt queue 不跨设备同步。

## 11. AgentGUI 与 React Native

### 11.1 包内分层

不新增 `agent-conversation-core` 包。在现有 `@tutti-os/agent-gui` 内整理清晰子路径：

```text
@tutti-os/agent-gui/agent-conversation
  platform-neutral projection, reconciliation, state and interaction model

@tutti-os/agent-gui/agent-conversation/web
  DOM implementation

@tutti-os/agent-gui/agent-conversation/native
  React Native implementation
```

平台无关入口的依赖图不得包含 DOM、CSS、Monaco 或 `react-dom`。它继续消费 canonical Agent Activity 类型，不定义新的 Conversation DTO。

### 11.2 共享边界

会话列表属于产品壳层。Web 与 Native 复用数据、排序和状态语义，但允许不同布局和导航。

对话流属于核心体验。Web 与 Native 应保持同一视觉语言和交互语义，覆盖：

- user/assistant message；
- Reasoning；
- Tool Call；
- Approval；
- Question；
- Plan；
- Processing；
- unsupported content fallback。

MVP 优先共享 conversation projection、稳定 row identity、相邻消息合并、工具分组、processing row、pending interaction 和 reconcile 行为。Web 与 Native 分别实现虚拟列表、Markdown、代码块、菜单、Bottom Sheet 和平台 primitive。

### 11.3 UI System 节奏

现有 `@tutti-os/ui-system` 是 DOM/CSS 实现，不能直接作为 React Native 组件库。MVP 在 `apps/mobile` 内建立薄 Native theme mapping，名称和取值对齐现有 semantic token，不创建另一套设计语言。

闭环验证后再把必要颜色、字号、间距、圆角和状态 token 提炼为 `@tutti-os/ui-system` 的平台无关导出，并逐步收敛真正可共用的 Conversation 组件。该重构不是 MVP 链路前置条件。

所有移动端文案仍进入 i18n。不得在 Native 组件中硬编码用户可见文案。

### 11.4 会话详情展示节奏

Native Mobile 会话详情保持正常时间顺序，不在展示层重组 Turn 或推断新的
Interaction 状态。页面 Header 使用两层信息展示会话标题与现有 workspace/device
上下文；Transcript 在宽屏上限制阅读宽度，用户消息使用紧凑气泡，Assistant 正文保持
平面排版，Reasoning、Tool、Processing 和文件摘要使用低权重的渐进披露样式。
会话首次进入时在最终布局帧跟随最新消息；用户已离开底部并触摸历史内容时，应先退出
follow-end，再处理 Reasoning、Tool 或文件摘要的展开，避免内容高度变化把阅读位置强制跳回
末尾。离开底部后保留明确的“回到底部”动作。

Pending Interaction 是 Composer 前的 normal-flow sibling，并且仍是当前 exact
Interaction 的唯一 actionable 挂载点。多个 pending 项在有限高度的独立滚动区中保持
canonical 顺序和 exact identity；页面不把它复制为第二张 transcript 操作卡，也不使用
absolute overlay，也不参与 Transcript 的滚动锚点或 follow-end 几何计算。Composer 使用单一 token-backed surface
组织草稿、现有设置入口和 Send/Stop action，继续服从原有 Engine projection、草稿、
readiness 和 overlay activation fence，不在 Native presentation 中重解释业务状态。
窄屏上的 Composer 设置入口允许水平滚动，并使用跨平台边缘方向提示表达仍有更多设置
（Android 同时保留原生渐隐）；键盘弹起时
Composer 整体上移，Transcript 继续保留可阅读区域。

## 12. Composer

MVP 支持：

- 多行纯文本；
- 发送、停止和失败重试；
- 每个 session 的进程内草稿；
- 软键盘、输入区高度和滚动到底部；
- 新建会话并发送首条消息。

新会话使用现有完整 create/send/settings contracts。MVP UI 默认继承 workspace 返回的 Agent、模型、权限和其他 Composer 默认设置。缺少必要默认项时明确要求选择，不静默失败。

后续模型、推理强度、权限、运行模式、Agent Target 和其他设置读取并修改同一份 workspace defaults 与 session settings。Mobile 不保存独立偏好，也不新增 mobile-specific DTO。Personal 与 VM 的可选项来自动态 capability/catalog，不写死枚举。

## 13. 连接生命周期

- Mobile application service 只消费平台原生提供的进程级前后台信号。
  Android 由 `ProcessLifecycleOwner` 投影，iOS 由 `UIApplication` 投影；
  React Activity 暂停、同进程扫码 Activity、授权 Activity 等页面切换不得解释为
  App 进入后台。配对、DeviceLink 和会话服务不感知平台 Activity 类型。
- 前台保持实时连接。
- 进入后台后只做短时 best-effort 保活，随后主动断开；Android 系统可更早终止连接。
- MVP 不使用常驻前台服务或推送唤醒。
- 回到前台重新发现设备、建立链路、校准 workspace/session snapshot 并恢复订阅。
- 重连期间保留当前内存画面，禁用发送、取消和 Interaction 操作，不建立离线写队列。
- 设备离线时保留当前画面，并提供重试和返回设备列表。
- Desktop Electron 窗口关闭不影响远程能力；只要 tuttidd/desktop daemon 在线且用户未暂停远程连接，手机可以连接。
- “暂停远程连接”和“撤销配对”是不同操作。

## 14. 版本策略

前期只支持单一当前移动端协议，不维护兼容矩阵。

- 应用流 prelude 包含简单 `protocolEpoch`；
- 非破坏性变化沿用当前 epoch；
- 任何破坏性变化直接递增 epoch；
- 两端 epoch 不一致时拒绝应用连接并提示升级对应客户端；
- 不维护旧 DTO、字段迁移、双写或兼容分支；
- 等用户规模和发布稳定性需要时，再设计兼容窗口、最低版本和灰度策略。

现有 TSH DeviceLink transport wire version 的迁移是传输实现问题，不扩展为 Mobile Agent API 的多版本兼容承诺。

## 15. 仓库职责

| 仓库               | 职责                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `tutti`            | `packages/device-link`、tuttid Personal adapter、AgentGUI 平台无关边界、React Native App、生成客户端和 Host 集成 |
| `tsh`              | 作为现有 DeviceLink donor；升级消费 Tutti 上游包；第二阶段提供 room/workspace 与 VM 产品 adapter                 |
| `tsh-server`       | 账号、设备注册、扫码配对、设备在线状态、rendezvous、STUN endpoint、短期 Relay 授权                               |
| `tsh-tunnel-relay` | workspace-less paired-device Agent channel 的认证与不透明转发；不解析 Agent payload                              |

所有 Agent lifecycle 缺口先进入 `packages/agent/host` 和 conformance scenario。tuttid 与 TSH 只编写授权、HTTP/query、产品策略和传输 adapter。

## 16. 实施阶段与任务

### M0 — 契约和 Android 链路 spike

归属：`tutti`。

- 用 provisional API 验证 `packages/device-link` 的最小传输能力；不在 M0 锁定稳定公开 API。
- 从 TSH 提取最小 ICE/QUIC vertical slice。
- 产出 Android arm64 AAR，并通过薄 JNI/TurboModule 建立双向测试流。
- 验证 Android 系统路由、Wi-Fi/蜂窝切换、VPN/TUN 环境的失败分类。
- 固定 `protocolEpoch` mismatch 的 fail-fast 行为。

完成条件：Android 与 Personal macOS adapter 可以通过同一核心建立经过注册设备
身份约束的双向流；产品桥接不直接暴露任意 TLS/QUIC dial/listen；不存在 Kotlin
重写 ICE/QUIC 的需求。

当前进度：共享模块、Go/Java binding 边界、host loopback probe、Android
交叉编译、四 ABI AAR 和签名探针 APK 均已完成；探针已在 Android 15 ARM64
emulator 上跑通 ICE -> pinned QUIC -> 双向 stream echo。`authenticated`
facade 和 gomobile Link/Stream API 已统一 ICE、peer fingerprint pinning、QUIC、
connect/cancel/close 顺序，并由 Desktop/Android adapter 共同消费。物理设备上的
Wi-Fi/蜂窝切换和 VPN/TUN 失败分类仍待验证。

### M1 — Personal authenticated DeviceLink adapter

归属：`tutti`。

- 搬迁并清理 production DeviceLink、ICE/QUIC、连接竞速、负缓存和诊断。
- 在 Tutti 建立 Go 单测、跨编译、gomobile binding 和 AAR consumer 构建。
- 为 Personal Desktop 和 Android 定义相同的 authenticated link 生命周期 port。
- 强制调用方提供预期 peer identity/fingerprint，由 facade 统一拥有 ICE -> pinned
  TLS -> QUIC -> close/cancel 顺序。

完成条件：Personal Desktop 与 Android 真机通过同一 facade 建立链路，原始
`QUICEndpoint` 不进入产品桥接；TSH 仍保持现状，不阻塞 Personal 验证。

当前进度：共享 facade、Desktop owner host、Android caller bridge、真实
authenticated stream 集成测试，以及代际隔离、连接池、建连去重、连接竞速和探测
退避的 product-neutral manager 均已完成；Tutti Desktop `mobileremote` owner
已经作为首个 adapter 接管共享 manager 和 `candidateexchange`；Android/iOS 通过
同一 Go coordinator 的 gomobile start、next/resolve action、notify 与 stop/cancel
边界接入。初始 ICE 凭据允许携带空 candidate 立即发布，双方在 `Connect` 运行期间继续
增量交换 candidate，不再串行等待两轮 STUN gathering；retry snapshot、500ms poll
timer 与 worker lifecycle 不再由 TypeScript 维护第二份，服务端返回的权威 attempt
确认 candidate 已落库后才完成 publication ACK。TSH adapter 切换和真机跨网络验证仍待
完成。Relay 身份认证、控制面、fallback 产品策略和 TSH 产品诊断继续由消费端拥有。

### M2 — 设备、配对和控制面

归属：`tsh-server`、`tutti`。

- 增加持久设备 identity/pairing/revocation schema。
- 增加一次性 QR challenge 和 Desktop confirm 流程。
- 将现有 room-coupled attempt 泛化为 paired-device scope，同时保留 TSH room lane。
- 复用 DeviceAuthority、presence、Redis TTL、candidate bounds、rate limits 和 STUN endpoint。
- Tutti Personal daemon 注册设备在线状态，并提供开启、暂停和撤销入口。

完成条件：同账号手机与 Desktop 完成配对；跨账号、过期 challenge、重复使用和撤销均失败关闭。

当前进度：`tsh-server` 的 schema、HTTP contract、Redis challenge、签名校验、
pairing lifecycle 和 paired-device rendezvous 已完成并部署。Tutti Personal daemon
已复用 daemon-wide stable device id，增加持久 Ed25519 identity、账号 cookie
控制面 adapter，以及 start/status/confirm/list/revoke 本地 API；challenge secret
不会持久化，Desktop renderer 只在配对界面打开期间临时持有二维码 payload。
Desktop UI 已接入 QR 创建、配对码显示/复制、状态轮询、自动确认和撤销；Android
已接入平台原生浏览器认证 GitHub 登录、邮箱验证码登录、Keystore 设备身份、内置 ZXing
扫码/手动粘贴配对码、
challenge claim/poll，并只展示属于当前 Mobile identity 的配对设备。
真实账号二维码联调仍是 M2 的剩余端到端完成条件。

### M3 — Relay 和 Agent API transport

归属：`tsh-tunnel-relay`、`tutti`。

- Relay 增加 paired-device Agent service channel，不复用只读 query channel 冒充控制流。
- 实现 application stream prelude、Desktop allowlist handler 和 peer authorization。
- 实现 DeviceLink fetch adapter 和 event socket adapter。
- 使用现有生成客户端验证 list/get/create/send/cancel/settings/interaction/event 路径。
- 增加断线、ambiguous delivery 和 snapshot reconcile 测试。

完成条件：不增加 Agent DTO 即可通过 direct 和 Relay 完成同一套 Agent API 请求与事件订阅。

当前进度：direct lane 已实现 application epoch/length frame、Desktop route
allowlist 和 Android fetch adapter，并直接复用生成的
`@tutti-os/client-tuttid-ts`；workspace、Agent Target catalog、Session
list/get/create/send/cancel/Interaction 均沿用现有 HTTP contract。owner host 会在
caller 获得 response-only STUN endpoints、替换临时 Participant 并立即二次发布 ICE
凭据后再认领 attempt，避免连接旧 fingerprint；该初始快照可以没有 candidate。
owner 与 caller 随后在 `Connect` 已运行时通过权威 attempt 快照增量补齐 candidate，
WebSocket 只负责唤醒，丢失时继续使用 500ms HTTP 校准。

Relay Agent lane 已接入同一套应用帧协议：Desktop `mobileremote` 只在用户打开
移动端连接开关后获取 Relay owner demand，按 Device Authority 完成 identity
enrollment、owner token 和 lease renewal；Relay stream prelude 校验 authority、
user、target、channel 及 paired-device scope 后复用现有 Agent HTTP/live handler。
Mobile 在直连准备阶段并行请求短期 Relay descriptor；原生层对每条 direct/Relay
数据流先完成共享 DeviceLink transport probe，收到对端 ACK 后才让该路径赢得竞速，
再发送应用帧；不会取消 direct attempt，后者继续到成功或当前连接代际失效。
Android/iOS native adapter 不能把 WebSocket 101 或本地 QUIC stream allocation 单独
当作成功路径。因此 UI、生成客户端和 Agent DTO 不变。paired-device attempt 的
`device_link.attempt.changed` 通过已上线的设备级 V2 WebSocket 作为唤醒提示，连接
建立时携带 session cookie 与 `deviceId`；客户端收到提示后仍通过 HTTP attempt API
读取权威状态，推送丢失、重连或乱序时回退到 500ms 状态轮询。服务端对没有 room 的
paired-device attempt 使用 `userId + deviceId` 精确投递；未开启连接功能的 Desktop
不会建立这条长连接。pairing 的 active 快照仍在本地使用当前 2 秒周期轮询，Relay
stream 在本地快照中找不到 pairing 时 fail closed。

这里依赖的 Relay descriptor、Device Authority 和 `tsh-tunnel-relay` Agent channel
是跨仓库的增量契约；服务端部署状态不在 Tutti 仓库内，须以对应 tsh-server/relay
变更合入和线上配置为准。direct lane 的 `agent_live` event stream 已接入：delta、
Turn、Interaction 和 session audit 通过 framed live protocol 进入 Mobile；
canonical-only 更新由 Personal 的 `mobileremote` adapter 转为 scoped discontinuity，
再触发权威 snapshot reconcile。Session/Message poller 仅在 event stream 未就绪或
断开时作为降级路径。

### M4 — Mobile App shell（Android 首发）

归属：`tutti`。

- 建立 `apps/mobile` bare React Native 工程，Android 首发并保留未来 iOS 目录能力。
- 接入账号登录、Android Keystore、设备列表、Personal 单 workspace 校验和导航恢复。
- 接入前后台连接生命周期、连接状态和错误页。
- 使用原生导航栈实现登录门禁、设备根页面和 Android 系统返回。
- 建立移动端 i18n 与 Native theme mapping。

完成条件：登录、配对、选设备、解析唯一 workspace、重连和撤销形成完整非 Agent UI 闭环。

当前进度：bare React Native 0.86 Android 工程、Auth Tab（不支持时降级系统浏览器）
统一 Tutti 账号登录入口（具体登录方式由托管登录页提供）、Keystore Ed25519 identity、
扫码/粘贴配对码、配对设备列表、Native DeviceLink bridge、移动端 i18n
和 semantic theme mapping 已完成。账号、设备、workspace 和前后台生命周期已迁入
纯 TypeScript DI service；页面只保留 binding 与 Native presentation。登录、
设备、会话列表和会话详情使用类型安全的原生导航栈；连接 Device 后会校验并打开
唯一 workspace，不建立 workspace 选择页。Native 15 秒后台 grace 后断开也已接入。当前最低版本为 Android 13/API 33，
以使用系统 Ed25519 provider；prepare/connect 使用 native generation token
隔离取消后晚到的连接任务。TypeScript/Jest、Metro、Kotlin/Java/CMake、
四 ABI APK 构建，以及 Android 15 ARM64 模拟器安装启动均通过；前台自动重连和
撤销专用状态仍待完成。

iOS Simulator host 已在相同 `apps/mobile` application core 上建立。它复用全部
TypeScript service、AgentGUI projection、Native renderer 和 Composer，只实现
`TuttiMobileSecurity` / `TuttiDeviceLink` 平台 port。当前 iOS adapter 包含
Keychain/CryptoKit identity、账号 session/Cookie、`ASWebAuthenticationSession`、
localhost browser login bridge、
AVFoundation scanner、gomobile XCFramework、Agent HTTP/live framing 和前后台 grace；
Simulator 的相机路径明确使用现有手动配对码降级。真机与分发仍不属于本阶段完成条件。

### M5 — AgentGUI MVP

归属：`tutti`。

- 清理 `agent-conversation` 平台无关导出，阻止 DOM/Monaco 依赖进入 Native bundle。
- 接入 workspace `AgentSessionEngine` 和 authoritative snapshot/event reconcile。
- 实现独立会话列表页、默认会话选择、新建和切换。
- 实现 Message、Reasoning、Tool、Approval、Question、Plan、Processing 和 unsupported fallback。
- 实现纯文本 Composer、发送、停止、重试和 per-session 内存草稿。
- 验证 Desktop 与 Mobile 同时操作及请求幂等。

完成条件：达到第 17 节所有产品闭环验收项。

当前进度：独立会话列表页、动态 Agent Target 新建会话、切换、canonical message
增量读取、纯文本 Composer、发送、停止，以及 Approval/Question/Plan
Interaction 提交已接入。Mobile 已接入 workspace `AgentSessionEngine`；create、
send、stop 和 Interaction response 统一通过 Engine intent/command port，Session
和 Message 快照映射后进入同一 canonical state。Desktop 与 Mobile 的生成契约
映射、Session detail 聚合和事件 reconcile 判定分别由
`@tutti-os/agent-activity-tuttid-adapter` 与
`@tutti-os/agent-activity-core` 复用；Mobile Rail 只保存分组、Session id、游标
和总数，实体页瞬时映射后直接 upsert 到 Engine。Interaction 提交中、失败状态和
per-Session runtime availability 也由 Engine 投影，Native card 不维护第二套
Promise 状态。当前 Native renderer 是
`apps/mobile` 内的 MVP presentation adapter；它不定义 Session/Message DTO。
Interaction answer payload 与原型安全的 question-id 读写已从
`@tutti-os/agent-gui` 的无 DOM 子路径复用；轮询为 single-flight，超时重试保留
原始 session/submit identity；不明确的写入会先做 workspace 权威校准，再使用同一
identity 进入显式 Retry。Markdown/code、unsupported fallback 的完整视觉语义和
会话列表视觉对齐仍是剩余项。

### M6 — 稳定性和第二阶段准备

归属：全部相关仓库。

- 完成局域网、不同 cone NAT、对称 NAT/CGNAT 和 Relay 故障注入。
- 完成前后台、睡眠唤醒、网络切换、daemon 重启和事件缺口测试。
- 清洗指标与诊断，确认无 IP、candidate、token 和 Agent payload 泄露。
- 根据验证结果决定 UI token 提炼和共享组件的下一批范围。
- 已冻结最小 transport API；每次启用稳定 Go tag 前，在 release head 重跑可复现
  AAR consumer gate。真实网络切换和 Relay 验收作为后续 hardening，不改变该公开边界。
- 再安排 TSH 切换上游依赖、删除复制实现并启用 VM/room workspace lane。

### M7 — iOS Simulator 功能对齐

归属：`tutti`。

- 从同一 React Native application core 建立 iOS 15.1+ shell，不复制对话流或业务状态机。
- 为 DeviceLink 与 Agent live mobile packages 生成 device + Simulator XCFramework。
- 以同名 Native Module contract 实现 Keychain identity/session、Cookie、browser
  login bridge、扫码、DeviceLink request/live stream 和 lifecycle grace。
- Simulator 使用手动配对码覆盖无相机环境；硬件能力不得返回伪成功。
- 通过 iOS Metro bundle、TypeScript/Jest、ObjC binding、Pods 和 Simulator build。

完成条件：Simulator 可以启动同一 App、完成非相机入口的登录/配对/连接和 Agent
对话闭环；真实相机、蜂窝/VPN/后台稳定性、签名和 TestFlight/App Store 留到 iOS
真机验收阶段。

当前进度：iOS shell、Native Module adapter、Go XCFramework build boundary 和共享
TypeScript 平台清理已完成；Metro iOS production bundle、TypeScript/Jest、device +
Simulator XCFramework、Pods 和 generic Simulator build 已通过。App 已安装并启动于
iPhone 17 Pro / iOS 26.5 Simulator，Hermes 成功执行共享 JavaScript bundle；真实账号
登录、手动配对码、DeviceLink 和 Agent 对话闭环仍需在 Simulator 做带账号的验收。

## 17. Android Personal MVP 验收

1. Android 登录后可以通过二维码与同账号 Desktop 完成配对。
2. 单设备、单 workspace 自动进入上次会话。
3. 可以查看会话列表、新建会话、切换会话。
4. 消息与 Agent Activity 流式更新，重连后无重复或永久缺口。
5. 可以发送、停止、重试，并完成 Approval、Question 和 Plan 等阻塞性交互。
6. Desktop 窗口关闭但 daemon 在线时仍可操作。
7. Desktop 与 Mobile 同时操作同一会话不产生重复提交或状态分叉。
8. 同局域网和不同普通 NAT 验证 P2P；无法打洞时自动回落 Relay。
9. 前后台切换后可以重新连接并用快照校准。
10. 设备离线、配对撤销和 `protocolEpoch` 不匹配有明确错误状态。
11. tsh-server 和 Relay 不持久化 Agent 会话内容。
12. 未识别内容使用显式 unsupported fallback，不导致整个对话崩溃。

P2P 成功率不是单独的发布门槛。发布目标是 direct 优先且 Relay 能保证可用。

## 18. 风险与缓解

| 风险                                                  | 影响                         | 缓解                                                                                                                                     |
| ----------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| gomobile、Pion ICE 与 quic-go 在 Android 真机行为不同 | 核心链路不可用或不稳定       | M0 先做 vertical slice；在 UI 投入前完成跨网络真机测试                                                                                   |
| Android 网络/VPN 路由与 macOS 物理接口策略不同        | candidate 不可达或错误选路   | Android 默认使用 `system` 的共享 LAN-first host priority，并保留 server-reflexive 公网 fallback；Android Network 绑定与 VPN/TUN 单独验收 |
| 直接导入 AgentGUI 带入 DOM/Monaco                     | Metro 构建失败或 bundle 膨胀 | 平台无关 subpath 建立严格 import boundary 和检查                                                                                         |
| Relay 当前 channel 只覆盖既有 query lane              | 写操作被错误复用或授权过宽   | 增加明确 paired-device Agent channel，复用身份校验但不复用业务含义                                                                       |
| App 与 Desktop 快速迭代产生协议漂移                   | 无法连接                     | 单一 `protocolEpoch` fail-fast，并协调开发期发布，不维护兼容分支                                                                         |
| Desktop/Mobile 并发导致 ambiguous delivery            | 重复消息或重复响应           | 稳定 submit/request identity；超时后先读权威状态再重试                                                                                   |
| UI 跨平台统一范围过大                                 | 阻塞 MVP                     | 首批共享 projection 与行为；Native renderer 独立；验证后再提炼 token/组件                                                                |
| 控制面意外记录敏感数据                                | 隐私泄露                     | schema、日志和指标只允许身份/分类信息；Agent payload 保持端到端数据面                                                                    |

## 19. 后续演进

MVP 稳定后按真实使用反馈推进：

1. 补齐 Composer 模型、推理、权限、运行模式和 Agent Target 设置。
2. 增加附件、图片、引用和 richer Markdown/code rendering。
3. 将必要 semantic token 提炼到 `@tutti-os/ui-system` 平台无关出口。
4. 渐进共享 Conversation component source，保留 `.web.tsx` / `.native.tsx` primitive。
5. 在同一 App 核心启用 TSH/VM workspace/room lane。
6. 完成 iOS 真机联调、签名与可选的 TestFlight/App Store 分发。
7. 用户规模和发布节奏稳定后，再设计协议兼容窗口、推送与后台能力。
