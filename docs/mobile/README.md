# Tutti Mobile Development

Status: current onboarding guide for the Android-first client and iOS
Simulator host

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
                ↓ React Native native module
Android / Kotlin 或 iOS / Swift + Objective-C++
  系统生命周期、网络变化、安全存储、Go native bridge
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
| iOS 系统能力和 Native bridge            | `apps/mobile/ios`      |
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
- **AAR**：Android library。本项目用 gomobile 把 Go DeviceLink 和独立的 Agent
  liveprotocol mobile subscriber 编译为同一个 AAR；后者仍由
  `packages/agent/daemon/liveprotocol` 拥有，不属于 DeviceLink 语义。
- **JNI**：Java/Kotlin 与 native 代码交互的底层机制。gomobile 帮我们生成
  JNI 和 Java binding。
- **Metro**：React Native 的 JavaScript bundler。开发时负责把 TypeScript/
  JavaScript 发送给运行中的 App。
- **ADB**：电脑控制 Android 设备的命令行工具，用于安装、启动和查看日志。
- **AVD / Emulator**：Android 虚拟设备和模拟器。
- **Native module**：React Native 调用 Kotlin/Java native API 的桥接机制；
  当前 App 使用显式 `ReactPackage` 注册，未来可以在接口稳定后迁移 Codegen。

日常开发多数时间在 TypeScript 和 React Native；只有系统生命周期、设备安全
存储、网络变化或 DeviceLink bridge 才进入 Kotlin/Swift/Objective-C++；
ICE/QUIC 问题进入 Go。

移动端业务服务消费的是“整个 App 是否在前台”，不是某一个 React Activity 或
ViewController 是否可见。Android 由 `TuttiAppLifecycle` 使用进程级 lifecycle
投影该语义；同进程的扫码、授权等 Activity 切换仍属于前台。iOS 模块投影
`UIApplication` 状态。禁止把 React Native `AppState` 直接接入 DeviceLink、
配对或会话服务，也不要让这些业务服务识别平台 Activity 类型。

### 2.1 需要认识的 iOS 名词

- **Simulator**：macOS 上的 iOS 模拟器。可以验证 React Native UI、键盘、安全区、
  Browser login bridge 和多数网络逻辑，但不能替代相机、真实 Keychain 生命周期、
  蜂窝网络和后台行为的真机验收。
- **Xcode project/workspace**：`TuttiMobile.xcodeproj` 是源码工程；执行 CocoaPods
  后生成的 `TuttiMobile.xcworkspace` 是日常构建入口。
- **CocoaPods**：React Native iOS 原生依赖管理器。Pods 和 workspace 是本机构建
  产物，不提交仓库。Podfile 会加载仓库内的 pnpm 路径兼容处理，避免 CocoaPods
  解析本地 Pod 符号链接时偶发 `pathname contains null byte`。
- **XCFramework**：同时封装 iOS device arm64 与 iOS Simulator 架构的 Apple
  framework。本项目用 gomobile 生成 `TuttiMobileGo.xcframework`。
- **Keychain / CryptoKit**：iOS 设备身份、Ed25519 私钥和账号 session 的安全存储
  与签名能力。
- **Privacy usage description**：相机、本地网络等系统权限必须在 Info.plist 和
  对应本地化资源中说明用途。

iOS 与 Android 使用同一份 `TuttiMobileSecurity` 和 `TuttiDeviceLink` JavaScript
接口。平台原生代码只实现这些 port，不复制配对状态机、Agent DTO、会话逻辑或对话流。

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
- Android App 最低系统版本 API 33（Android 13）；这是当前系统 Ed25519
  实现的最低安全基线
- 完整 Xcode 与 iOS Simulator runtime
- CocoaPods
- iOS 最低系统版本 15.1

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

`apps/mobile` 已建立为 bare React Native 0.86 Android 工程。Mobile Android
宿主生成并消费自己的组合 Go AAR，其中同时包含 transport-only DeviceLink
绑定和 Agent-owned live Subscriber 绑定。独立 DeviceLink probe 仍使用
DeviceLink 包自己的纯传输 AAR，在不经过 React Native 的情况下验证 Go 和
Android native 边界；它会真实执行 ICE、pinned QUIC 和双向 stream。

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

正式 App 的组合绑定由 Mobile 宿主检查和构建：

```sh
pnpm --filter @tutti-os/mobile check:android-bindings
pnpm --filter @tutti-os/mobile android:aar
```

Android AAR 与 iOS XCFramework 的 gomobile 构建固定使用 Go 1.26.0。该版本包含
cgo 导出参数与返回值结构的对齐修复；不要用 Go 1.25 或更早版本重建移动端
native 产物，否则 ARM64 真机可能在返回 `string`、`[]byte` 等含指针值时直接
触发 `bulkBarrierPreWrite: unaligned arguments`。Makefile 会通过 Go 的
`GOTOOLCHAIN` 自动选择所需版本。

输出位于忽略的
`apps/mobile/android/app/libs/tutti-mobile-go.aar`。组合构建只是 Android
宿主的 JNI 装配边界；它不会把 Agent 协议、Workspace DTO 或产品策略移入
`packages/device-link`。

iOS 宿主对同一组 Go package 生成 device + Simulator XCFramework：

```sh
pnpm --filter @tutti-os/mobile check:ios-bindings
pnpm --filter @tutti-os/mobile ios:framework
pnpm --filter @tutti-os/mobile ios:pods
```

输出位于忽略的
`apps/mobile/ios/Frameworks/TuttiMobileGo.xcframework`；`ios:pods` 随后生成
忽略的 `Pods/` 和 `TuttiMobile.xcworkspace`。iOS build 仍保持 DeviceLink
transport、Agent live Subscriber 和产品 adapter 的现有所有权，不把 framing 或
账号策略移入共享 transport。不要移除 Podfile 加载的
`cocoapods_pathname_workaround.rb`；GitHub macOS runner 和本机 pnpm workspace
都可能在 CocoaPods 生成工程时触发该符号链接解析缺陷。

### 4.1 移动端连接竞速边界

移动端连接分成两个边界，不能把控制面轮询和数据面建流混为一谈：

| 边界                                       | 当前策略                                                                                                                                                            | 所有者                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| DeviceLink attempt / Relay descriptor 准备 | direct attempt 与 Relay descriptor 并行；Relay 只有完成一次对端 Agent 请求/响应后才可成为可用路径；WebSocket 事件优先唤醒 direct attempt，丢失时仍按 500ms 轮询状态 | `apps/mobile/src/services/pairingClient.ts` + 原生 bridge              |
| Agent HTTP / live 数据流                   | direct 与 Relay 的底层拨号仍可并行；两条路径先完成 DeviceLink transport probe，收到对端 ACK 后才选中，应用帧仍由原生 bridge 处理                                    | `packages/device-link/mobile` + `services/tuttid/service/mobileremote` |

控制面 WebSocket 复用已上线的设备级 V2 长连接：握手携带当前 session cookie 和
`deviceId`，只接收 `device_link.attempt.changed` 作为唤醒提示；HTTP attempt API
仍是唯一事实来源，推送丢失、重连或乱序都由重读和 500ms 轮询兜底。paired-device
attempt 不绑定 room，服务端按 `userId + deviceId` 精确投递，因此连接功能未开启时
不会建立这条长连接。Relay descriptor 先准备好时，原生层先通过 DeviceLink
transport probe 确认对端 tunnel，再让 Relay 参与连接结果竞速；具体 Agent 请求仍在
探测成功后发送，direct attempt 仍在后台完成。TSH Desktop 的默认 3 秒 Relay 兜底策略
属于另一套已上线产品策略，本改动不改变它。

### 账号浏览器认证边界

Mobile 继续复用 Desktop 使用的托管 Web 登录页、localhost callback bridge 和账号
服务的一次性 transfer code，不维护独立登录页，也不把 provider 凭据或网页 Cookie
带入 App。平台原生层只负责展示与回到前台：Android 在默认浏览器支持时使用
AndroidX Auth Tab，不支持时降级到外部系统浏览器；iOS 使用
`ASWebAuthenticationSession`。两端都以 `tutti://auth/login` 作为原生认证会话的
callback，同时仍由 localhost bridge 交付 transfer code，因此展示方式不会成为新的
账号 session owner。

托管结果页应继续保留手动“打开 App”入口，供 Android 外部浏览器降级路径恢复。
不要把 provider OAuth callback 改成 Mobile 专属页面，也不要绕过现有 transfer code
兑换逻辑。后续若启用 verified App/Universal Links，应只替换前台返回地址，不改变
Web 登录和账号会话边界。

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
pnpm mobile:ios
pnpm mobile:check
pnpm mobile:test
```

`pnpm mobile:android` 会先生成 Mobile 组合 Go AAR，再构建并安装 debug App；
`pnpm mobile:ios` 会先生成 XCFramework、安装 Pods，再构建并启动 Simulator；
`pnpm mobile:start` 启动 Metro，`pnpm mobile:check` 运行移动端 TypeScript、
Jest 和 Android/iOS gomobile binding 检查。首次使用完整 Xcode 时，开发者必须
亲自查看并接受 Apple 的 Xcode 许可协议。

### Native UI foundation

Mobile uses a platform-specific renderer rather than importing Desktop DOM
components. `@tutti-os/ui-system` remains the semantic design-system owner;
its Native entry holds shared Native primitives and tokens, while Mobile keeps
screen composition and product-specific interaction.

- NativeWind 4/Tailwind 3 supplies the Native styling compiler.
  `@tutti-os/ui-system/native.css`, `tailwind.config.js`, Metro, and Babel are
  part of the app bootstrap and must stay aligned.
- `@tutti-os/ui-system/native` owns the Native semantic color, radius, and
  spacing tokens. Mobile must not restore a local palette after a token exists
  there. `renderer-theme.json` is the shared semantic manifest that generates
  Web CSS variables and Native light/dark palettes. `MobileUIProviders` adopts
  the operating-system scheme through `NativeThemeProvider`; views consume
  `useNativeTheme()` rather than a static app-local theme. This still does not
  promise full Desktop/Mobile visual parity.
- `MobileUIProviders` owns the gesture root, safe-area provider, Bottom Sheet
  modal provider, and RN Primitives portal host. Do not mount duplicate roots
  inside screens.
- Every screen with editable content uses the app-owned
  `MobileKeyboardAvoidingView`: iOS applies keyboard padding, Android reduces
  the available height, and Android keeps Activity `adjustResize` enabled for
  edge-to-edge compatibility. The wrapper includes the top safe-area inset as
  its screen-to-content offset; full-screen modal windows override that offset
  to zero and bound keyboard-editable panels relative to the remaining height
  instead of a fixed screen height. Scrollable content uses interactive
  keyboard dismissal on iOS and on-drag dismissal on Android. Do not store
  keyboard height in a service or add per-screen native keyboard listeners.
- In a debug build, open the React Native developer menu and choose “Native UI
  gallery” to review the shared Native primitives on the actual renderer.
- The authenticated computer screen exposes the account avatar as the direct
  entry to the Mobile Settings screen. Settings currently owns the account
  summary, installed app version, About Tutti summary, and confirmed sign-out;
  it does not duplicate the computer list. The account service's avatar URL is
  persisted with the secure session on both platforms, while sessions written
  before that field existed continue to use the account-label fallback.
  Android Software Update is a user-triggered check against the HTTPS mobile
  release pointer. When a newer release is available, the App downloads the
  checksum-verified APK and opens the Android package installer; Android also
  verifies the APK's release signature and the user must confirm the
  installation. It does not check or download in the background.
- Mobile Settings exposes the device-local theme preference directly in the App
  section. The row opens a compact single-choice sheet for system, light, and
  dark modes; selection applies immediately across the full app and status bar.
  Android persists the preference in private `SharedPreferences`, while iOS
  uses `UserDefaults`. The preference survives sign-out and restart, does not
  sync with Desktop or the account, and falls back to system for missing or
  unsupported stored values. A failed write restores the previous theme and
  reports the failure to the user.
- React Native Reusables is a source-copy starting point for a Native primitive;
  adapt and promote a component into the UI System Native layer before an app
  consumes it. Apps must not acquire direct third-party component imports.
- Keep `@gorhom/bottom-sheet` as the dependency for complex gesture, keyboard,
  and dynamic-height sheets; wrap it behind a UI System Native component when
  it becomes a reusable product pattern. The shared compact `NativeSheet` uses
  React Native's window-level `Modal` instead, so its controlled open state does
  not pass through `@gorhom/portal`. It owns keyboard avoidance inside that
  separate window; callers provide its localized accessible close label and may
  set one fixed height. Multi-snap behavior remains outside the compact
  primitive.
- Agent message Markdown is rendered natively with
  `react-native-enriched-markdown`; it consumes the existing AgentGUI
  conversation VM and maps every color, radius, and spacing decision back to
  `@tutti-os/ui-system/native`. AgentGUI continues to own conversation
  semantics and portable URL/Session-mention action resolution, while Mobile
  owns system-link activation, same-workspace Session navigation, and native
  selection behavior. File/app/issue/local-asset policy remains outside the
  portable entry; in particular, the paired-device protocol does not expose
  workspace file routes. This renderer requires Fabric and therefore must be
  verified with a rebuilt native app, not only a Metro refresh.
- Pending Interaction cards consume AgentGUI's canonical Interaction-to-Prompt
  projection. Approval and Plan actions submit only exact runtime option ids;
  an unsupported Interaction is shown as desktop-only instead of synthesizing
  generic allow/deny commands.

需要在没有本机开发环境的真机上测试时，可从 GitHub Actions 手动运行
`Mobile Internal Build` 并选择 `android`。默认情况下它上传保留 14 天的内部
artifact `tutti-mobile-internal-<commit>`，其中的 `app-release.apk` 已嵌入
JavaScript bundle，可直接侧载。所有 Android artifact 使用同一把长期 release key
签名，因此正式 release 之间可以覆盖升级。CI 用仓库级 `github.run_number` 写入
单调递增的 Android `versionCode`，并使用 workflow 的 `android_version_name` 作为
`versionName`。

需要发布给 App 内手动更新时，在同一个 workflow 中将 `publish_android` 设为 `true`。
它会把 APK 上传到不可变的版本目录，并更新：

```text
https://<mobile-release-base-url>/latest.json
```

`latest.json` 使用 `tutti.android.mobile.latest.v1`，包含 `versionName`、
`versionCode`、APK URL、APK 大小和 SHA-256。APK 和校验和写入
`<tag>/<sha256>/` 内容寻址目录并使用长期 immutable 缓存；同一版本的失败发布即使因
新的 Actions run number 生成了不同 APK，也会落到新的摘要目录。工作流会先预检 APK
和校验和是否缺失或内容一致，再补传缺失对象，最后更新使用短缓存的根目录指针，避免
部分发布把后续重试卡在不可覆盖的旧对象上。当前 App 内置的检查地址是
`https://d1x7gb6wqsqmnm.cloudfront.net/tutti-mobile-release-assets/latest.json`，
所以 `TUTTI_MOBILE_RELEASE_ASSETS_BASE_URL` 必须指向同一个
`tutti-mobile-release-assets` 前缀。发布需要以下仓库变量：

- `AWS_REGION`
- `TUTTI_ARTIFACTS_AWS_ROLE_ARN`
- `TUTTI_MOBILE_RELEASE_ASSETS_BASE_URL`
- `TUTTI_MOBILE_RELEASE_ASSETS_S3_BUCKET`
- `TUTTI_MOBILE_RELEASE_ASSETS_S3_PREFIX`

工作流从 GitHub Actions Secrets 读取以下四项，缺失任何一项都会在构建前失败，
不得回退到临时 key 或 unsigned APK：

- `ANDROID_RELEASE_KEYSTORE_BASE64`
- `ANDROID_RELEASE_KEYSTORE_PASSWORD`
- `ANDROID_RELEASE_KEY_ALIAS`
- `ANDROID_RELEASE_KEY_PASSWORD`

release keystore 必须在 GitHub 之外另做加密备份。GitHub Secret 的值无法再次读取，
丢失私钥后将无法向已经安装该签名版本的用户提供原地升级。仓库只提交可公开的
`apps/mobile/android/release-certificate.pem`；CI 会把 APK 的证书指纹与它比对，
防止 Actions Secrets 被误换后产出另一条无法升级的签名链。

Android 更新要求安装包保持相同的 application ID 和 release 签名，并且新包的
`versionCode` 高于已安装版本。已经安装 debug 签名包的设备不能直接覆盖安装
release 包，需要先卸载 debug 包。普通 Android 设备会在下载完成后显示系统安装
确认，不支持静默安装。通过校验的 APK 会保留给权限恢复、安装取消或安装失败后的重试；
安装成功回调会立即删除它，如果升级时旧进程被系统替换，则新版本首次启动会根据记录的
目标 `versionCode` 完成清理。

在 iOS 真机上测试时，运行同一工作流并选择 `ios`。它使用仓库已有的 App Store
Connect API Key 和 `IOS_DEVELOPMENT_TEAM` 仓库变量，让 Xcode 自动管理云签名并
组合 GitHub Actions run number 和 attempt 作为唯一构建号，导出 App Store
Connect IPA 并上传 TestFlight。工作流会确认签名后的 App 包含 release
`main.jsbundle`，同时上传保留 14 天的私有 artifact
`tutti-mobile-ios-testflight-<commit>`，其中包含
`tutti-mobile-testflight.ipa` 和 SHA-256 校验文件；不会创建 GitHub Release 或公开
下载链接。测试人员通过 TestFlight 安装，不需要预先登记设备 UDID；App Store
Connect 仍需把处理完成的构建分配给对应的内部或外部测试组。选择 `all` 可同时构建
两个平台。

## 6. 调试时先判断问题属于哪一层

| 现象                           | 首先检查                                                     |
| ------------------------------ | ------------------------------------------------------------ |
| 页面布局、点击、列表滚动不正确 | React Native component 和 state                              |
| DTO 有值但消息渲染错误         | AgentGUI projection，不要在 screen 内临时修数据              |
| JS 报 native module 不存在     | Native module 注册、Gradle AAR 依赖、重新安装 App            |
| App 切后台后连接状态错误       | Android lifecycle adapter                                    |
| 扫码未请求相机权限或立即返回   | Manifest `CAMERA`、App 权限和 ZXing `PairingCaptureActivity` |
| 手动配对点击后只闪动           | `TuttiMobileSecurity`、设备 identity 注册和页面错误区        |
| 同邮箱登录仍提示无法配对       | 确认 Mobile 与 Desktop 使用相同登录方式和同一账号 identity   |
| ICE 没有 candidate             | Manifest 网络权限、网络状态、DeviceLink 诊断                 |
| QUIC 握手失败                  | peer identity、证书 fingerprint、protocol epoch              |
| P2P 失败但 Relay 成功          | 这是允许的 fallback，检查清洗后的 path 诊断                  |
| 手机和桌面会话状态不一致       | snapshot/event reconcile 和 Agent API，不修本地缓存          |
| 创建、发送、取消语义不一致     | `packages/agent/host`，不能在移动端复制生命周期              |

常用 ADB 命令：

```sh
adb devices
adb shell pm list packages | grep tutti
adb shell am force-stop sh.tutti.mobile
adb logcat
adb logcat -c
adb logcat -s 'TuttiMobileSecurity:E' 'ReactNativeJS:V' '*:S'
adb install -r path/to/app-debug.apk
```

日志中禁止写入 candidate、IP、账号 token、私钥、证书原文或 Agent payload。
扫码使用 App 内置的 ZXing capture Activity，不依赖 Google Play Services 动态下载；
首次使用由 Android 请求相机权限。设备签名私钥由 Android Keystore 生成并持有，
Native bridge 只导出原始 Ed25519 公钥和签名结果。

扫码属于页面发起、Native 完成的本地系统交互，不属于远端配对操作。Android 打开
ZXing `PairingCaptureActivity` 时 `MainActivity` 会暂停，但 App 进程仍在前台；
`TuttiAppLifecycle` 因此不得发布后台事件。iOS 同样只向业务层投影整个
`UIApplication` 的前后台语义，不暴露页面级过渡。设备服务使用显式 `scanning`
阶段承接扫码结果，只有解析出配对码后才启动可被真实后台策略暂停的 claim/poll。
已经发出的 claim 必须在回到前台后按 challenge 状态对账，不能盲目重试可能已经成功的
POST；只读 poll 才可以在生命周期中断后安全重试。扫码 adapter 返回可取消
operation；设备服务销毁时必须关闭原生扫描界面，并在旧 scanner callback 排空后才
完成取消。扫码页内的“无法扫描？输入配对码”会关闭 Native scanner，并由 screen 打开
共享的手动输入面板；输入框的展开和值属于 screen 临时状态，不进入设备服务快照。

移动端为生命周期与配对阶段输出结构化 JavaScript 日志，只记录事件名、可枚举阶段、
来源和脱敏错误码。禁止记录二维码、手动配对码、challenge id、secret 或 session。

## 7. 真机开发需要做什么

Android 手机启用“开发者选项”和“USB 调试”，连接电脑后执行：

```sh
adb devices
```

首次连接时手机会弹出授权确认。开发期 debug build 可以直接安装，不需要
Google Play 账号。以下事项等正式分发前再处理：

- 最终 Android application ID
- 正式应用名称和图标
- release keystore 的额外离线备份和密钥轮换应急方案
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
- Desktop 设置页已接入二维码创建、配对码复制、轮询确认和撤销；
- Desktop owner host 的 mobile remote access 当前已停用；持久化的
  `mobile.remoteAccessSettings` 键仅为旧 profile 保留，desktop daemon 会忽略它，
  不再轮询配对和 DeviceLink attempt 控制面；
- `apps/mobile` 已接入平台原生浏览器认证 GitHub 登录和邮箱验证码登录、Android Keystore
  设备身份、设备列表、内置 ZXing 二维码扫描或手动粘贴配对码，以及 challenge
  claim/poll；
- React Native 0.86、Kotlin native module、DeviceLink AAR 和四 ABI debug APK
  已在 Android 15 ARM64 模拟器完成构建、安装和启动验证。
- 共享 authenticated facade 已统一 Desktop/Android 的 ICE、fingerprint pinning、
  QUIC、stream 和关闭顺序；
- `tuttid` owner host 已接入 paired-device rendezvous，并且只允许 workspace、
  Agent Target catalog 和 Agent Session HTTP surface；
- `tuttid` owner host 已把 workspace-scoped `agent.activity.updated` 接入
  `agent_live` DeviceLink 长流。Android 通过同一 AAR 中的 Go Subscriber 校验协议
  revision、stream identity、epoch 和连续 sequence 后才交给 React Native；
  Mobile 将 `message_delta` 投影到 activity-core optimistic overlay，直接应用
  Turn/Interaction 更新，并在 discontinuity、序列断点和重连时读取 canonical 数据；
- workspace 前台已有 live stream 时不再运行一秒消息轮询和两秒会话轮询；长流断开或
  协议不可用时才恢复轮询。`WorkspaceActivityMessagePageLoader` 单独负责 transport
  page 请求、DTO 映射、Engine 应用和按 Session + 查询覆盖范围的 single-flight；
  `WorkspaceActivityService` 只决定轮询时机和 authoritative/incremental 读取语义。
  older/incremental 请求不会吞掉 live gap 所需的 authoritative newest-page 读取；
  旧会话的慢请求也不会阻塞用户刚切换到的会话，并以一秒退避自动重建 live stream；
- Android caller 已接入 create/get/update attempt、STUN 二次 gathering、真实
  DeviceLink request stream、端到端请求 deadline、prepare/connect generation
  fencing 和 Native 15 秒后台 grace period；
- Android/iOS caller 已将 direct 与 Relay 的 Agent 数据流接入同一条即时竞速；控制面
  Relay descriptor 先就绪时先做一次端到端 Agent 请求确认，不再把 WebSocket 101
  当成成功，同时不等待 direct attempt 的 TTL；direct attempt 会在后台继续完成，
  作为后续数据流竞速的 direct 候选；UI 和现有 DeviceLink path scope 保持不变；
- 移动端已直接复用 `@tutti-os/client-tuttid-ts`，并从
  `@tutti-os/agent-gui` 复用安全的 Interaction answer model、无 DOM 的会话摘要和
  canonical 对话流 projection，完成 Personal 单 workspace 校验、按置顶/项目/最近分组的
  独立会话列表、可折叠 section、刷新/失败重试、section 分页、置顶、重命名、删除、增量
  消息读取、新建/切换、发送、停止和结构化 Interaction 提交；Native 对话流遵循同一份
  消息合并、思考、工具活动、处理态和 Turn summary 语义，并复用 AgentGUI 的
  `following` / `detached` 末尾跟随状态机；Mobile 只负责原生手势、滚动执行与展开状态。
  会话列表标题显示当前电脑和连接状态；连接详情继续复用现有路径、传输通道和即时
  健康探测字段，不暴露 candidate 或地址信息；Relay 竞速属于 native transport
  内部行为，不新增 UI 分支；
  切换会话会定位最新内容，流式更新只在 `following` 时跟随；主动上滑会在首个滚动帧前
  进入 `detached` 并提供回到底部入口，内容增长和近底部几何不能自行恢复跟随；加载历史
  消息时保持当前阅读锚点；
- Rail service 只保存 section membership、Session id、cursor、total 和请求状态；
  首屏与分页返回的 Session DTO 瞬时通过共享 mapper upsert 到 workspace Engine，
  不在 Mobile 再维护一份实体缓存。root detail 的 Session、child Session 和 Turn
  也通过一个原子 `session/detailSnapshotReceived` 进入 Engine；当前 Native
  会话流不展示 child 对话，因此只分页读取选中 root Session 的消息，不预取没有消费方的
  child transcript；
- Agent 消息正文已接入 Fabric 原生 Markdown renderer，支持 GFM 标题、列表、代码块、
  表格、任务列表、流式尾部动画和系统文本选择；样式全部映射到 Native UI System
  token，Mobile 不再维护 Markdown AST 或另一份消息类型；
- workspace media 子 service 使用 generated client 的 session attachment API
  读取 canonical 消息图片并缓存 data URI；Native renderer 展示图片网格、加载态和
  全屏预览，远程 URL/data URI 形式的 generated image 也直接使用同一套预览交互；
- Composer options 以 Agent Target 为 key 通过同一个 `AgentSessionEngine` 加载，复用
  AgentGUI 的纯 support/settings projection 和 activity-tuttid DTO mapper。Native
  sheet 只负责模型、推理、速度、权限和计划模式的本地展示；已有会话设置走 Engine
  command，新建会话的目标设置作为 activation intent 一并提交。settings sheet 与
  tools modal 共享一个带 activation identity 的 overlay 状态，Native 延迟关闭回调
  只能关闭自己所属的 activation，不能在 ABA 切换后关闭同类型的新 overlay；
  `commandsAvailable` 为 false 时关闭现有 overlay，并统一禁用输入、工具入口、设置
  chips 和 sheet 选项，避免展示可操作但会被 command adapter 拒绝的控件；
- Mobile 与 Desktop 复用 activity-core 的 realtime observation 和 prompt command
  executor。Interaction 的 submitting/failure、child 聚合和 per-Session runtime
  availability 全部从 Engine 投影；前后台恢复会解锁 Engine 中全部已知 Session，
  不依赖有界 Rail 页重新发现。Native card 不维护独立 Promise 状态，失败重试复用
  Engine 保存的原始 response，不能修改后伪装成同一请求；
- Go authenticated link、owner host、application frame、allowlist、race，以及
  TypeScript/Jest、Metro bundle、Kotlin/Java/CMake、四 ABI APK 均已有自动验证。
- `apps/mobile/ios` 已建立 React Native 0.86/Fabric Simulator shell，并提供与
  Android 相同的两个 Native Module contract；iOS adapter 已接入 Keychain
  Ed25519 identity/session、显式 API session cookie、localhost browser login
  bridge、AVFoundation QR scanner、Go DeviceLink request framing、Agent live
  Subscriber、事件派发和 15 秒后台 grace。模拟器扫码明确降级到现有手动粘贴入口，
  不伪造相机成功。
- iOS Metro production bundle、device + Simulator XCFramework、Pods、generic
  Simulator build 均已通过；App 已安装并启动于 iPhone 17 Pro / iOS 26.5
  Simulator，Hermes 成功执行共享 JavaScript bundle。

接下来按顺序推进：

1. 用手动配对码在 iOS Simulator 验证真实账号登录、配对、DeviceLink 和 Agent
   对话闭环；
2. 用真实账号和 Android 真机跑通 QR claim/confirm、direct DeviceLink 与 Agent 操作；
3. 增加 paired-device Relay fallback，并验证 direct/Relay 切换后的 live stream
   重连与 canonical 对账；
4. 补齐前台自动重连、撤销专用状态，以及 mention、workspace file 和媒体预览动作；
5. Personal 闭环稳定后，再让 TSH 删除本地 transport 副本并消费共享 DeviceLink module。

遇到问题时先看
[Troubleshooting](../conventions/troubleshooting/README.md)，再根据上面的分层定位。

## 10. Personal MVP 真机验收

这一步需要真实 Tutti 账号和 Android 13 或更高版本的手机。App 只提供一个 Tutti
账号登录入口；它会打开平台浏览器认证会话，由托管登录页提供具体登录方式，并通过
短时 localhost bridge 将一次性 transfer code 返回 App。App 不再内置邮箱验证码
表单，账号凭据和网页 Cookie 也不会进入 App。不要在 Issue、PR、聊天或日志中粘贴
验证码、session cookie、二维码、transfer code 或配对码。

### 10.1 启动当前分支的 Desktop

在仓库根目录准备并启动开发版 Desktop：

```sh
pnpm install
pnpm setup:dev
make dev-gui
```

开发版使用独立状态目录，因此即使正式版已经登录，也可能需要在开发版重新登录
同一个 Tutti 账号。进入工作区后，打开：

```text
工作区设置 -> 账号 -> 手机远程访问
```

先保持此页面打开；点击“配对手机”后会显示二维码和可复制的配对码。

### 10.2 安装并启动 Android App

手机打开开发者选项和 USB 调试，连接电脑并接受手机上的授权提示。先确认：

```sh
adb devices
```

列表中的手机状态必须为 `device`，不能是 `unauthorized`。在一个新终端启动
Metro，并建立 USB 端口转发：

```sh
adb reverse tcp:8081 tcp:8081
pnpm mobile:start
```

再打开另一个终端构建和安装 App：

```sh
pnpm mobile:android
```

App 启动后，使用与 Desktop 相同的账号登录方式。如果 Desktop 使用 GitHub 登录，
Mobile 也点击“使用 GitHub 登录”并在平台浏览器认证会话中完成登录；仅输入 GitHub 展示的
相同邮箱不保证得到同一个账号 identity。Desktop 先在设置的开发者页打开
“启用手机远程访问”，再进入「连接」并点击“配对手机”生成二维码。Mobile
登录成功后点击配对，优先扫描 Desktop 二维码。首次扫码时允许 App 使用相机；如果
当前环境无法使用相机，就在 Desktop 点击“复制配对码”，再在 Mobile 的扫码页点击
“无法扫描？输入配对码”并粘贴。相机权限被拒绝或扫码器不可用时，Mobile 会自动打开
同一个手动输入面板。

配对二维码是 5 分钟有效的一次性 challenge。Desktop 会在 challenge 到期或状态查询
失败后撤下旧二维码；此时重新点击“配对手机”生成新码，不要继续使用之前复制或拍摄的
二维码。

### 10.3 验收清单

按顺序验证，每一步成功后再继续：

1. Mobile 只显示当前手机 identity 拥有的同账号配对设备。
2. 点击 Desktop 后成功建立可用 DeviceLink，并且仅在返回恰好一个 Personal workspace
   时进入会话列表；零个或多个 workspace 都明确失败。
3. 会话列表可新建、切换会话，选择后进入独立详情页并正确显示历史对话流。
4. 发送一条普通消息，Desktop 和 Mobile 最终显示同一个结果且没有重复消息。
5. 在 Agent 运行时点击停止，两个端最终收敛到同一个 Turn 状态。
6. 分别触发 Question、Approval 和 Plan 交互，并从 Mobile 提交一次。
7. 将 App 切到后台少于 15 秒再返回，当前连接保持；切到后台超过 15 秒再返回，
   App 回到设备列表并可手动重连。
8. 在 Desktop 移除手机配对，Mobile 刷新后不再显示该 Desktop，旧连接不可继续使用。
9. 至少分别测试同一 Wi-Fi 和手机蜂窝网络，确认 Agent HTTP/live 请求均可用；Relay
   仅作为内部传输，不改变现有 UI 和 Agent DTO。

验收失败时保留三个终端：Desktop、Metro、`adb logcat`。先记录失败发生在哪一层、
操作步骤和用户可见错误，不要复制网络 candidate、IP、Agent 正文或任何账号材料。
