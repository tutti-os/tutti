import {
  createScopedI18nRuntime,
  createScopedLocaleObjectsI18nModuleManifest,
  type I18nDictionary,
  type I18nRuntime
} from "@tutti-os/ui-i18n-runtime";

type ConnectorMarketI18nLocale = "en" | "zh-CN";
export const connectorMarketI18nNamespace = "connectorMarket";
export const tuttiI18nModule = createScopedLocaleObjectsI18nModuleManifest({
  localeObjectByLocale: {
    en: "connectorMarketEn",
    "zh-CN": "connectorMarketZhCN"
  },
  name: "connector-market",
  namespace: "connectorMarket",
  sourceRoot: "packages/connector/renderer/src"
});

const connectorMarketEn = {
  accessScopeTitle: "Access scope",
  accountResourcesDescription:
    "Resources the selected {{name}} account is permitted to access",
  accountResourcesTitle: "Account resources",
  accountSelectionDescription:
    "You will choose the account during authorization. Tutti does not read account information before you continue",
  accountSelectionTitle: "Choose an account on {{name}}",
  actionAuthorize: "Authorize",
  actionAuthorizeSuccess: "Authorization successful",
  actionContinueAuthorization: "Continue",
  actionDisconnect: "Disconnect",
  actionDisconnecting: "Disconnecting…",
  actionInstall: "Install",
  actionInstallSuccess: "Installation successful",
  actionInstalling: "Installing…",
  actionManage: "Manage",
  actionMore: "More actions",
  actionRefresh: "Refresh",
  authorizationQrCodeAlt: "Authorization QR code",
  actionRetry: "Retry",
  actionTry: "Try it",
  actionUninstall: "Uninstall",
  actionUninstalling: "Uninstalling…",
  actionUpdate: "Update",
  actionUpdateAuthorization: "Reauthorize",
  actionUpdating: "Updating…",
  actionWaitingAuthorization: "Authorizing",
  blockedDescription:
    "This connector cannot be used in the current environment",
  blockedTitle: "Connector unavailable",
  cancel: "Cancel",
  catalogEmpty: "No connectors found",
  catalogError: "The connector catalog could not be loaded",
  catalogErrorDescription: "Please try again later",
  catalogInvalidDataDescription:
    "The connector service returned invalid data. Please try again later",
  catalogInvalidDataTitle: "Connectors are temporarily unavailable",
  catalogSection: "Connectors",
  catalogUnavailableDescription:
    "Check your network connection, then try again",
  catalogUnavailableTitle: "Unable to connect to the connector service",
  categoryDevelopment: "Development",
  categoryFeatured: "Featured",
  categoryOther: "Other",
  categoryProductivity: "Productivity",
  categoryUnnamed: "Category",
  close: "Close",
  connectedStatus: "Connected",
  copyDeviceCode: "Copy device code",
  connectorAuthorizationFailed:
    "Authorization could not be started. Try again.",
  connectorAuthorizationTimedOut:
    "Authorization timed out. Start authorization again.",
  connectorAuthorizationConfigurationInvalid:
    "This connector has an invalid authorization configuration",
  connectorDisconnectFailed:
    "Authorization could not be disconnected. Try again.",
  connectorInstallFailed: "Installation failed. Try again.",
  connectorUninstallFailed: "Uninstallation failed. Try again.",
  connectorUninstallSuccess: "{{name}} was uninstalled",
  connectorUpdateFailed: "Update failed. Try again.",
  sectionLoadError: "This connector category could not be loaded",
  connectorInitial: "Connector icon for {{name}}",
  description: "Install and authorize external services for every Agent",
  detailAuthorization: "Authorization",
  detailCompatibility: "Compatibility",
  detailImplementation: "Implementation",
  detailReleaseStatus: "Release status",
  detailRuntime: "Runtime",
  detailTransport: "Interfaces",
  detailVersion: "Version",
  deviceCodeCopied: "Device code copied",
  dialogAuthorizationDescription:
    "Tutti will access {{name}} only within the permissions shown below",
  dialogAuthorizationPending:
    "Complete authorization in the browser, then return to Tutti",
  dialogAuthorizationTitle: "Connect {{name}} account",
  dialogManagementDescription:
    "Review installation, authorization, and permissions",
  dialogManagementTitle: "{{name}} connector",
  dialogInstallationDescription:
    "Once installed, this connector is available to every Agent.",
  dialogInstallationTitle: "Install {{name}}",
  dialogUpdateDescription:
    "Update to the active connector release before continuing.",
  dialogUpdateTitle: "Update {{name}}",
  dialogUninstallDescription:
    "This stops the connector on this device and removes its local runtime files and any installed CLI. Account authorization is kept so it can be reused after reinstalling.",
  dialogUninstallTitle: "Uninstall {{name}}?",
  exactAccessNotice:
    "The exact resources you can access are determined by your account and organization policies",
  loading: "Loading connectors…",
  loadMore: "Load more",
  noPermissions: "This connector does not request additional permissions",
  operationAccepted: "Preparing",
  operationActivating: "Activating",
  operationAuthorizing: "Authorizing",
  operationCompleted: "Completed",
  operationDeactivating: "Deactivating",
  operationDisconnecting: "Disconnecting",
  operationDownloading: "Downloading",
  operationFailed: "Failed",
  operationPrepared: "Prepared",
  operationRefreshing: "Refreshing",
  organizationResourcesDescription:
    "Organization access remains controlled by provider and organization policy",
  organizationResourcesTitle: "Organization resources",
  permissionNotice:
    "Authorization credentials are encrypted by Tutti. Agents cannot read the original token",
  permissionsTitle: "Permissions",
  refreshFailed: "Refresh failed",
  searchLabel: "Search connectors",
  searchPlaceholder: "Search connectors",
  secretInputDescription:
    "The token is sent directly to Tutti for validation and encrypted storage. It is not saved by the desktop app",
  secretInputPlaceholder: "Paste token",
  secretInputTitle: "Access token",
  unsupportedAuthorizationField:
    "This field requires a host capability that is not available",
  statusAuthorizationRequired: "Authorization required",
  statusInstalled: "Installed",
  statusNotInstalled: "Not installed",
  statusUnavailable: "Unavailable",
  statusUpdateAvailable: "Update available",
  title: "Connectors"
} as const satisfies I18nDictionary;

const connectorMarketZhCN = {
  accessScopeTitle: "访问范围",
  accountResourcesDescription: "当前 {{name}} 账号有权限访问的资源",
  accountResourcesTitle: "账号资源",
  accountSelectionDescription:
    "你将在授权过程中选择账号，继续前 Tutti 不会读取账号信息",
  accountSelectionTitle: "在 {{name}} 中选择账号",
  actionAuthorize: "授权",
  actionAuthorizeSuccess: "授权成功",
  actionContinueAuthorization: "继续授权",
  actionDisconnect: "解除授权",
  actionDisconnecting: "解除中…",
  actionInstall: "安装",
  actionInstallSuccess: "安装成功",
  actionInstalling: "安装中…",
  actionManage: "管理",
  actionMore: "更多操作",
  actionRefresh: "刷新",
  authorizationQrCodeAlt: "授权二维码",
  actionRetry: "重试",
  actionTry: "去试试",
  actionUninstall: "卸载",
  actionUninstalling: "卸载中…",
  actionUpdate: "更新",
  actionUpdateAuthorization: "重新授权",
  actionUpdating: "更新中…",
  actionWaitingAuthorization: "授权中",
  blockedDescription: "当前环境无法使用这个连接器",
  blockedTitle: "连接器不可用",
  cancel: "取消",
  catalogEmpty: "未找到连接器",
  catalogError: "无法加载连接器",
  catalogErrorDescription: "请稍后再试",
  catalogInvalidDataDescription: "连接器服务返回的数据有误，请稍后再试",
  catalogInvalidDataTitle: "连接器暂时无法加载",
  catalogSection: "连接器",
  catalogUnavailableDescription: "请检查网络连接，然后重试",
  catalogUnavailableTitle: "暂时无法连接连接器服务",
  categoryDevelopment: "开发",
  categoryFeatured: "精选",
  categoryOther: "其他",
  categoryProductivity: "生产力",
  categoryUnnamed: "分类",
  close: "关闭",
  connectedStatus: "已连接",
  copyDeviceCode: "复制设备代码",
  connectorAuthorizationFailed: "无法启动授权，请重试",
  connectorAuthorizationTimedOut: "授权已超时，请重新授权",
  connectorAuthorizationConfigurationInvalid: "连接器授权配置无效",
  connectorDisconnectFailed: "无法解除授权，请重试",
  connectorInstallFailed: "安装失败，请重试",
  connectorUninstallFailed: "卸载失败，请重试",
  connectorUninstallSuccess: "已卸载“{{name}}”",
  connectorUpdateFailed: "更新失败，请重试",
  sectionLoadError: "无法加载此连接器分类",
  connectorInitial: "{{name}} 连接器图标",
  description: "安装并授权外部服务，让所有 Agent 使用数据与工具",
  detailAuthorization: "授权方式",
  detailCompatibility: "兼容性",
  detailImplementation: "实现类型",
  detailReleaseStatus: "发布状态",
  detailRuntime: "运行时",
  detailTransport: "运行方式",
  detailVersion: "版本",
  deviceCodeCopied: "设备代码已复制",
  dialogAuthorizationDescription:
    "Tutti 只会在下方列出的权限范围内访问 {{name}}",
  dialogAuthorizationPending: "请在浏览器中完成授权，然后返回 Tutti",
  dialogAuthorizationTitle: "连接 {{name}} 账号",
  dialogManagementDescription: "查看安装、授权与权限状态",
  dialogManagementTitle: "{{name}} 连接器",
  dialogInstallationDescription: "安装后，所有 Agent 都可以使用这个连接器。",
  dialogInstallationTitle: "安装 {{name}}",
  dialogUpdateDescription: "继续前需先更新到当前连接器版本",
  dialogUpdateTitle: "更新 {{name}}",
  dialogUninstallDescription:
    "这会停用此设备上的连接器，并删除本地运行文件和已安装的 CLI。账号授权不会被撤销，重新安装后可以继续使用原授权",
  dialogUninstallTitle: "卸载“{{name}}”？",
  exactAccessNotice: "具体可访问范围由你的账号权限和组织策略决定",
  loading: "正在加载连接器…",
  loadMore: "加载更多",
  noPermissions: "这个连接器不申请额外权限",
  operationAccepted: "准备中",
  operationActivating: "激活中",
  operationAuthorizing: "授权中",
  operationCompleted: "已完成",
  operationDeactivating: "停用中",
  operationDisconnecting: "断开中",
  operationDownloading: "下载中",
  operationFailed: "失败",
  operationPrepared: "准备完成",
  operationRefreshing: "刷新中",
  organizationResourcesDescription: "组织访问范围仍由服务商与组织策略决定",
  organizationResourcesTitle: "组织资源",
  permissionNotice: "授权凭证会由 Tutti 加密保存，Agent 无法读取原始 Token",
  permissionsTitle: "申请的权限",
  refreshFailed: "刷新失败",
  searchLabel: "搜索连接器",
  searchPlaceholder: "搜索连接器",
  secretInputDescription:
    "Token 会直接发送给 Tutti 完成校验和加密存储，桌面端不会保存明文",
  secretInputPlaceholder: "粘贴 Token",
  secretInputTitle: "访问令牌",
  unsupportedAuthorizationField: "当前宿主不支持这个授权字段",
  statusAuthorizationRequired: "需要授权",
  statusInstalled: "已安装",
  statusNotInstalled: "未安装",
  statusUnavailable: "不可用",
  statusUpdateAvailable: "可更新",
  title: "连接器"
} as const satisfies I18nDictionary;

export type ConnectorMarketI18nKey = keyof typeof connectorMarketEn;
export type ConnectorMarketI18nRuntime = I18nRuntime<ConnectorMarketI18nKey>;

const connectorMarketDefaults: Record<
  ConnectorMarketI18nLocale,
  I18nDictionary
> = {
  en: connectorMarketEn,
  "zh-CN": connectorMarketZhCN
};

export const connectorMarketI18nResources: Record<
  ConnectorMarketI18nLocale,
  I18nDictionary
> = {
  en: { [connectorMarketI18nNamespace]: connectorMarketDefaults.en },
  "zh-CN": {
    [connectorMarketI18nNamespace]: connectorMarketDefaults["zh-CN"]
  }
};

export function createConnectorMarketI18nRuntime(
  runtime: I18nRuntime<string>
): ConnectorMarketI18nRuntime {
  return createScopedI18nRuntime<ConnectorMarketI18nKey>(
    runtime,
    connectorMarketI18nNamespace
  );
}
