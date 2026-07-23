# Tutti Mobile Development

Status: current onboarding guide for the Android-first mobile client

这份文档面向第一次参与移动端开发的 Tutti 开发者。它不是通用 Android 或
React Native 教程，而是解释本项目的分层、工具链、调试方式和当前实施顺序。

产品与协议设计见
[Mobile AgentGUI And DeviceLink Design](../specs/2026-07-23-mobile-agentgui-device-link-design.md)。
共享传输模块的构建细节见
[DeviceLink README](../../packages/device-link/README.md)。

## 1. 先建立正确的心智模型

移动端不是把桌面网页缩小后塞进手机，也不是远程显示桌面 UI。它由四层组成：

```text
React Native / TypeScript
  页面、导航、会话列表、对话流、Composer
                ↓ TurboModule
Android / Kotlin
  系统生命周期、网络变化、Keystore、Go AAR 桥接
                ↓ JNI / gomobile
Go DeviceLink
  ICE、STUN、QUIC、证书 pinning、认证双向流
                ↓ network
Desktop + tsh-server + relay
  Agent API、设备配对、rendezvous、P2P/Relay 选路
```

判断代码应该放在哪里时，使用下面的规则：

| 需求                                    | 所有者                 |
| --------------------------------------- | ---------------------- |
| Session、Turn、Goal 的生命周期          | `packages/agent/host`  |
| 对话 projection 和 AgentGUI 行为        | `packages/agent/gui`   |
| 移动端页面、导航、临时 UI 状态          | `apps/mobile`          |
| Android 系统能力和 Native bridge        | `apps/mobile/android`  |
| ICE、QUIC、证书固定和认证 stream        | `packages/device-link` |
| 账号、设备、配对、在线状态和 rendezvous | `tsh-server`           |
| Personal Desktop 的 Agent API 传输适配  | `services/tuttid`      |

不要在移动端创建 `MobileSession`、简化版 Agent DTO 或第二套 Composer
协议。移动端只用不同的 UI 展示同一份 canonical 数据。

## 2. 需要认识的 Android 名词

- **Activity**：一个 Android 可显示入口。正式 App 通常只有少量 Activity，
  React Native 页面不等于 Activity。
- **Manifest**：声明包名、Activity 和系统权限的 XML。网络 socket 必须声明
  `android.permission.INTERNET`。
- **APK**：可以直接安装到设备或模拟器的应用包，主要用于开发和测试。
- **AAB**：Google Play 发布使用的 App Bundle，后期发布阶段才需要。
- **Gradle**：Android 构建系统，负责 Kotlin/Java、资源、AAR 和 APK/AAB。
- **AAR**：Android library。本项目用 gomobile 把 Go DeviceLink 编译为 AAR。
- **JNI**：Java/Kotlin 与 native 代码交互的底层机制。gomobile 帮我们生成
  JNI 和 Java binding。
- **Metro**：React Native 的 JavaScript bundler。开发时负责把 TypeScript/
  JavaScript 发送给运行中的 App。
- **ADB**：电脑控制 Android 设备的命令行工具，用于安装、启动和查看日志。
- **AVD / Emulator**：Android 虚拟设备和模拟器。
- **TurboModule**：React Native 调用 Kotlin/Java native API 的桥接机制。

日常开发多数时间在 TypeScript 和 React Native；只有系统生命周期、设备安全
存储、网络变化或 DeviceLink bridge 才进入 Kotlin；ICE/QUIC 问题进入 Go。

## 3. 本机工具链

当前约定：

- Node.js 24 或更高
- `pnpm@10.11.0`
- Go `1.24.3`，toolchain `1.24.5`
- JDK 17
- Android SDK Platform 36
- Android Build Tools 36.0.0
- Android NDK `27.3.13750724`
- Android Emulator 和 Android 35 ARM64 system image

在 macOS 上，JDK 和 Android SDK 通常位于：

```sh
export JAVA_HOME="$HOME/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
```

先在当前终端执行这些 `export`。确认无误后再放进自己的 shell 配置；仓库不会
自动修改个人 shell 文件。

检查环境：

```sh
node --version
pnpm --version
go version
java -version
adb version
emulator -version
```

## 4. 当前可以运行的最小链路

`apps/mobile` 已建立为 bare React Native 0.86 Android 工程，并直接消费
DeviceLink AAR。独立 DeviceLink probe 仍用于在不经过 React Native 的情况下验证
Go 和 Android native 边界；它会真实执行 ICE、pinned QUIC 和双向 stream。

```sh
cd packages/device-link
make test
make android-crosscompile
make android-bindings-check
make android-aar
make android-probe-apk
```

输出位于忽略的 `packages/device-link/dist/`：

- `tutti-device-link.aar`
- `tutti-device-link-probe.apk`
- 本机 probe debug keystore

连接设备或启动模拟器后：

```sh
adb devices
adb install -r dist/tutti-device-link-probe.apk
adb logcat -c
adb shell am start -n dev.tutti.devicelink.probe/.ProbeActivity
adb logcat -d -s 'TuttiDeviceLinkProbe:I' '*:S'
```

成功输出必须包含：

```text
PASS epoch=1 echo=tutti-device-link-android-probe
```

probe 只验证 Android 内部的传输 vertical slice。正式 App 还会通过同账号
pairing 和 paired-device attempt 交换双方的 ephemeral fingerprint 与 ICE
description，再使用同一个 authenticated facade 建立连接。

## 5. 正式 App 的日常开发循环

典型开发循环是：

1. 启动 Android 模拟器或通过 USB/Wi-Fi 连接测试手机。
2. 在一个终端启动 Metro。
3. 在另一个终端构建并安装 Android debug App。
4. 修改 TypeScript 时使用 Fast Refresh。
5. 修改 Kotlin、Manifest、Gradle 或 AAR 后重新构建 Android App。
6. 同时查看 Metro、React Native 和 `adb logcat` 三类日志。

仓库已经提供以下脚本：

```sh
pnpm mobile:start
pnpm mobile:android
pnpm mobile:check
pnpm mobile:test
```

`pnpm mobile:android` 会构建并安装 debug App，`pnpm mobile:start` 启动
Metro，`pnpm mobile:check` 运行移动端 TypeScript 和 Jest 检查。Android 构建前
需要先执行 `make -C packages/device-link android-aar`。

## 6. 调试时先判断问题属于哪一层

| 现象                           | 首先检查                                            |
| ------------------------------ | --------------------------------------------------- |
| 页面布局、点击、列表滚动不正确 | React Native component 和 state                     |
| DTO 有值但消息渲染错误         | AgentGUI projection，不要在 screen 内临时修数据     |
| JS 报 native module 不存在     | TurboModule 注册、Gradle AAR 依赖、重新安装 App     |
| App 切后台后连接状态错误       | Android lifecycle adapter                           |
| ICE 没有 candidate             | Manifest 网络权限、网络状态、DeviceLink 诊断        |
| QUIC 握手失败                  | peer identity、证书 fingerprint、protocol epoch     |
| P2P 失败但 Relay 成功          | 这是允许的 fallback，检查清洗后的 path 诊断         |
| 手机和桌面会话状态不一致       | snapshot/event reconcile 和 Agent API，不修本地缓存 |
| 创建、发送、取消语义不一致     | `packages/agent/host`，不能在移动端复制生命周期     |

常用 ADB 命令：

```sh
adb devices
adb shell pm list packages | grep tutti
adb shell am force-stop dev.tutti.mobile
adb logcat
adb logcat -c
adb install -r path/to/app-debug.apk
```

日志中禁止写入 candidate、IP、账号 token、私钥、证书原文或 Agent payload。

## 7. 真机开发需要做什么

Android 手机启用“开发者选项”和“USB 调试”，连接电脑后执行：

```sh
adb devices
```

首次连接时手机会弹出授权确认。开发期 debug build 可以直接安装，不需要
Google Play 账号。以下事项等正式分发前再处理：

- 最终 Android application ID
- 正式应用名称和图标
- release keystore 的保管方式
- Google Play Console 账号和签名策略
- 隐私政策、商店截图和分发地区

不要把 release keystore、密码或账号 token 提交到仓库。

## 8. 实施和学习顺序

建议按真实依赖学习，不需要先完整学完 Android：

1. **传输 probe**
   理解 AAR、Manifest、ADB，以及一次 ICE/QUIC stream 如何跑通。
2. **设备配对和 rendezvous**
   理解同账号设备身份、一次性 challenge、P2P/Relay 选路。
3. **React Native shell**
   学习 component、hook、navigation、Metro 和 Native bridge。
4. **会话列表和对话流**
   复用 AgentGUI projection，只实现 Native renderer。
5. **Composer 和交互**
   接入发送、停止、approval、question 和动态 settings。
6. **真机与发布**
   测试 Wi-Fi/蜂窝/VPN、后台切换、性能、签名和 Play 发布。

学习资料应优先使用 React Native、Android 和 Kotlin 的官方文档；项目内设计和
代码所有权以本仓库文档为准。

## 9. 当前状态和下一步

已完成：

- 共享 `packages/device-link` Go module；
- host test、Android cross-compile 和 Java binding；
- 四 ABI AAR 与签名 arm64 probe APK；
- Android 15 ARM64 emulator 上的 ICE -> pinned QUIC -> stream echo。
- `tsh-server` 同账号设备 identity、QR pairing、撤销和 paired-device rendezvous；
- room 与 paired-device 共用同一 DeviceLink attempt repository、TTL、限流和 ready 状态机。
- Personal `tuttid` 已接入设备注册、QR challenge、Desktop confirm、配对列表和撤销；
- Personal 配对 API 已进入生成的 Go/TypeScript daemon client，账号 cookie 和设备私钥不会返回给 UI。
- Desktop 设置页已接入二维码创建、轮询确认和撤销；
- `apps/mobile` 已接入同账号邮箱验证码登录、Android Keystore 设备身份、设备列表、
  Google Code Scanner 扫码和 challenge claim/poll；
- React Native 0.86、Kotlin native module、DeviceLink AAR 和四 ABI debug APK
  已在 Android 15 ARM64 模拟器完成构建、安装和启动验证。
- 共享 authenticated facade 已统一 Desktop/Android 的 ICE、fingerprint pinning、
  QUIC、stream 和关闭顺序；
- `tuttid` owner host 已接入 paired-device rendezvous，并且只允许 workspace、
  Agent Target catalog 和 Agent Session HTTP surface；
- Android caller 已接入 create/get/update attempt、STUN 二次 gathering、真实
  DeviceLink request stream 和 15 秒后台 grace period；
- 移动端已直接复用 `@tutti-os/client-tuttid-ts`，完成 workspace 自动进入/选择、
  会话抽屉、增量消息读取、新建/切换、发送、停止和结构化 Interaction 提交；
- Go authenticated link、owner host、application frame、allowlist、race，以及
  TypeScript/Jest、Metro bundle、Kotlin/Java/CMake、四 ABI APK 均已有自动验证。

接下来按顺序推进：

1. 用真实账号和 Android 真机跑通 QR claim/confirm、direct DeviceLink 与 Agent 操作；
2. 增加 paired-device Relay fallback 和事件 stream，替换前台的一秒消息校准轮询；
3. 补齐前台自动重连、撤销专用状态、动态 Composer 设置与 richer Native renderer；
4. Personal 闭环稳定后，再让 TSH 删除本地 transport 副本并消费共享 DeviceLink module。

遇到问题时先看
[Troubleshooting](../conventions/troubleshooting/README.md)，再根据上面的分层定位。
