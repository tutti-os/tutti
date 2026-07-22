import {
  Badge,
  BareIconButton,
  Button,
  Checkbox,
  Combobox,
  ConfirmationDialog,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
  Input,
  MenuSurface,
  MentionPill,
  type MentionPillKind,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  RadioIndicator,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSplitColumn,
  SelectSplitColumnItems,
  SelectSplitColumnLabel,
  SelectSplitDivider,
  SelectSplitLayout,
  SelectTrigger,
  SelectValue,
  ShortcutBadge,
  Spinner,
  Sortable,
  SortableContent,
  SortableItem,
  SortableItemHandle,
  SortableOverlay,
  StatusDot,
  Switch,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Toaster,
  UnderlineTabs,
  ViewportMenuSurface,
  toast,
  type ViewportMenuPlacement
} from "@tutti-os/ui-system/components";
import * as SystemIcons from "@tutti-os/ui-system/icons";
import { uiSystemMetadata } from "@tutti-os/ui-system/metadata";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode
} from "react";

import {
  getStoryboardThemeVars,
  storyboardFontCjk,
  storyboardFontEnglish,
  storyboardFontMono,
  type StoryboardThemeMode
} from "./storyboardTheme";
import {
  colorsContent,
  foundationNavigationSections,
  metricsContent,
  overviewContent,
  typographyContent
} from "./foundation/content";

const storyboardDarkThemeOverrideCss = `
[data-storyboard-theme="dark"] .bg-white,
[data-storyboard-theme="dark"] [class*="bg-[rgb(255,255,255)]"],
[data-storyboard-theme="dark"] [class*="bg-[rgb(255,_255,_255)]"] {
  background-color: var(--background-fronted) !important;
}

[data-storyboard-theme="dark"] [class*="bg-[#e9e5da]"],
[data-storyboard-theme="dark"] [class*="bg-[rgb(233,229,218)]"] {
  background-color: var(--storyboard-canvas) !important;
}

[data-storyboard-theme="dark"] [class*="text-[#1a1a1a]"],
[data-storyboard-theme="dark"] [class*="text-[rgb(0,0,0)]"] {
  color: var(--text-primary) !important;
}

[data-storyboard-theme="dark"] [class*="text-[rgba(43,43,43"],
[data-storyboard-theme="dark"] [class*="text-[#1a1a1a]/"] {
  color: var(--text-secondary) !important;
}

[data-storyboard-theme="dark"] [class*="border-[#1a1a1a]"],
[data-storyboard-theme="dark"] [class*="border-[rgba(0,0,0"],
[data-storyboard-theme="dark"] [class*="border-[rgba(43,43,43"] {
  border-color: var(--border-1) !important;
}

[data-storyboard-theme="dark"]
  [class*="divide-[#1a1a1a]"]
  > :not([hidden])
  ~ :not([hidden]) {
  border-color: var(--border-1) !important;
}
`;

const {
  CheckIcon,
  CopyIcon,
  DarkModeIcon,
  DeleteIcon,
  EditIcon,
  FailedFilledIcon,
  FileIcon,
  FileCreateIcon,
  GitHubBrandIcon,
  GoogleBrandIcon,
  LightModeIcon,
  LocateFolderIcon,
  RefreshIcon,
  SettingsIcon,
  SuccessFilledIcon,
  UploadIcon,
  WarningLinedIcon
} = SystemIcons;

const storyboardComponents = uiSystemMetadata.components.filter(
  (component) => component.storyboard === true
);

const metadataByName = new Map(
  uiSystemMetadata.components.map((component) => [component.name, component])
);

const metadataFor = (name: string) => metadataByName.get(name);

const hasStoryboard = (name: string) =>
  storyboardComponents.some((component) => component.name === name);

const storyboardLayerFor = (name: string) => metadataFor(name)?.layer ?? "base";

const filledPreferredIconBases = new Set([
  "failed-icon",
  "folder-icon",
  "success-icon",
  "warning-icon"
]);

const alwaysShowIconBases = new Set([
  ...filledPreferredIconBases,
  "nav-applications-icon"
]);
const hiddenIconStoryExports = new Set(["DirectoryIcon", "FileTextIcon"]);

const iconVariantSortRank = (
  variant: "lined" | "filled" | undefined,
  baseKey: string
) => {
  const preferredVariant = filledPreferredIconBases.has(baseKey)
    ? "filled"
    : "lined";

  if (variant === preferredVariant) {
    return 0;
  }

  if (variant === "lined" || variant === "filled") {
    return 1;
  }

  return 2;
};

const iconBaseSortKey = (id: string) =>
  id.replace(/-(filled|lined)-icon$/, "-icon");

const iconBaseSortOrder = new Map<string, number>();

uiSystemMetadata.components.forEach((component, metadataIndex) => {
  if (component.category !== "icon") {
    return;
  }

  const baseKey = iconBaseSortKey(component.id);
  const currentOrder = iconBaseSortOrder.get(baseKey);

  const preferredVariant = filledPreferredIconBases.has(baseKey)
    ? "filled"
    : "lined";

  if (
    currentOrder === undefined ||
    component.iconVariant === preferredVariant
  ) {
    iconBaseSortOrder.set(baseKey, metadataIndex);
  }
});

const iconStories = uiSystemMetadata.components
  .map((component, metadataIndex) => ({ component, metadataIndex }))
  .filter(
    ({ component }) =>
      component.category === "icon" &&
      component.export !== "TuttiMark" &&
      !hiddenIconStoryExports.has(component.export)
  )
  .map(({ component, metadataIndex }) => ({
    id: component.id,
    iconVariant: component.iconVariant,
    metadataIndex,
    layer: component.layer,
    name: component.name,
    Icon: SystemIcons[
      component.export as keyof typeof SystemIcons
    ] as ComponentType<{
      className?: string;
      size?: number | string;
      title?: string;
    }>
  }))
  .filter((item) => typeof item.Icon === "function")
  .sort((left, right) => {
    const baseOrder =
      (iconBaseSortOrder.get(iconBaseSortKey(left.id)) ?? left.metadataIndex) -
      (iconBaseSortOrder.get(iconBaseSortKey(right.id)) ?? right.metadataIndex);

    if (baseOrder !== 0) {
      return baseOrder;
    }

    const leftBaseKey = iconBaseSortKey(left.id);
    const rightBaseKey = iconBaseSortKey(right.id);
    const variantOrder =
      iconVariantSortRank(left.iconVariant, leftBaseKey) -
      iconVariantSortRank(right.iconVariant, rightBaseKey);

    if (variantOrder !== 0) {
      return variantOrder;
    }

    return left.metadataIndex - right.metadataIndex;
  })
  .filter((item, itemIndex, items) => {
    const baseKey = iconBaseSortKey(item.id);
    if (alwaysShowIconBases.has(baseKey)) {
      return true;
    }

    return (
      items.findIndex(
        (candidate) => iconBaseSortKey(candidate.id) === baseKey
      ) === itemIndex
    );
  });

const componentSection = (
  id: string,
  label: string,
  summary: string,
  metadataName = label
) =>
  hasStoryboard(metadataName)
    ? [{ id, label, layer: storyboardLayerFor(metadataName), summary }]
    : [];

const iconSection = iconStories.length
  ? [
      {
        id: "icons",
        label: "Icons",
        layer: "base",
        summary: "系统图标与品牌图标"
      }
    ]
  : [];

const buttonComponent = uiSystemMetadata.components.find(
  (component) => component.name === "Button"
);

const sections = [
  ...foundationNavigationSections,
  ...componentSection("badge", "Badge", "状态标签与紧凑元信息"),
  ...componentSection("button", "Button", "按钮层级、尺寸与状态"),
  {
    id: "checkbox",
    label: "Checkbox",
    layer: "base",
    summary: "多选项、文件选择与布尔配置"
  },
  ...componentSection("combobox", "Combobox", "可搜索选项选择与自定义值输入"),
  ...componentSection("dialog", "Dialog", "弹层、确认与焦点流程"),
  ...componentSection("drawer", "Drawer", "边缘抽屉与 sheet 面板"),
  ...iconSection,
  ...componentSection("input", "Input", "文本输入、状态与表单行"),
  ...componentSection(
    "mention-pill",
    "Mention Pill",
    "富文本字段中的 issue、session、file 引用 token"
  ),
  ...componentSection("popover", "Popover", "锚定浮层与轻量设置面板"),
  ...componentSection(
    "radio-indicator",
    "RadioIndicator",
    "单选项的圆环选中态表达"
  ),
  ...componentSection(
    "resizable-panel-group",
    "Resizable Panel Group",
    "可拖拽 split pane 布局 primitive",
    "ResizablePanelGroup"
  ),
  ...componentSection("select", "Select", "选项选择、分组与筛选"),
  ...componentSection(
    "shortcut-badge",
    "ShortcutBadge",
    "快捷键提示与 tooltip 辅助标识"
  ),
  {
    id: "spinner",
    label: "Spinner",
    layer: "base",
    summary: "加载、提交与长任务等待指示器"
  },
  ...componentSection(
    "sortable",
    "Sortable",
    "鼠标、触摸与键盘可访问的受控排序组件"
  ),
  ...componentSection(
    "status-dot",
    "Status Dot",
    "紧凑状态标识与在线指示",
    "StatusDot"
  ),
  {
    id: "switch",
    label: "Switch",
    layer: "base",
    summary: "即时开关型布尔配置"
  },
  ...componentSection("textarea", "Textarea", "多行输入与说明字段"),
  ...componentSection("sonner", "Sonner", "右上角通知与可操作提示", "Toaster"),
  ...componentSection("toast", "Toast", "瞬时反馈与通知堆叠", "ToastRoot"),
  ...componentSection("tooltip", "Tooltip", "悬浮提示与紧凑说明"),
  ...componentSection(
    "underline-tabs",
    "Underline Tabs",
    "滚动 tab 行与二级导航",
    "UnderlineTabs"
  ),
  ...componentSection(
    "menu-surface",
    "Menu Surface",
    "基础菜单与浮层容器",
    "MenuSurface"
  ),
  ...componentSection(
    "viewport-menu-surface",
    "Viewport Menu Surface",
    "视口边界感知的浮层容器",
    "ViewportMenuSurface"
  )
] as const;

const navigationGroups = [
  {
    id: "foundation",
    label: "Foundation",
    sections: sections.filter((section) => section.layer === "foundation")
  },
  {
    id: "base",
    label: "Base Components",
    sections: sections.filter((section) => section.layer === "base")
  },
  {
    id: "business",
    label: "Business Components",
    sections: sections.filter((section) => section.layer === "business")
  }
].filter((group) => group.sections.length > 0);

const hasBaseStories = sections.some((section) => section.layer === "base");
const hasBusinessStories = sections.some(
  (section) => section.layer === "business"
);

type StoryboardLanguage = "zh" | "en";

const storyboardLanguageStorageKey = "tutti-ui-storyboard-language";
const storyboardThemeStorageKey = "tutti-ui-storyboard-theme";

const isStoryboardLanguage = (
  value: string | null
): value is StoryboardLanguage => value === "zh" || value === "en";

const isStoryboardThemeMode = (
  value: string | null
): value is StoryboardThemeMode => value === "light" || value === "dark";

const readStoredLanguage = (): StoryboardLanguage => {
  if (typeof window === "undefined") {
    return "zh";
  }

  const storedLanguage = window.localStorage.getItem(
    storyboardLanguageStorageKey
  );
  if (isStoryboardLanguage(storedLanguage)) {
    return storedLanguage;
  }

  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
};

const readStoredTheme = (): StoryboardThemeMode => {
  if (typeof window === "undefined") {
    return "light";
  }

  const storedTheme = window.localStorage.getItem(storyboardThemeStorageKey);
  if (isStoryboardThemeMode(storedTheme)) {
    return storedTheme;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
};

const sectionCopy: Record<
  StoryboardLanguage,
  Record<string, { label: string; summary: string }>
> = {
  zh: {
    overview: { label: "总览", summary: overviewContent.description },
    colors: { label: "颜色", summary: colorsContent.description },
    typography: { label: "字体", summary: typographyContent.description },
    metrics: { label: "度量", summary: metricsContent.description },
    badge: { label: "Badge", summary: "状态标签与紧凑元信息" },
    button: { label: "Button", summary: "按钮层级、尺寸与状态" },
    checkbox: { label: "Checkbox", summary: "多选项、文件选择与布尔配置" },
    combobox: { label: "Combobox", summary: "可搜索选项选择与自定义值输入" },
    dialog: { label: "Dialog", summary: "弹层、确认与焦点流程" },
    drawer: { label: "Drawer", summary: "边缘抽屉与 sheet 面板" },
    icons: { label: "Icons", summary: "系统图标与品牌图标" },
    input: { label: "Input", summary: "文本输入、状态与表单行" },
    "mention-pill": {
      label: "Mention Pill",
      summary: "富文本字段中的 issue、session、file 引用 token"
    },
    popover: { label: "Popover", summary: "锚定浮层与轻量设置面板" },
    "radio-indicator": {
      label: "RadioIndicator",
      summary: "单选项的圆环选中态表达"
    },
    "resizable-panel-group": {
      label: "Resizable Panel Group",
      summary: "可拖拽 split pane 布局 primitive"
    },
    select: { label: "Select", summary: "选项选择、分组与筛选" },
    "shortcut-badge": {
      label: "Shortcut Badge",
      summary: "快捷键提示与 tooltip 辅助标识"
    },
    spinner: { label: "Spinner", summary: "加载、提交与长任务等待指示器" },
    "status-dot": { label: "Status Dot", summary: "紧凑状态标识与在线指示" },
    switch: { label: "Switch", summary: "即时开关型布尔配置" },
    textarea: { label: "Textarea", summary: "多行输入与说明字段" },
    sonner: { label: "Sonner", summary: "右上角通知与可操作提示" },
    toast: { label: "Toast", summary: "瞬时反馈与通知堆叠" },
    tooltip: { label: "Tooltip", summary: "悬浮提示与紧凑说明" },
    "underline-tabs": {
      label: "Underline Tabs",
      summary: "滚动 tab 行与二级导航"
    },
    "menu-surface": { label: "Menu Surface", summary: "基础菜单与浮层容器" },
    "viewport-menu-surface": {
      label: "Viewport Menu Surface",
      summary: "视口边界感知的浮层容器"
    }
  },
  en: {
    overview: {
      label: "Overview",
      summary:
        "Design goals, operating principles, and the storyboard contract."
    },
    colors: {
      label: "Colors",
      summary:
        "Semantic tokens for product surfaces, text, borders, and states."
    },
    typography: {
      label: "Typography",
      summary:
        "Font stacks, type scale, mixed-language rules, and readable weights."
    },
    metrics: {
      label: "Metrics",
      summary: "Spacing, radius, and motion values used across shared UI."
    },
    badge: { label: "Badge", summary: "Status labels and compact metadata." },
    button: {
      label: "Button",
      summary: "Button hierarchy, sizing, and states."
    },
    checkbox: {
      label: "Checkbox",
      summary: "Multi-select choices, file selection, and boolean settings."
    },
    combobox: {
      label: "Combobox",
      summary: "Searchable option selection with custom typed values."
    },
    dialog: {
      label: "Dialog",
      summary: "Modal surfaces, confirmation, and focus flow."
    },
    drawer: {
      label: "Drawer",
      summary: "Edge-attached drawers and sheet panels."
    },
    icons: { label: "Icons", summary: "System and brand icon inventory." },
    input: {
      label: "Input",
      summary: "Text input, form rows, and validation states."
    },
    "mention-pill": {
      label: "Mention Pill",
      summary: "Rich-text issue, session, and file reference tokens."
    },
    popover: {
      label: "Popover",
      summary: "Anchored overlays and lightweight panels."
    },
    "radio-indicator": {
      label: "RadioIndicator",
      summary: "Circular selected-state expression for single-choice options."
    },
    "resizable-panel-group": {
      label: "Resizable Panel Group",
      summary: "Draggable split-pane layout primitive."
    },
    select: {
      label: "Select",
      summary: "Choice selection, grouping, and filtering."
    },
    "shortcut-badge": {
      label: "Shortcut Badge",
      summary: "Keyboard shortcut hints and tooltip helper labels."
    },
    spinner: {
      label: "Spinner",
      summary: "Loading, submission, and long-running task indicators."
    },
    "status-dot": {
      label: "Status Dot",
      summary: "Compact status and presence indicators."
    },
    switch: { label: "Switch", summary: "Immediate boolean settings." },
    textarea: {
      label: "Textarea",
      summary: "Multi-line input and supporting fields."
    },
    sonner: {
      label: "Sonner",
      summary: "Top-right notifications and actionable prompts."
    },
    toast: {
      label: "Toast",
      summary: "Transient feedback and notification stacks."
    },
    tooltip: {
      label: "Tooltip",
      summary: "Hover help and compact explanations."
    },
    "underline-tabs": {
      label: "Underline Tabs",
      summary: "Scrollable tab rows and secondary navigation."
    },
    "menu-surface": {
      label: "Menu Surface",
      summary: "Base menu and floating surface container."
    },
    "viewport-menu-surface": {
      label: "Viewport Menu Surface",
      summary: "Viewport-aware floating surface container."
    }
  }
};

const storyboardCopy = {
  zh: {
    ariaNavigation: "UI storyboard 分区",
    foundationGroup: "基础规范",
    baseGroup: "基础组件",
    businessGroup: "业务组件",
    controlsLabel: "Storyboard 设置",
    languageLabel: "语言",
    themeLabel: "主题",
    chinese: "中",
    english: "EN",
    light: "亮",
    dark: "暗",
    title: "Tutti UI Storyboard",
    subtitle: "用于校准 UI system 的组件、设计 token 与跨语言呈现。",
    baseLayerTitle: "基础组件",
    baseLayerDescription:
      "基础组件层提供无业务语义的视觉 primitive、图标、样式入口和基础组合。",
    businessLayerTitle: "业务组件",
    businessLayerDescription:
      "业务组件层提供可跨端复用的 Tutti 业务展示组件，基于 base 组件组合。"
  },
  en: {
    ariaNavigation: "UI storyboard sections",
    foundationGroup: "Foundation",
    baseGroup: "Base Components",
    businessGroup: "Business Components",
    controlsLabel: "Storyboard settings",
    languageLabel: "Language",
    themeLabel: "Theme",
    chinese: "中",
    english: "EN",
    light: "Light",
    dark: "Dark",
    title: "Tutti UI Storyboard",
    subtitle:
      "A review surface for UI-system components, design tokens, and bilingual presentation.",
    baseLayerTitle: "Base Components",
    baseLayerDescription:
      "Base components provide business-agnostic primitives, icons, style entrypoints, and small compositions.",
    businessLayerTitle: "Business Components",
    businessLayerDescription:
      "Business components provide reusable Tutti product surfaces built from base components."
  }
} as const;

const navigationGroupLabel = (
  groupId: string,
  language: StoryboardLanguage
) => {
  const copy = storyboardCopy[language];
  if (groupId === "foundation") {
    return copy.foundationGroup;
  }
  if (groupId === "base") {
    return copy.baseGroup;
  }
  return copy.businessGroup;
};

const localizedSection = (
  section: (typeof sections)[number],
  language: StoryboardLanguage
) => ({
  ...section,
  ...(sectionCopy[language][section.id] ?? {})
});

const standardButtonBase =
  "border-0 !shadow-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background-1)] active:translate-y-0 disabled:!text-[var(--text-disabled)] disabled:!opacity-100";
const standardDisabledSurfaceClass = "disabled:!bg-[var(--transparency-block)]";
const standardPrimaryButtonClass = `${standardButtonBase} ${standardDisabledSurfaceClass} h-8 rounded-[6px] bg-[var(--text-primary)] px-3 text-[13px] font-normal text-[var(--text-inverted)] hover:bg-[var(--text-primary-hover)]`;
const standardSecondaryButtonClass = `${standardButtonBase} ${standardDisabledSurfaceClass} h-8 rounded-[6px] bg-[var(--transparency-block)] px-3 text-[13px] font-normal text-[var(--text-primary)] hover:bg-[var(--transparency-hover)]`;
const standardGhostButtonClass = `${standardButtonBase} h-8 rounded-[6px] bg-transparent px-3 text-[13px] font-normal text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] disabled:!bg-transparent`;
const standardDestructiveButtonClass = `${standardButtonBase} ${standardDisabledSurfaceClass} h-8 rounded-[6px] !bg-[var(--state-danger)] px-3 text-[13px] font-normal !text-[var(--white-stationary)] hover:!bg-[var(--state-danger-hover)]`;
const standardDestructiveSecondaryButtonClass = `${standardButtonBase} ${standardDisabledSurfaceClass} h-8 rounded-[6px] bg-[var(--on-danger)] px-3 text-[13px] font-normal text-[var(--state-danger)] hover:bg-[var(--on-danger-hover)]`;
const standardDestructiveGhostButtonClass = `${standardButtonBase} h-8 rounded-[6px] bg-transparent px-3 text-[13px] font-normal !text-[var(--state-danger)] hover:!bg-[var(--on-danger)] hover:!text-[var(--state-danger-hover)] disabled:!bg-transparent`;
const standardBadgeBase =
  "h-5 rounded-[4px] border-0 px-2 py-0 text-[11px] font-normal shadow-none transition-colors duration-200";
const standardBadgeDefaultClass = `${standardBadgeBase} bg-[var(--transparency-block)] text-[var(--text-primary)]`;
const standardBadgeSecondaryClass = `${standardBadgeBase} bg-[var(--transparency-block)] text-[var(--text-secondary)]`;
const standardBadgeDestructiveClass = `${standardBadgeBase} bg-[var(--on-danger)] text-[var(--state-danger)]`;
const standardFieldLabelClass =
  "text-[11px] font-normal leading-5 text-[var(--text-secondary)]";
const standardInputClass =
  "h-8 rounded-[6px] border border-transparent bg-[var(--transparency-block)] px-3 text-[13px] font-normal text-[var(--text-primary)] !shadow-none !outline-none !ring-0 transition-colors duration-200 placeholder:text-[var(--text-placeholder)] hover:bg-[var(--transparency-hover)] focus:bg-[var(--transparency-hover)] focus-visible:border-transparent focus-visible:bg-[var(--transparency-hover)] focus-visible:!ring-0 disabled:!bg-[var(--transparency-block)] disabled:!text-[var(--text-disabled)] disabled:!opacity-100 aria-invalid:border-[var(--state-danger)] aria-invalid:bg-[var(--transparency-block)] aria-invalid:hover:bg-[var(--transparency-hover)] aria-invalid:focus:bg-[var(--transparency-hover)] aria-invalid:focus-visible:bg-[var(--transparency-hover)] aria-invalid:!shadow-none aria-invalid:!ring-0";
const standardRuleTableFrameClass =
  "overflow-hidden border border-[var(--border-1)]";
const standardRuleTableHeaderRowClass =
  "border-b border-[var(--border-1)] text-[10px] font-semibold uppercase tracking-normal text-[var(--text-tertiary)]";
const standardRuleTableBodyClass =
  "text-[11px] leading-5 text-[var(--text-secondary)]";
const standardRuleTableDividerClass = "border-b border-[var(--border-1)]";
const standardRuleStrongClass = "font-semibold text-[var(--text-primary)]";
const standardRuleSeparatorClass = "mx-1 text-[var(--text-tertiary)]";
const standardSelectTriggerClass =
  "h-8 rounded-[6px] border-0 bg-[var(--transparency-block)] px-3 text-[13px] font-normal text-[var(--text-primary)] !shadow-none !outline-none !ring-0 transition-colors duration-200 hover:bg-[var(--transparency-hover)] focus-visible:border-0 focus-visible:!ring-0 data-[size=sm]:h-7 data-[size=sm]:rounded-[4px] data-[size=sm]:px-2 data-[size=sm]:text-[11px]";
const standardSelectContentClass =
  "w-[240px] rounded-[8px] border border-[var(--border-1)] bg-[var(--background-fronted)] text-[var(--text-primary)] shadow-[0_16px_40px_var(--shadow-elevated)] !outline-none !ring-0";
const standardSelectGroupClass = "p-0";
const standardSelectLabelClass =
  "px-2 py-1 text-[11px] font-normal !text-[var(--text-secondary)]";
const standardSelectItemClass =
  "flex h-7 items-center rounded-[4px] px-2 py-0 pr-8 text-[13px] !text-[var(--text-primary)] transition-colors duration-200 hover:bg-[var(--transparency-block)] focus:bg-[var(--transparency-block)] focus:!text-[var(--text-primary)] data-[highlighted]:bg-[var(--transparency-block)] data-[highlighted]:!text-[var(--text-primary)] data-[state=checked]:bg-transparent data-[state=checked]:!text-[var(--text-primary)] data-[state=checked]:hover:bg-[var(--transparency-block)] data-[state=checked]:focus:bg-[var(--transparency-block)] data-[state=checked][data-highlighted]:bg-[var(--transparency-block)]";
const standardSelectMenuClass = `${standardSelectContentClass} flex w-[240px] flex-col gap-0.5 p-1`;
const standardSelectMenuLabelClass =
  "px-2 py-1 text-[11px] font-normal text-[var(--text-secondary)]";
const standardSelectMenuItemClass =
  "flex h-7 items-center gap-2 rounded-[4px] px-2 text-[13px] font-normal text-[var(--text-primary)] transition-colors duration-200 hover:bg-[var(--transparency-block)]";
const standardSelectMenuItemActiveClass = "text-[var(--text-primary)]";
const standardSelectMenuSeparatorClass =
  "mx-2 my-0.5 h-px bg-[var(--border-2)]";
const standardSelectSplitMenuClass = `${standardSelectContentClass} w-[480px] min-h-[260px] p-1`;
const standardSelectSplitItemClass =
  "flex min-h-7 w-full items-center justify-between gap-2 rounded-[4px] border-0 bg-transparent px-2 py-1 text-left text-[13px] text-[var(--text-primary)] transition-colors duration-200 hover:bg-[var(--transparency-block)]";
const standardSelectSplitItemBodyClass = "flex min-w-0 flex-1 flex-col gap-0.5";
const standardSelectSplitItemTitleClass =
  "flex min-w-0 items-center font-normal leading-[1.2]";
const standardSelectSplitItemDescriptionClass =
  "m-0 whitespace-normal text-[11px] leading-[1.3] text-[var(--text-secondary)]";
const standardPopoverTitleClass =
  "text-[13px] font-semibold text-[var(--text-primary)]";
const standardPopoverDescriptionClass =
  "text-[11px] leading-[1.3] text-[var(--text-tertiary)]";
const standardPopoverLabelClass =
  "inline-flex items-center gap-2 text-[13px] text-[var(--text-primary)]";
const standardMenuSurfaceItemClass =
  "flex h-8 w-full items-center rounded-[6px] px-2 text-left text-[13px] transition-colors duration-200";
const standardOverlayContentClass =
  "max-w-[360px] rounded-[16px] border border-[var(--border-1)] bg-[var(--background-fronted)] p-[18px] text-[var(--text-primary)] shadow-[0_16px_40px_var(--shadow-elevated)] ring-0";
const standardOverlayClass = "bg-[var(--backdrop-dark)] backdrop-blur-sm";
const standardDialogTitleClass =
  "text-[15px] font-semibold text-[var(--text-primary)]";
const standardDialogDescriptionClass =
  "text-[13px] font-[400] leading-[1.3] text-[var(--text-secondary)]";
const standardDialogFooterClass = "gap-2.5 pt-1";
const standardToastClass =
  "mx-auto w-fit border border-[var(--toast-neutral-border)] bg-[var(--toast-neutral-bg)] text-[var(--toast-neutral-fg)]";
const standardToastDestructiveClass =
  "mx-auto w-fit border-0 bg-[var(--state-danger)] text-[var(--white-stationary)]";
const standardToastSuccessClass =
  "mx-auto w-fit border-0 bg-[var(--state-success)] text-[var(--text-inverted)]";
const standardSurfacePanelClass =
  "rounded-[12px] border border-[rgba(0,0,0,0.08)] bg-[rgb(255,255,255)] shadow-none";

const mentionPillVisuals: Record<
  MentionPillKind,
  {
    label: string;
    token: string;
    colorToken: string;
  }
> = {
  app: {
    label: "App",
    token: "data-agent-mention-kind='app'",
    colorToken: "--rich-text-mention-app"
  },
  issue: {
    label: "Issue",
    token: "data-agent-mention-kind='task'",
    colorToken: "--rich-text-mention-issue"
  },
  session: {
    label: "Session",
    token: "data-agent-mention-kind='session'",
    colorToken: "--rich-text-mention-session"
  },
  file: {
    label: "File",
    token: "data-agent-mention-kind='file'",
    colorToken: "--rich-text-mention-file"
  }
};

const spinnerSizeSpecs = [
  { label: "xs", size: 12, usage: "badge、inline metadata" },
  { label: "sm", size: 16, usage: "按钮、toast、行内等待" },
  { label: "md", size: 20, usage: "列表行、卡片局部加载" },
  { label: "lg", size: 28, usage: "面板级加载状态" }
];

const buttonSizeSpecs = [
  {
    label: "mini",
    usage: "极紧凑计数 / 标签旁",
    className: "h-6 rounded-[4px] px-2 text-[11px] leading-tight",
    gapClass: "gap-1",
    gapMeta: "4px",
    iconClass: "size-3",
    meta: "24px high · 11px text · 8px padding · 12px icon · radius 4px"
  },
  {
    label: "sm",
    usage: "紧凑工具栏",
    className: "h-7 rounded-[4px] px-2 text-[11px]",
    gapClass: "gap-1",
    gapMeta: "4px",
    iconClass: "size-4",
    meta: "28px high · 11px text · 8px padding · 16px icon · radius 4px"
  },
  {
    label: "default / md",
    usage: "主界面常规按钮",
    className: "h-8 rounded-[6px] px-3 text-[13px]",
    gapClass: "gap-[6px]",
    gapMeta: "6px",
    iconClass: "size-4",
    meta: "32px high · 13px text · 12px padding · 16px icon · radius 6px"
  },
  {
    label: "dialog",
    usage: "Modal / 弹窗底栏",
    className: "h-8 rounded-[6px] px-3 text-[13px] leading-5",
    gapClass: "gap-[6px]",
    gapMeta: "6px",
    iconClass: "size-4",
    meta: "32px high · 13px text · 12px padding · 16px icon · radius 6px · 20px line-height"
  },
  {
    label: "lg",
    usage: "少数强调 CTA",
    className: "h-10 rounded-[8px] px-5 text-[13px]",
    gapClass: "gap-2",
    gapMeta: "8px",
    iconClass: "size-4",
    meta: "40px high · 13px text · 20px padding · 16px icon · radius 8px"
  }
];

const SCROLL_OFFSET = 120;

function useActiveSection(sectionIds: readonly string[]) {
  const [activeId, setActiveId] = useState(sectionIds[0]);
  const isClickScrolling = useRef(false);
  const clickTimerRef = useRef(0);

  useEffect(() => {
    const onScroll = () => {
      if (isClickScrolling.current) {
        return;
      }

      let current = sectionIds[0];
      for (const id of sectionIds) {
        const element = document.getElementById(id);
        if (element && element.getBoundingClientRect().top <= SCROLL_OFFSET) {
          current = id;
        }
      }
      setActiveId(current);
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [sectionIds]);

  const navigateTo = useCallback((id: string) => {
    isClickScrolling.current = true;
    setActiveId(id);
    window.clearTimeout(clickTimerRef.current);

    let settledTicks = 0;
    let lastScrollY = window.scrollY;
    const checkSettled = () => {
      if (window.scrollY === lastScrollY) {
        settledTicks += 1;
      } else {
        settledTicks = 0;
        lastScrollY = window.scrollY;
      }

      if (settledTicks >= 3) {
        isClickScrolling.current = false;
      } else {
        clickTimerRef.current = window.setTimeout(checkSettled, 60);
      }
    };

    clickTimerRef.current = window.setTimeout(checkSettled, 60);
  }, []);

  return { activeId, navigateTo };
}

function DocsSection({
  id,
  title,
  description,
  componentId,
  children
}: {
  id: string;
  title: string;
  description: string;
  componentId?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 space-y-6">
      <div className="pb-4">
        <div className="flex flex-wrap items-end gap-3">
          <h2 className="text-[32px] font-bold leading-[1.1] tracking-normal text-[var(--storyboard-ink)]">
            {title}
          </h2>
          {componentId ? <ComponentIdBadge id={componentId} /> : null}
        </div>
        <p className="mt-3 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
          {description}
        </p>
      </div>
      {children}
    </section>
  );
}

function StoryLayerHeading({
  title,
  description
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="border-t border-[var(--border-1)] pt-8">
      <p className="text-[11px] font-bold uppercase tracking-normal text-[var(--text-tertiary)]">
        {title}
      </p>
      <p className="mt-2 max-w-2xl text-[13px] leading-[1.3] text-[var(--text-secondary)]">
        {description}
      </p>
    </div>
  );
}

async function copyToClipboard(value: string) {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall back below when browser permissions block clipboard.writeText.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function ComponentIdBadge({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
    void copyToClipboard(id)
      .catch(() => undefined)
      .then(() => undefined);
  }, [id]);

  return (
    <div className="flex h-8 min-w-0 items-center gap-1.5 border border-[var(--border-1)] bg-[var(--background-fronted)] px-2.5 text-[11px] text-[var(--text-secondary)]">
      <span className="shrink-0 font-medium uppercase tracking-normal text-[var(--text-tertiary)]">
        ID
      </span>
      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text-primary)]">
        {id}
      </code>
      <button
        type="button"
        className="ml-1 inline-flex size-5 shrink-0 items-center justify-center rounded-[4px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
        aria-label={`Copy component id ${id}`}
        title={copied ? "Copied" : "Copy ID"}
        onClick={handleCopy}
      >
        {copied ? (
          <CheckIcon className="size-3.5" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
      </button>
    </div>
  );
}

function StoryboardControls({
  language,
  themeMode,
  onLanguageChange,
  onThemeChange
}: {
  language: StoryboardLanguage;
  themeMode: StoryboardThemeMode;
  onLanguageChange: (language: StoryboardLanguage) => void;
  onThemeChange: (themeMode: StoryboardThemeMode) => void;
}) {
  const copy = storyboardCopy[language];
  const languageOptions: Array<{ value: StoryboardLanguage; label: string }> = [
    { value: "zh", label: copy.chinese },
    { value: "en", label: copy.english }
  ];
  const themeOptions: Array<{
    value: StoryboardThemeMode;
    label: string;
    Icon: ComponentType<{ className?: string }>;
  }> = [
    { value: "light", label: copy.light, Icon: LightModeIcon },
    { value: "dark", label: copy.dark, Icon: DarkModeIcon }
  ];

  return (
    <div
      className="flex flex-wrap items-center gap-3"
      aria-label={copy.controlsLabel}
    >
      <div className="flex h-9 items-center gap-1 border border-[var(--border-1)] bg-[var(--background-fronted)] p-1">
        {languageOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`h-7 min-w-9 px-2 text-[11px] font-medium transition-colors ${
              language === option.value
                ? "bg-[var(--text-primary)] text-[var(--text-inverted)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)]"
            }`}
            aria-pressed={language === option.value}
            onClick={() => onLanguageChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="flex h-9 items-center gap-1 border border-[var(--border-1)] bg-[var(--background-fronted)] p-1">
        {themeOptions.map(({ value, label, Icon }) => (
          <button
            key={value}
            type="button"
            className={`inline-flex h-7 min-w-9 items-center justify-center gap-1.5 px-2 text-[11px] font-medium transition-colors ${
              themeMode === value
                ? "bg-[var(--text-primary)] text-[var(--text-inverted)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)]"
            }`}
            aria-label={`${copy.themeLabel}: ${label}`}
            aria-pressed={themeMode === value}
            title={label}
            onClick={() => onThemeChange(value)}
          >
            <Icon className="size-3.5" />
            <span>{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ExampleCard({
  title,
  description,
  children
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="border border-[var(--border-1)] bg-[var(--background-fronted)] p-5">
      <div className="mb-4 space-y-1">
        <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
          {title}
        </h3>
        <p className="text-[11px] leading-[1.3] text-[var(--text-secondary)]">
          {description}
        </p>
      </div>
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mb-3 text-[10px] font-medium uppercase tracking-normal text-[var(--text-tertiary)]">
      {children}
    </p>
  );
}

function ColorBlock({
  label,
  usage,
  dark,
  light
}: {
  label: string;
  usage: string;
  dark: string;
  light: string;
}) {
  const forceWhiteSwatchText = label.startsWith("--state-");
  const darkTextColor = forceWhiteSwatchText
    ? "rgb(255, 255, 255)"
    : readableSwatchTextColor(dark);
  const lightTextColor = forceWhiteSwatchText
    ? "rgb(255, 255, 255)"
    : readableSwatchTextColor(light);

  return (
    <div className="border border-[#1a1a1a]/10 bg-white p-3">
      <div className="flex gap-1.5">
        <div
          className="flex h-16 flex-1 items-end border border-[#1a1a1a]/5 p-1.5"
          style={{ background: dark }}
          title={dark}
        >
          <span
            className="font-mono text-[9px] leading-3"
            style={{ color: darkTextColor }}
          >
            {dark}
          </span>
        </div>
        <div
          className="flex h-16 flex-1 items-end border border-[#1a1a1a]/5 p-1.5"
          style={{ background: light }}
          title={light}
        >
          <span
            className="font-mono text-[9px] leading-3"
            style={{ color: lightTextColor }}
          >
            {light}
          </span>
        </div>
      </div>
      <div className="mt-2 space-y-1">
        <p className="font-mono text-[11px] text-[#1a1a1a]">{label}</p>
        <p className="text-[11px] leading-4 text-[#1a1a1a]/45">{usage}</p>
      </div>
    </div>
  );
}

function readableSwatchTextColor(color: string) {
  const match = color.match(
    /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/
  );

  if (!match) {
    return "rgb(0, 0, 0)";
  }

  const red = match[1] ?? "0";
  const green = match[2] ?? "0";
  const blue = match[3] ?? "0";
  const alpha = match[4] ?? "1";
  const opacity = Number(alpha);
  const resolveChannel = (channel: string) =>
    Math.round(Number(channel) * opacity + 255 * (1 - opacity));
  const resolvedRed = resolveChannel(red);
  const resolvedGreen = resolveChannel(green);
  const resolvedBlue = resolveChannel(blue);
  const luminance =
    (0.2126 * resolvedRed + 0.7152 * resolvedGreen + 0.0722 * resolvedBlue) /
    255;

  return luminance > 0.56 ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)";
}

function OverviewSection({ language }: { language: StoryboardLanguage }) {
  const copy = sectionCopy[language].overview!;

  return (
    <DocsSection
      id={overviewContent.id}
      title={copy.label}
      description={copy.summary}
    >
      <div className="grid gap-1">
        {overviewContent.cards.map((card) => (
          <div key={card.title} className="bg-[var(--background-fronted)] p-5">
            <SectionLabel>{card.title}</SectionLabel>
            <div className="space-y-3">
              {card.items.map((item) => (
                <div key={item.keyword} className="flex items-baseline gap-3">
                  <span className="shrink-0 text-[13px] font-semibold tracking-normal text-[var(--text-primary)]">
                    {item.keyword}
                  </span>
                  <span className="text-[11px] leading-5 text-[var(--text-secondary)]">
                    {item.desc}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </DocsSection>
  );
}

function ColorsSection({ language }: { language: StoryboardLanguage }) {
  const copy = sectionCopy[language].colors!;

  return (
    <DocsSection
      id={colorsContent.id}
      title={copy.label}
      description={copy.summary}
    >
      <div className="grid gap-1">
        {colorsContent.groups.map((group) => (
          <ExampleCard
            key={group.title}
            title={group.title}
            description={group.description}
          >
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {group.tokens.map((token) => (
                <ColorBlock
                  key={token.label}
                  label={token.label}
                  usage={token.usage}
                  dark={token.dark}
                  light={token.light}
                />
              ))}
            </div>
          </ExampleCard>
        ))}
      </div>
    </DocsSection>
  );
}

function TypographySection({ language }: { language: StoryboardLanguage }) {
  const copy = sectionCopy[language].typography!;

  return (
    <DocsSection
      id={typographyContent.id}
      title={copy.label}
      description={copy.summary}
    >
      <div className="grid gap-1">
        <ExampleCard
          title={typographyContent.characterRoles.title}
          description={typographyContent.characterRoles.description}
        >
          <div className="grid gap-3">
            {typographyContent.characterRoles.rows.map((font) => (
              <div
                key={font.label}
                className="grid gap-3 border border-[#1a1a1a]/10 bg-white p-3 lg:grid-cols-[180px_1fr_1fr]"
              >
                <p className="text-[11px] font-semibold text-[#1a1a1a]">
                  {font.label}
                </p>
                <code className="font-[var(--font-mono)] text-[11px] leading-5 text-[#1a1a1a]/55">
                  {font.stack}
                </code>
                <p className="text-[11px] leading-5 text-[#1a1a1a]/45">
                  {font.note}
                </p>
              </div>
            ))}
          </div>
        </ExampleCard>

        <ExampleCard
          title={typographyContent.cssTokens.title}
          description={typographyContent.cssTokens.description}
        >
          <div className="grid gap-3">
            {typographyContent.cssTokens.rows.map((font) => (
              <div
                key={font.label}
                className="grid gap-3 border border-[#1a1a1a]/10 bg-white p-3 lg:grid-cols-[140px_1fr]"
              >
                <div>
                  <p className="font-mono text-[11px] text-[#1a1a1a]">
                    {font.label}
                  </p>
                  <p className="mt-1 text-[11px] leading-5 text-[#1a1a1a]/45">
                    {font.sample}
                  </p>
                </div>
                <code className="font-[var(--font-mono)] text-[11px] leading-5 text-[#1a1a1a]/55">
                  {font.value}
                </code>
              </div>
            ))}
          </div>
        </ExampleCard>

        <ExampleCard
          title={typographyContent.weightRules.title}
          description={typographyContent.weightRules.description}
        >
          <div className="grid gap-3 lg:grid-cols-2">
            {typographyContent.weightRules.items.map((weight) => (
              <div
                key={weight.label}
                className="border border-[#1a1a1a]/10 bg-white p-3"
                lang={weight.label.includes("中文") ? "zh-CN" : undefined}
              >
                <p className={`${weight.className} text-[#1a1a1a]`}>
                  {weight.label}
                </p>
                <p className="mt-2 text-[11px] leading-5 text-[#1a1a1a]/45">
                  {weight.sample}
                </p>
              </div>
            ))}
          </div>
        </ExampleCard>

        <ExampleCard
          title={typographyContent.typeScale.title}
          description={typographyContent.typeScale.description}
        >
          <div className="divide-y divide-[#1a1a1a]/10">
            {typographyContent.typeScale.items.map((type) => (
              <div
                key={type.name}
                className="grid gap-4 py-5 lg:grid-cols-[150px_minmax(130px,1fr)_minmax(130px,1fr)_1.3fr] lg:items-center"
              >
                <div>
                  <p className="text-[13px] font-semibold text-[#1a1a1a]">
                    {type.name}
                  </p>
                  <p className="mt-1 text-[11px] text-[#1a1a1a]/40">
                    {type.meta}
                  </p>
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="text-[10px] font-semibold uppercase tracking-normal text-[#1a1a1a]/30">
                    English
                  </p>
                  <p
                    className={`${type.className} truncate text-[#1a1a1a]`}
                    style={{
                      fontFamily: type.className.includes(
                        "font-[var(--font-mono)]"
                      )
                        ? storyboardFontMono
                        : storyboardFontEnglish
                    }}
                  >
                    {type.english}
                  </p>
                  <p className="text-[10px] text-[#1a1a1a]/25">
                    {type.className.includes("font-[var(--font-mono)]")
                      ? "--font-mono"
                      : "Lexend / --font-ui"}
                  </p>
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="text-[10px] font-semibold uppercase tracking-normal text-[#1a1a1a]/30">
                    中文
                  </p>
                  <p
                    className={`${type.className} text-[#1a1a1a]`}
                    lang="zh-CN"
                    style={{
                      fontFamily: type.className.includes(
                        "font-[var(--font-mono)]"
                      )
                        ? storyboardFontMono
                        : storyboardFontCjk
                    }}
                  >
                    {type.chinese}
                  </p>
                  <p className="text-[10px] text-[#1a1a1a]/25">
                    {type.className.includes("font-[var(--font-mono)]")
                      ? "--font-mono"
                      : "CJK fallback"}
                  </p>
                </div>
                <div
                  className={`${type.className} text-[#1a1a1a]/55`}
                  lang="zh-CN"
                >
                  {type.sample}
                </div>
              </div>
            ))}
          </div>
        </ExampleCard>

        <ExampleCard
          title={typographyContent.rules.title}
          description={typographyContent.rules.description}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {typographyContent.rules.items.map((rule) => (
              <div
                key={rule}
                className="border border-[#1a1a1a]/10 bg-white px-3 py-2 text-[11px] leading-5 text-[#1a1a1a]/55"
              >
                {rule}
              </div>
            ))}
          </div>
        </ExampleCard>
      </div>
    </DocsSection>
  );
}

function MetricsSection({ language }: { language: StoryboardLanguage }) {
  const copy = sectionCopy[language].metrics!;

  return (
    <DocsSection
      id={metricsContent.id}
      title={copy.label}
      description={copy.summary}
    >
      <div className="grid gap-1 lg:grid-cols-2">
        <ExampleCard
          title={metricsContent.spacing.title}
          description={metricsContent.spacing.description}
        >
          <div className="space-y-3">
            {metricsContent.spacing.tokens.map((space) => (
              <div
                key={space}
                className="grid grid-cols-[42px_1fr] items-center gap-3"
              >
                <span className="font-mono text-[11px] text-[var(--text-tertiary)]">
                  {space}px
                </span>
                <div
                  className="h-4 bg-[var(--transparency-hover)]"
                  style={{ width: `${space}px` }}
                />
              </div>
            ))}
          </div>
        </ExampleCard>
        <ExampleCard
          title={metricsContent.radius.title}
          description={metricsContent.radius.description}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {metricsContent.radius.tokens.map((radius) => (
              <div
                key={radius.label}
                className="border border-[var(--border-1)] bg-[var(--background-fronted)] p-3"
              >
                <div
                  className="h-12 border border-[var(--border-1)] bg-[var(--transparency-block)]"
                  style={{ borderRadius: radius.value }}
                />
                <p className="mt-2 font-mono text-[11px] text-[var(--text-primary)]">
                  {radius.label} · {radius.value}
                </p>
                <p className="mt-1 text-[11px] leading-4 text-[var(--text-tertiary)]">
                  {radius.usage}
                </p>
              </div>
            ))}
          </div>
        </ExampleCard>
        <ExampleCard
          title={metricsContent.motion.title}
          description={metricsContent.motion.description}
        >
          <div className="grid gap-2">
            {metricsContent.motion.tokens.map((motion) => (
              <div
                key={motion.label}
                className="flex items-center justify-between border border-[var(--border-1)] bg-[var(--background-fronted)] px-3 py-2"
              >
                <span className="text-[11px] font-semibold text-[var(--text-primary)]">
                  {motion.label}
                </span>
                <code className="font-mono text-[11px] text-[var(--text-tertiary)]">
                  {motion.value}
                </code>
              </div>
            ))}
          </div>
        </ExampleCard>
      </div>
    </DocsSection>
  );
}

function BadgeStoryboard() {
  if (!hasStoryboard("Badge")) {
    return null;
  }

  return (
    <DocsSection
      id="badge"
      title="Badge"
      description="用于状态、计数和紧凑元信息，优先表达语义而不是装饰"
      componentId={metadataFor("Badge")?.id}
    >
      <div className="grid gap-1">
        <ExampleCard title="Badge Variants" description="常用语义和弱层级标签">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={standardBadgeDefaultClass}>Default</Badge>
            <Badge variant="secondary" className={standardBadgeSecondaryClass}>
              Secondary
            </Badge>
            <Badge className={standardBadgeDestructiveClass}>Error</Badge>
          </div>
        </ExampleCard>
        <ExampleCard title="Badge Content" description="图标、计数和状态组合">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={`${standardBadgeDefaultClass} gap-1`}>
              <CheckIcon />
              Stable
            </Badge>
            <Badge
              variant="secondary"
              className={`${standardBadgeSecondaryClass} gap-1`}
            >
              <StorySpinner className="text-current" size={12} />
              Syncing
            </Badge>
            <Badge variant="secondary" className={standardBadgeSecondaryClass}>
              12 files
            </Badge>
            <Badge className={`${standardBadgeDestructiveClass} gap-1`}>
              <WarningLinedIcon />
              Failed
            </Badge>
          </div>
        </ExampleCard>
      </div>
    </DocsSection>
  );
}

function ShortcutBadgeStoryboard() {
  if (!hasStoryboard("ShortcutBadge")) {
    return null;
  }

  return (
    <DocsSection
      id="shortcut-badge"
      title="Shortcut Badge"
      description="用于 tooltip、菜单或紧凑操作旁的快捷键提示"
      componentId={metadataFor("ShortcutBadge")?.id}
    >
      <ExampleCard title="Shortcut Hints" description="单键、组合键和长快捷键">
        <div className="flex flex-wrap items-center gap-2">
          <ShortcutBadge>Enter</ShortcutBadge>
          <ShortcutBadge>Cmd + 1</ShortcutBadge>
          <ShortcutBadge>Ctrl + Shift + P</ShortcutBadge>
        </div>
      </ExampleCard>
    </DocsSection>
  );
}

function RichTextFieldPreview({ children }: { children: ReactNode }) {
  return (
    <div
      className="min-h-20 rounded-[8px] border border-transparent bg-[var(--transparency-block)] p-3 text-[13px] font-normal leading-[1.3] text-[var(--text-primary)] transition-[background-color,border-color,color]"
      data-rich-text-field-state="default"
    >
      {children}
    </div>
  );
}

function MentionPillStoryboard() {
  return (
    <DocsSection
      id="mention-pill"
      title="Mention Pill"
      description="富文本字段中的 issue、session、file 引用 token，默认透明，hover 使用 currentColor 低饱和底色"
      componentId={metadataFor("MentionPill")?.id}
    >
      <div className="grid gap-1">
        <ExampleCard
          title="Rich Text Mentions"
          description="任务中心富文本字段的默认表面"
        >
          <div className="grid gap-3">
            <RichTextFieldPreview>
              关联{" "}
              <MentionPill kind="issue" label="修复 room status 批量接口" />，
              继续跟进{" "}
              <MentionPill
                kind="session"
                label="Zoe & Codex"
                summary="UI storyboard 校准"
              />
              ，并更新{" "}
              <MentionPill kind="file" label="product-ui-standard.md" />。
            </RichTextFieldPreview>
          </div>
        </ExampleCard>
        <ExampleCard
          title="Token Mapping"
          description="对应任务中心富文本渲染结构与 hover 行为"
        >
          <div className="grid gap-3">
            {(Object.keys(mentionPillVisuals) as MentionPillKind[]).map(
              (kind) => {
                const visual = mentionPillVisuals[kind];
                return (
                  <div
                    key={kind}
                    className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 border border-[rgba(0,0,0,0.08)] bg-[rgb(255,255,255)] px-3 py-2"
                  >
                    <span className="min-w-0">
                      <MentionPill
                        kind={kind}
                        label={
                          kind === "issue"
                            ? "Issue title"
                            : kind === "session"
                              ? "Agent session"
                              : "README.md"
                        }
                      />
                    </span>
                    <div className="grid min-w-0 gap-1 text-right">
                      <code className="block min-w-0 truncate font-mono text-[11px] text-[rgba(43,43,43,0.50)]">
                        {visual.colorToken}
                      </code>
                      <code className="block min-w-0 truncate font-mono text-[11px] text-[rgba(43,43,43,0.35)]">
                        {visual.token}
                      </code>
                    </div>
                  </div>
                );
              }
            )}
          </div>
        </ExampleCard>
      </div>
    </DocsSection>
  );
}

function StorySpinner({
  size = 16,
  className = ""
}: {
  size?: number;
  className?: string;
}) {
  return <Spinner className={className} size={size} />;
}

function SpinnerStoryboard() {
  return (
    <DocsSection
      id="spinner"
      title="Spinner"
      description="LoadingIcon 旋转指示器，用于按钮、列表行与深色遮罩等 busy 状态"
      componentId={metadataFor("Spinner")?.id}
    >
      <div className="grid gap-1 lg:grid-cols-2">
        <ExampleCard title="Sizes" description="按容器密度选择尺寸">
          <div className="grid gap-3 sm:grid-cols-2">
            {spinnerSizeSpecs.map((spec) => (
              <div
                key={spec.label}
                className="flex items-center justify-between border border-[rgba(0,0,0,0.08)] bg-[rgb(255,255,255)] px-3 py-2"
              >
                <div>
                  <p className="text-[11px] font-semibold text-[rgb(0,0,0)]">
                    {spec.label}
                    <span className="ml-2 font-mono text-[11px] font-normal text-[rgba(43,43,43,0.50)]">
                      {spec.size}px
                    </span>
                  </p>
                  <p className="text-[11px] text-[rgba(43,43,43,0.50)]">
                    {spec.usage}
                  </p>
                </div>
                <StorySpinner
                  className="text-[var(--text-primary)]"
                  size={spec.size}
                />
              </div>
            ))}
          </div>
        </ExampleCard>
        <ExampleCard title="Context" description="按钮、列表行与深色遮罩">
          <div className="grid gap-3">
            <Button
              variant="secondary"
              className={`${standardSecondaryButtonClass} w-fit gap-2`}
            >
              <StorySpinner className="text-current" />
              Syncing
            </Button>
            <div className="flex items-center justify-between border border-[rgba(0,0,0,0.08)] bg-[rgba(43,43,43,0.04)] px-3 py-2">
              <span className="text-[13px] font-normal text-[rgba(43,43,43,0.70)]">
                Loading workspace files
              </span>
              <StorySpinner className="text-[var(--text-primary)]" />
            </div>
            <div className="flex items-center gap-3 bg-[rgba(0,0,0,0.72)] px-3 py-2 text-white">
              <StorySpinner className="text-white" />
              <span className="text-[11px] font-semibold">
                Restoring terminal
              </span>
            </div>
          </div>
        </ExampleCard>
      </div>
    </DocsSection>
  );
}

function StoryCheckbox({
  checked,
  disabled = false,
  label
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
}) {
  return (
    <label
      className={`inline-flex items-center gap-2 text-left text-[13px] font-normal ${
        disabled
          ? "cursor-not-allowed text-[var(--text-disabled)]"
          : "text-[var(--text-primary)]"
      }`}
    >
      <Checkbox checked={checked} disabled={disabled} />
      <span>{label}</span>
    </label>
  );
}

function CheckboxStoryboard() {
  const [includeIgnored, setIncludeIgnored] = useState(false);

  return (
    <DocsSection
      id="checkbox"
      title="Checkbox"
      description="16px 方形控件，checked 填充使用 --text-primary，disabled checked 使用 --text-disabled"
      componentId={metadataFor("Checkbox")?.id}
    >
      <div className="grid gap-1 lg:grid-cols-2">
        <ExampleCard title="States" description="未选、已选与禁用状态">
          <div className="grid gap-3">
            <StoryCheckbox checked={false} label="Unchecked" />
            <StoryCheckbox checked label="Checked" />
            <StoryCheckbox checked disabled label="Disabled checked" />
            <StoryCheckbox
              disabled
              checked={false}
              label="Disabled unchecked"
            />
          </div>
        </ExampleCard>
        <ExampleCard title="Usage" description="设置面板和文件选择场景">
          <div className="grid gap-3">
            <label className="inline-flex w-fit items-center gap-2 text-[13px] font-normal text-[var(--text-primary)]">
              <Checkbox
                checked={includeIgnored}
                onCheckedChange={(checked) =>
                  setIncludeIgnored(checked === true)
                }
              />
              <span>Include ignored files</span>
            </label>
            <div className="border border-[var(--border-1)] bg-[var(--background-fronted)]">
              {["README.md", "src/App.tsx", "package.json"].map(
                (file, index) => (
                  <div
                    key={file}
                    className="flex items-center gap-3 border-b border-[var(--border-1)] px-3 py-2 last:border-b-0"
                  >
                    <StoryCheckbox
                      checked={index === 0}
                      label={`Select ${file}`}
                    />
                    <span className="text-[11px] text-[var(--text-tertiary)]">
                      {file}
                    </span>
                  </div>
                )
              )}
            </div>
          </div>
        </ExampleCard>
      </div>
    </DocsSection>
  );
}

function RadioIndicatorStoryboard() {
  const [selected, setSelected] = useState("immersive");
  const options = [
    { id: "standalone", label: "独立 Agent 窗口模式" },
    { id: "immersive", label: "沉浸 OS 模式" }
  ];

  return (
    <DocsSection
      id="radio-indicator"
      title="RadioIndicator"
      description="16px 圆环单选态表达，选中时使用 tutti-purple 外环和中心圆点"
      componentId={metadataFor("RadioIndicator")?.id}
    >
      <div className="grid gap-1 lg:grid-cols-2">
        <ExampleCard title="States" description="未选、已选与禁用选中态">
          <div className="flex items-center gap-5">
            <RadioIndicator />
            <RadioIndicator checked />
            <RadioIndicator checked disabled />
          </div>
        </ExampleCard>
        <ExampleCard title="Usage" description="单选卡片右侧的选中态表达">
          <div className="grid gap-2">
            {options.map((option) => (
              <button
                key={option.id}
                type="button"
                className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--border-1)] px-3 py-2 text-left text-[13px] text-[var(--text-primary)] data-[selected=true]:border-[var(--border-focus)]"
                data-selected={selected === option.id}
                onClick={() => setSelected(option.id)}
              >
                <span>{option.label}</span>
                <RadioIndicator checked={selected === option.id} />
              </button>
            ))}
          </div>
        </ExampleCard>
      </div>
    </DocsSection>
  );
}

function StorySwitch({
  checked,
  disabled = false,
  loading = false,
  label,
  onCheckedChange
}: {
  checked: boolean;
  disabled?: boolean;
  loading?: boolean;
  label: string;
  onCheckedChange?: (checked: boolean) => void;
}) {
  return (
    <label
      className={`inline-flex items-center gap-3 text-left text-[13px] font-normal text-[rgb(0,0,0)] ${
        disabled || loading ? "cursor-not-allowed opacity-50" : ""
      }`}
    >
      <Switch
        checked={checked}
        disabled={disabled}
        loading={loading}
        onCheckedChange={onCheckedChange}
      />
      <span>{label}</span>
    </label>
  );
}

function SwitchStoryboard() {
  const [autoUpdate, setAutoUpdate] = useState(true);

  return (
    <DocsSection
      id="switch"
      title="Switch"
      description="44x24px 即时开关，checked 使用 accent，unchecked 使用 transparency block"
      componentId={metadataFor("Switch")?.id}
    >
      <div className="grid gap-1 lg:grid-cols-2">
        <ExampleCard title="States" description="开、关与禁用状态">
          <div className="grid gap-3">
            <StorySwitch checked label="Checked" />
            <StorySwitch checked={false} label="Unchecked" />
            <StorySwitch checked loading label="Loading" />
            <StorySwitch checked disabled label="Disabled checked" />
            <StorySwitch checked={false} disabled label="Disabled unchecked" />
          </div>
        </ExampleCard>
        <ExampleCard title="Usage" description="设置面板中的即时配置">
          <div className="grid gap-3">
            <div className="flex items-center justify-between border border-[var(--border-1)] bg-[var(--background-fronted)] px-3 py-2">
              <div>
                <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                  Auto update workspace index
                </p>
                <p className="text-[11px] text-[var(--text-tertiary)]">
                  Refresh references when files change
                </p>
              </div>
              <StorySwitch
                checked={autoUpdate}
                label="Auto update"
                onCheckedChange={setAutoUpdate}
              />
            </div>
          </div>
        </ExampleCard>
      </div>
    </DocsSection>
  );
}

function TooltipStoryboard() {
  if (!hasStoryboard("Tooltip")) {
    return null;
  }

  return (
    <DocsSection
      id="tooltip"
      title="Tooltip"
      description="短文本悬浮提示，适合 icon button、紧凑工具栏和快捷键说明"
      componentId={metadataFor("Tooltip")?.id}
    >
      <TooltipProvider delayDuration={120}>
        <div className="grid gap-1 lg:grid-cols-2">
          <ExampleCard
            title="Toolbar Hints"
            description="默认 top 提示与紧凑文案"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" className={standardGhostButtonClass}>
                    <EditIcon className="size-4 text-current" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Edit current note</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" className={standardGhostButtonClass}>
                    <RefreshIcon className="size-4 text-current" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Refresh references
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="secondary"
                    className={standardSecondaryButtonClass}
                  >
                    Push
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <span>Open command palette</span>
                  <span className="text-[var(--text-secondary)]">⌘⇧P</span>
                </TooltipContent>
              </Tooltip>
            </div>
          </ExampleCard>
          <ExampleCard
            title="Inline Guidance"
            description="表单字段上的轻量解释"
          >
            <div className="grid max-w-sm gap-2">
              <div className="flex items-center gap-2">
                <span className={standardFieldLabelClass}>Workspace token</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex size-5 items-center justify-center rounded-[4px] text-[rgba(43,43,43,0.45)] transition-colors hover:bg-[rgba(43,43,43,0.04)] hover:text-[rgb(0,0,0)]"
                    >
                      ?
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[220px]">
                    Used for local references, generated paths, and agent
                    routing.
                  </TooltipContent>
                </Tooltip>
              </div>
              <Input
                className={standardInputClass}
                defaultValue="workspace-ui"
              />
            </div>
          </ExampleCard>
        </div>
      </TooltipProvider>
    </DocsSection>
  );
}

function PopoverStoryboard() {
  if (!hasStoryboard("Popover")) {
    return null;
  }

  return (
    <DocsSection
      id="popover"
      title="Popover"
      description="锚定型轻量浮层，适合局部设置、筛选和上下文操作"
      componentId={metadataFor("Popover")?.id}
    >
      <div className="grid gap-1 lg:grid-cols-2">
        <ExampleCard
          title="Inline Controls"
          description="局部设置面板而不是重型 dialog"
        >
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="secondary"
                className={standardSecondaryButtonClass}
              >
                Workspace filters
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[280px]">
              <div className="grid gap-3">
                <div className="grid gap-2">
                  <p className={standardPopoverTitleClass}>Visible content</p>
                  <p className={standardPopoverDescriptionClass}>
                    Choose which resource groups stay visible on the board.
                  </p>
                </div>
                <div className="grid gap-2">
                  <label className={standardPopoverLabelClass}>
                    <Checkbox defaultChecked />
                    <span>Files</span>
                  </label>
                  <label className={standardPopoverLabelClass}>
                    <Checkbox defaultChecked />
                    <span>Agents</span>
                  </label>
                  <label className={standardPopoverLabelClass}>
                    <Checkbox />
                    <span>Archived sessions</span>
                  </label>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </ExampleCard>
        <ExampleCard
          title="Action Footer"
          description="内容区可直接承载局部动作"
        >
          <Popover>
            <PopoverTrigger asChild>
              <Button className={standardPrimaryButtonClass}>
                Open review panel
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[300px]">
              <div className="grid gap-3">
                <div className="grid gap-2">
                  <p className={standardPopoverTitleClass}>Ready to publish</p>
                  <p className={standardPopoverDescriptionClass}>
                    The workspace passed validation and is ready for release
                    handoff.
                  </p>
                </div>
                <div className="flex justify-end gap-2">
                  <PopoverClose asChild>
                    <Button
                      variant="ghost"
                      className={standardGhostButtonClass}
                    >
                      Cancel
                    </Button>
                  </PopoverClose>
                  <Button className={standardPrimaryButtonClass}>
                    Publish
                  </Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </ExampleCard>
      </div>
    </DocsSection>
  );
}

function TextareaStoryboard() {
  if (!hasStoryboard("Textarea")) {
    return null;
  }

  return (
    <DocsSection
      id="textarea"
      title="Textarea"
      description="多行输入与说明字段，沿用共享 field token、focus ring 和 invalid 语义"
      componentId={metadataFor("Textarea")?.id}
    >
      <div className="grid gap-1 lg:grid-cols-2">
        <ExampleCard
          title="States"
          description="默认、placeholder、disabled 与 invalid"
        >
          <div className="grid gap-3">
            <Textarea defaultValue="Summarize workspace changes before handoff." />
            <Textarea placeholder="Describe the migration scope..." />
            <Textarea disabled defaultValue="Locked by policy" />
            <Textarea
              aria-invalid
              defaultValue="This field needs a clearer deployment note."
            />
          </div>
        </ExampleCard>
        <ExampleCard
          title="Long Form Input"
          description="适合 agent prompt、commit note、release summary"
        >
          <div className="grid gap-2">
            <span className={standardFieldLabelClass}>Release note draft</span>
            <Textarea
              className="min-h-32"
              defaultValue={
                "Promote shared workbench primitives into @tutti-os/ui-system and expose storyboard coverage for downstream review."
              }
            />
          </div>
        </ExampleCard>
      </div>
    </DocsSection>
  );
}

function UnderlineTabsStoryboard() {
  const [value, setValue] = useState<"overview" | "agents" | "files" | "logs">(
    "overview"
  );
  const [overflowValue, setOverflowValue] = useState<
    "files" | "changes" | "references" | "sessions" | "diagnostics" | "history"
  >("files");

  if (!hasStoryboard("UnderlineTabs")) {
    return null;
  }

  return (
    <DocsSection
      id="underline-tabs"
      title="Underline Tabs"
      description="密集工作台里的二级导航，支持水平滚动和激活态指示线"
      componentId={metadataFor("UnderlineTabs")?.id}
    >
      <div className="grid gap-1 lg:grid-cols-2">
        <ExampleCard
          title="Standard Row"
          description="标准 pane 切换和 count 元信息"
        >
          <div className="grid gap-4">
            <UnderlineTabs
              tabs={[
                { value: "overview", label: "Overview" },
                { value: "agents", label: "Agents", count: "4" },
                { value: "files", label: "Files", count: "28" },
                { value: "logs", label: "Logs" }
              ]}
              value={value}
              onValueChange={setValue}
            />
            <div className="border border-[rgba(0,0,0,0.08)] bg-[rgba(43,43,43,0.04)] px-3 py-4 text-[13px] text-[rgba(43,43,43,0.70)]">
              Active tab:{" "}
              <span className="font-semibold text-[rgb(0,0,0)]">{value}</span>
            </div>
          </div>
        </ExampleCard>
        <ExampleCard
          title="Overflow"
          description="长 tab 行自动显示左右滚动控制"
        >
          <div className="max-w-[360px]">
            <UnderlineTabs
              tabs={[
                { value: "files", label: "Files", count: "28" },
                { value: "changes", label: "Changes", count: "6" },
                { value: "references", label: "References", count: "12" },
                { value: "sessions", label: "Sessions", count: "3" },
                { value: "diagnostics", label: "Diagnostics" },
                { value: "history", label: "History" }
              ]}
              value={overflowValue}
              onValueChange={setOverflowValue}
            />
          </div>
        </ExampleCard>
      </div>
    </DocsSection>
  );
}

function SortableStoryboard() {
  const [items, setItems] = useState([
    { id: "context", label: "Understand the context" },
    { id: "plan", label: "Create an action plan" },
    { id: "review", label: "Review and improve" }
  ]);
  const [horizontalItems, setHorizontalItems] = useState([
    "One",
    "Two",
    "Three"
  ]);
  const [mixedItems, setMixedItems] = useState(["A", "B", "C", "D"]);
  const compactAccessibility = {
    announcements: {
      onDragStart: () => "Started sorting",
      onDragOver: () => "Changed position",
      onDragEnd: () => "Finished sorting",
      onDragCancel: () => "Canceled sorting"
    },
    screenReaderInstructions: {
      draggable: "Use Space and arrow keys to reorder"
    }
  };

  if (!hasStoryboard("Sortable")) return null;

  return (
    <DocsSection
      id="sortable"
      title="Sortable"
      description="Dice UI-derived controlled sorting with handle-only mouse, touch, and keyboard activation"
      componentId={metadataFor("Sortable")?.id}
    >
      <div className="grid gap-1 lg:grid-cols-2">
        <ExampleCard
          title="Interactive with overlay"
          description="Drag a grip, or focus it and press Space or Enter before using arrow keys; overlay animation follows reduced-motion settings"
        >
          <Sortable
            accessibility={{
              announcements: {
                onDragStart: ({ active }) => `Picked up ${String(active.id)}`,
                onDragMove: ({ active }) => `Moving ${String(active.id)}`,
                onDragOver: ({ active }) => `Moving ${String(active.id)}`,
                onDragEnd: ({ active }) => `Dropped ${String(active.id)}`,
                onDragCancel: ({ active }) =>
                  `Canceled sorting ${String(active.id)}`
              },
              screenReaderInstructions: {
                draggable:
                  "Press Space or Enter to pick up, use arrow keys to move, and press Space or Enter to drop"
              }
            }}
            getItemValue={(item) => item.id}
            value={items}
            onValueChange={setItems}
          >
            <SortableContent className="flex max-w-md flex-col gap-1">
              {items.map((item) => (
                <SortableItem
                  key={item.id}
                  className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-1)] bg-[var(--background-fronted)] px-2 py-2 text-[13px] text-[var(--text-primary)]"
                  value={item.id}
                >
                  <SortableItemHandle asChild>
                    <BareIconButton aria-label={`Reorder ${item.label}`}>
                      <SystemIcons.GripVerticalIcon />
                    </BareIconButton>
                  </SortableItemHandle>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </SortableItem>
              ))}
            </SortableContent>
            <SortableOverlay>
              {({ value }) => (
                <div className="rounded-[var(--radius-md)] border border-[var(--border-1)] bg-[var(--background-fronted)] px-3 py-2 text-[13px] shadow-soft">
                  {items.find((item) => item.id === value)?.label ??
                    String(value)}
                </div>
              )}
            </SortableOverlay>
          </Sortable>
        </ExampleCard>
        <ExampleCard
          title="Disabled state"
          description="Parent disabled state remains authoritative for the handle and item"
        >
          <Sortable
            accessibility={compactAccessibility}
            value={["disabled-item"]}
          >
            <SortableContent className="flex max-w-md flex-col gap-1">
              <SortableItem
                disabled
                className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-1)] bg-[var(--background-fronted)] px-2 py-2 text-[13px] text-[var(--text-primary)]"
                value="disabled-item"
              >
                <SortableItemHandle asChild>
                  <BareIconButton aria-label="Reorder disabled item">
                    <SystemIcons.GripVerticalIcon />
                  </BareIconButton>
                </SortableItemHandle>
                <span>Disabled item</span>
              </SortableItem>
            </SortableContent>
          </Sortable>
        </ExampleCard>
        <ExampleCard
          title="Horizontal and mixed strategies"
          description="Stable orientation variants use the same controlled-value and handle contracts"
        >
          <div className="grid gap-4">
            <Sortable
              accessibility={compactAccessibility}
              orientation="horizontal"
              value={horizontalItems}
              onValueChange={setHorizontalItems}
            >
              <SortableContent className="flex gap-1">
                {horizontalItems.map((item) => (
                  <SortableItem
                    key={item}
                    className="flex items-center gap-1 rounded-[var(--radius-md)] border border-[var(--border-1)] bg-[var(--background-fronted)] px-2 py-2 text-[13px]"
                    value={item}
                  >
                    <SortableItemHandle asChild>
                      <BareIconButton aria-label={`Reorder ${item}`}>
                        <SystemIcons.GripVerticalIcon />
                      </BareIconButton>
                    </SortableItemHandle>
                    {item}
                  </SortableItem>
                ))}
              </SortableContent>
            </Sortable>
            <Sortable
              accessibility={compactAccessibility}
              orientation="mixed"
              value={mixedItems}
              onValueChange={setMixedItems}
            >
              <SortableContent className="grid grid-cols-2 gap-1">
                {mixedItems.map((item) => (
                  <SortableItem
                    key={item}
                    className="flex items-center gap-1 rounded-[var(--radius-md)] border border-[var(--border-1)] bg-[var(--background-fronted)] px-2 py-2 text-[13px]"
                    value={item}
                  >
                    <SortableItemHandle asChild>
                      <BareIconButton aria-label={`Reorder ${item}`}>
                        <SystemIcons.GripVerticalIcon />
                      </BareIconButton>
                    </SortableItemHandle>
                    Grid {item}
                  </SortableItem>
                ))}
              </SortableContent>
            </Sortable>
          </div>
        </ExampleCard>
      </div>
    </DocsSection>
  );
}

function StatusDotStoryboard() {
  if (!hasStoryboard("StatusDot")) {
    return null;
  }

  return (
    <DocsSection
      id="status-dot"
      title="Status Dot"
      description="极紧凑状态点，适合 presence、runtime 和列表元信息"
      componentId={metadataFor("StatusDot")?.id}
    >
      <div className="grid gap-1 lg:grid-cols-2">
        <ExampleCard title="Tones" description="不同状态语义的 tone 映射">
          <div className="grid gap-3">
            {[
              ["neutral", "Idle"],
              ["green", "Healthy"],
              ["blue", "Running"],
              ["amber", "Queued"],
              ["red", "Failed"]
            ].map(([tone, label]) => (
              <div
                key={tone}
                className="flex items-center justify-between border border-[rgba(0,0,0,0.08)] bg-[rgb(255,255,255)] px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <StatusDot
                    tone={
                      tone as "neutral" | "green" | "blue" | "amber" | "red"
                    }
                  />
                  <span className="text-[13px] text-[rgb(0,0,0)]">{label}</span>
                </div>
                <code className="font-mono text-[11px] text-[rgba(43,43,43,0.50)]">
                  {tone}
                </code>
              </div>
            ))}
          </div>
        </ExampleCard>
      </div>
    </DocsSection>
  );
}

function MenuSurfaceStoryboard() {
  if (!hasStoryboard("MenuSurface")) {
    return null;
  }

  return (
    <DocsSection
      id="menu-surface"
      title="Menu Surface"
      description="基础浮层菜单容器，提供统一圆角、边框、背景、阴影与打开状态标记"
      componentId={metadataFor("MenuSurface")?.id}
    >
      <div className="grid gap-1 lg:grid-cols-2">
        <ExampleCard
          title="Command List"
          description="用于 workspace switcher、dropdown panel 和小型命令菜单"
        >
          <MenuSurface className="w-[260px]">
            <button
              className={`${standardMenuSurfaceItemClass} hover:bg-[var(--transparency-hover)]`}
            >
              Open workspace
            </button>
            <button
              className={`${standardMenuSurfaceItemClass} hover:bg-[var(--transparency-hover)]`}
            >
              Rename workspace
            </button>
            <div className="mx-2 my-0.5 h-px bg-[var(--border-2)]" />
            <button
              className={`${standardMenuSurfaceItemClass} text-[var(--state-danger)] hover:bg-[var(--on-danger)]`}
            >
              Remove workspace
            </button>
          </MenuSurface>
        </ExampleCard>
        <ExampleCard
          title="Composition Contract"
          description="公开稳定容器，不绑定触发器、定位或 dismiss 行为"
        >
          <div className="grid gap-3 text-[13px] leading-6 text-[var(--text-secondary)]">
            <p>
              MenuSurface 只负责菜单外观和 state data attribute。
              触发器、定位、焦点管理与关闭逻辑由调用方或更高阶浮层组件持有。
            </p>
            <code className="rounded-[6px] bg-[var(--transparency-block)] px-2 py-1 font-mono text-[11px] text-[var(--text-primary)]">
              {'<MenuSurface state="open" />'}
            </code>
          </div>
        </ExampleCard>
      </div>
    </DocsSection>
  );
}

function ViewportMenuSurfaceStoryboard() {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const boundaryRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<ViewportMenuPlacement | null>(
    null
  );

  const openFromTrigger = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    setPlacement({
      type: "point",
      point: {
        x: rect.left,
        y: rect.bottom + 8
      },
      alignX: "start",
      alignY: "start",
      estimatedSize: {
        width: 220,
        height: 160
      }
    });
  }, []);

  if (!hasStoryboard("ViewportMenuSurface")) {
    return null;
  }

  return (
    <DocsSection
      id="viewport-menu-surface"
      title="Viewport Menu Surface"
      description="视口边界感知浮层容器，适合 canvas、board 和 context menu 这类绝对定位 overlay"
      componentId={metadataFor("ViewportMenuSurface")?.id}
    >
      <div className="grid gap-1 lg:grid-cols-2">
        <ExampleCard
          title="Trigger Anchored"
          description="从按钮坐标计算 point placement"
        >
          <div
            ref={boundaryRef}
            data-slot="viewport-menu-boundary"
            className="relative min-h-[220px] overflow-hidden border border-[var(--border-1)] bg-[var(--transparency-block)] p-3"
          >
            <Button
              ref={triggerRef}
              variant="secondary"
              className={standardSecondaryButtonClass}
              onClick={openFromTrigger}
            >
              Open menu
            </Button>
            <ViewportMenuSurface
              open={placement !== null}
              placement={
                placement ?? {
                  type: "absolute",
                  left: 0,
                  top: 0
                }
              }
              className="w-[220px]"
              dismissIgnoreRefs={[triggerRef]}
              dismissOnEscape
              dismissOnPointerDownOutside
              dismissOnScroll
              onDismiss={() => setPlacement(null)}
            >
              <button
                className={`${standardMenuSurfaceItemClass} hover:bg-[var(--transparency-hover)]`}
              >
                Rename workspace
              </button>
              <button
                className={`${standardMenuSurfaceItemClass} hover:bg-[var(--transparency-hover)]`}
              >
                Duplicate config
              </button>
              <button
                className={`${standardMenuSurfaceItemClass} text-[var(--state-danger)] hover:bg-[var(--on-danger)]`}
              >
                Remove from launcher
              </button>
            </ViewportMenuSurface>
          </div>
        </ExampleCard>
        <ExampleCard
          title="Surface Contract"
          description="点位放置、边界钳制与外部 dismiss"
        >
          <div className="grid gap-3 text-[13px] leading-6 text-[var(--text-secondary)]">
            <p>
              用于不依赖 Radix anchor tree 的 overlay，例如 canvas
              右键菜单、board 节点工具条、 任意 point-based 浮层。
            </p>
            <ul className="grid gap-1 text-[11px] text-[var(--text-tertiary)]">
              <li>支持 absolute 或 point placement</li>
              <li>支持 escape、outside pointer down、scroll dismiss</li>
              <li>
                通过 <code>data-slot="viewport-menu-boundary"</code>{" "}
                自动约束边界
              </li>
            </ul>
          </div>
        </ExampleCard>
      </div>
    </DocsSection>
  );
}

function ButtonStoryboard() {
  if (!hasStoryboard("Button") || !buttonComponent) {
    return null;
  }

  return (
    <DocsSection
      id="button"
      title="Button"
      description="按钮层级遵循主次关系，同一区域只保留一个最强主操作"
      componentId={metadataFor("Button")?.id}
    >
      <div className="grid gap-1">
        <div className="grid gap-1 lg:grid-cols-2">
          <ExampleCard
            title="Button Variants"
            description="主按钮、副按钮与危险按钮"
          >
            <div className={standardRuleTableFrameClass}>
              <table className="w-full table-fixed border-collapse text-left">
                <thead>
                  <tr className={standardRuleTableHeaderRowClass}>
                    <th className="w-52 px-3 py-2">Example</th>
                    <th className="px-3 py-2">Token Rule</th>
                  </tr>
                </thead>
                <tbody className={standardRuleTableBodyClass}>
                  <tr className={standardRuleTableDividerClass}>
                    <td className="px-3 py-3">
                      <Button className={standardPrimaryButtonClass}>
                        Primary
                      </Button>
                    </td>
                    <td className="px-3 py-3">
                      Light 使用 <code>--text-primary</code> 实心底，文本消费{" "}
                      <code>--text-inverted</code>。
                    </td>
                  </tr>
                  <tr className={standardRuleTableDividerClass}>
                    <td className="px-3 py-3">
                      <Button
                        variant="secondary"
                        className={standardSecondaryButtonClass}
                      >
                        Secondary
                      </Button>
                    </td>
                    <td className="px-3 py-3">
                      默认底色消费 <code>--transparency-block</code>，hover
                      底色消费 <code>--transparency-hover</code>。
                    </td>
                  </tr>
                  <tr className={standardRuleTableDividerClass}>
                    <td className="px-3 py-3">
                      <Button
                        variant="ghost"
                        className={standardGhostButtonClass}
                      >
                        Ghost
                      </Button>
                    </td>
                    <td className="px-3 py-3">
                      默认透明底，hover 消费 <code>--transparency-hover</code>
                      ，active 消费 <code>--transparency-active</code>。
                    </td>
                  </tr>
                  <tr className={standardRuleTableDividerClass}>
                    <td className="px-3 py-3">
                      <Button
                        variant="destructive"
                        className={standardDestructiveButtonClass}
                      >
                        Destructive
                      </Button>
                    </td>
                    <td className="px-3 py-3">
                      默认底色消费 <code>--state-danger</code>，hover 底色消费{" "}
                      <code>--state-danger-hover</code>，文本消费{" "}
                      <code>--white-stationary</code>。
                    </td>
                  </tr>
                  <tr className={standardRuleTableDividerClass}>
                    <td className="px-3 py-3">
                      <Button
                        variant="secondary"
                        className={standardDestructiveSecondaryButtonClass}
                      >
                        Danger Secondary
                      </Button>
                    </td>
                    <td className="px-3 py-3">
                      默认底色消费 <code>--on-danger</code>，hover 底色消费{" "}
                      <code>--on-danger-hover</code>，文本消费{" "}
                      <code>--state-danger</code>。
                    </td>
                  </tr>
                  <tr className={standardRuleTableDividerClass}>
                    <td className="px-3 py-3">
                      <Button
                        variant="ghost"
                        className={standardDestructiveGhostButtonClass}
                      >
                        Danger Ghost
                      </Button>
                    </td>
                    <td className="px-3 py-3">
                      默认透明底，文本消费 <code>--state-danger</code>；hover
                      底色消费 <code>--on-danger</code>，文本消费{" "}
                      <code>--state-danger-hover</code>。
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </ExampleCard>

          <ExampleCard
            title="Button States"
            description="加载态、禁用态和全宽按钮"
          >
            <div className={standardRuleTableFrameClass}>
              <table className="w-full table-fixed border-collapse text-left">
                <thead>
                  <tr className={standardRuleTableHeaderRowClass}>
                    <th className="w-56 px-3 py-2">Example</th>
                    <th className="px-3 py-2">State Rule</th>
                  </tr>
                </thead>
                <tbody className={standardRuleTableBodyClass}>
                  <tr className={standardRuleTableDividerClass}>
                    <td className="px-3 py-3">
                      <Button disabled className={standardPrimaryButtonClass}>
                        Saving...
                      </Button>
                    </td>
                    <td className="px-3 py-3">
                      加载态沿用 disabled 视觉：底色消费{" "}
                      <code>--transparency-block</code>，文本消费{" "}
                      <code>--text-disabled</code>，不叠加 opacity。
                    </td>
                  </tr>
                  <tr className={standardRuleTableDividerClass}>
                    <td className="px-3 py-3">
                      <Button
                        disabled
                        variant="secondary"
                        className={standardSecondaryButtonClass}
                      >
                        Disabled
                      </Button>
                    </td>
                    <td className="px-3 py-3">
                      有底按钮 disabled 底色保持{" "}
                      <code>--transparency-block</code>，文本消费{" "}
                      <code>--text-disabled</code>。
                    </td>
                  </tr>
                  <tr className={standardRuleTableDividerClass}>
                    <td className="px-3 py-3">
                      <Button
                        disabled
                        variant="ghost"
                        className={standardGhostButtonClass}
                      >
                        Ghost Disabled
                      </Button>
                    </td>
                    <td className="px-3 py-3">
                      Ghost disabled 保持透明底，只消费{" "}
                      <code>--text-disabled</code>，不出现 hover 底色反馈。
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-3">
                      <Button
                        className={`${standardPrimaryButtonClass} w-full`}
                      >
                        Full Width Action
                      </Button>
                    </td>
                    <td className="px-3 py-3">
                      全宽按钮只改变布局宽度，颜色仍按 Primary 消费{" "}
                      <code>--text-primary</code> 与{" "}
                      <code>--text-inverted</code>。
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </ExampleCard>
        </div>

        <div className="grid gap-1 lg:grid-cols-2">
          <ExampleCard
            title="Icon + Text Buttons"
            description="图标与文案组合按钮"
          >
            <div className={standardRuleTableFrameClass}>
              <table className="w-full table-fixed border-collapse text-left">
                <thead>
                  <tr className={standardRuleTableHeaderRowClass}>
                    <th className="w-56 px-3 py-2">Example</th>
                    <th className="px-3 py-2">Text Rule</th>
                  </tr>
                </thead>
                <tbody className={standardRuleTableBodyClass}>
                  <tr className={standardRuleTableDividerClass}>
                    <td className="px-3 py-3">
                      <Button
                        className={`${standardPrimaryButtonClass} gap-[6px]`}
                      >
                        <FileCreateIcon className="size-4 text-current" />
                        New Project
                      </Button>
                    </td>
                    <td className="px-3 py-3">
                      <span className={standardRuleStrongClass}>
                        Primary
                      </span> /
                      icon 16px · icon/text gap 6px · 文本消费{" "}
                      <code>--text-inverted</code>。
                    </td>
                  </tr>
                  <tr className={standardRuleTableDividerClass}>
                    <td className="px-3 py-3">
                      <Button
                        variant="secondary"
                        className={`${standardSecondaryButtonClass} gap-[6px]`}
                      >
                        <RefreshIcon className="size-4 text-current" />
                        Restart
                      </Button>
                    </td>
                    <td className="px-3 py-3">
                      <span className={standardRuleStrongClass}>
                        Secondary
                      </span>{" "}
                      / icon 16px · icon/text gap 6px · 底色消费{" "}
                      <code>--transparency-block</code>。
                    </td>
                  </tr>
                  <tr className={standardRuleTableDividerClass}>
                    <td className="px-3 py-3">
                      <Button
                        variant="destructive"
                        className={`${standardDestructiveButtonClass} gap-[6px]`}
                      >
                        <DeleteIcon className="size-4 text-current" />
                        Delete
                      </Button>
                    </td>
                    <td className="px-3 py-3">
                      <span className={standardRuleStrongClass}>
                        Destructive
                      </span>{" "}
                      / icon 16px · icon/text gap 6px · 底色消费{" "}
                      <code>--state-danger</code>。
                    </td>
                  </tr>
                  <tr className={standardRuleTableDividerClass}>
                    <td className="px-3 py-3">
                      <Button
                        variant="ghost"
                        className={`${standardGhostButtonClass} gap-[6px]`}
                      >
                        <UploadIcon className="size-4 text-current" />
                        Export
                      </Button>
                    </td>
                    <td className="px-3 py-3">
                      <span className={standardRuleStrongClass}>
                        Ghost
                      </span> /
                      icon 16px · icon/text gap 6px · 默认透明底。
                    </td>
                  </tr>
                  <tr className={standardRuleTableDividerClass}>
                    <td className="px-3 py-3">
                      <Button
                        variant="secondary"
                        className={`${standardSecondaryButtonClass} min-w-[200px] justify-start gap-[6px]`}
                      >
                        <GoogleBrandIcon />
                        Continue with Google
                      </Button>
                    </td>
                    <td className="px-3 py-3">
                      Third-party SVG + text / icon/text gap 6px ·
                      仍消费按钮自身 variant token。
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-3">
                      <Button
                        variant="secondary"
                        className={`${standardSecondaryButtonClass} min-w-[200px] justify-start gap-[6px]`}
                      >
                        <GitHubBrandIcon />
                        Continue with GitHub
                      </Button>
                    </td>
                    <td className="px-3 py-3">
                      Third-party SVG + text / icon/text gap 6px ·
                      品牌图标保持原始图形语义。
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </ExampleCard>

          <ExampleCard
            title="Icon Buttons"
            description="纯图标按钮，用于工具栏等紧凑场景"
          >
            <div className={standardRuleTableFrameClass}>
              <table className="w-full table-fixed border-collapse text-left">
                <thead>
                  <tr className={standardRuleTableHeaderRowClass}>
                    <th className="w-44 px-3 py-2">Example</th>
                    <th className="px-3 py-2">Icon Rule</th>
                  </tr>
                </thead>
                <tbody className={standardRuleTableBodyClass}>
                  <tr className={standardRuleTableDividerClass}>
                    <td className="px-3 py-3">
                      <Button
                        aria-label="New item"
                        size="icon"
                        className={`${standardPrimaryButtonClass} p-0`}
                      >
                        <FileCreateIcon className="size-4 text-current" />
                      </Button>
                    </td>
                    <td className="px-3 py-3">
                      <span className={standardRuleStrongClass}>Primary</span> /
                      实心主操作图标按钮；必须提供 aria-label。 32px high · 16px
                      icon。
                    </td>
                  </tr>
                  <tr className={standardRuleTableDividerClass}>
                    <td className="px-3 py-3">
                      <IconButton ariaLabel="Edit">
                        <EditIcon className="size-4 text-current" />
                      </IconButton>
                    </td>
                    <td className="px-3 py-3">
                      <span className={standardRuleStrongClass}>Secondary</span>{" "}
                      / 有底次级图标按钮，用于工具栏常规操作。 32px high · 16px
                      icon。
                    </td>
                  </tr>
                  <tr className={standardRuleTableDividerClass}>
                    <td className="px-3 py-3">
                      <Button
                        aria-label="Delete"
                        variant="destructive"
                        size="icon"
                        className={`${standardDestructiveButtonClass} p-0`}
                      >
                        <DeleteIcon className="size-4 text-current" />
                      </Button>
                    </td>
                    <td className="px-3 py-3">
                      <span className={standardRuleStrongClass}>
                        Destructive
                      </span>{" "}
                      / 警示图标按钮，底色消费 <code>--state-danger</code>。
                      32px high · 16px icon。
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-3">
                      <Button
                        aria-label="Download"
                        variant="ghost"
                        size="icon"
                        className={`${standardGhostButtonClass} p-0`}
                      >
                        <UploadIcon className="size-4 text-current" />
                      </Button>
                    </td>
                    <td className="px-3 py-3">
                      <span className={standardRuleStrongClass}>Ghost</span> /
                      透明底图标按钮，hover 底色消费{" "}
                      <code>--transparency-hover</code>。 32px high · 16px
                      icon。
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-1">
                        <BareIconButton aria-label="Quick edit">
                          <EditIcon />
                        </BareIconButton>
                        <BareIconButton aria-label="Quick refresh" size="sm">
                          <RefreshIcon />
                        </BareIconButton>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <span className={standardRuleStrongClass}>Bare Icon</span>{" "}
                      / 无底图标按钮，hover 和 active 都不出现底色，仅图标从{" "}
                      <code>--text-tertiary</code> 变为{" "}
                      <code>--text-primary</code>。24px / 20px。
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </ExampleCard>
        </div>

        <div className="grid gap-1">
          <ExampleCard
            title="Button Size Gradient"
            description="最新规范定义的五档文字按钮"
          >
            <div className={standardRuleTableFrameClass}>
              <table className="w-full table-fixed border-collapse text-left">
                <thead>
                  <tr className={standardRuleTableHeaderRowClass}>
                    <th className="w-44 px-3 py-2">Example</th>
                    <th className="px-3 py-2">Size Rule</th>
                  </tr>
                </thead>
                <tbody className={standardRuleTableBodyClass}>
                  {buttonSizeSpecs.map((size, index) => (
                    <tr
                      key={size.label}
                      className={
                        index === buttonSizeSpecs.length - 1
                          ? ""
                          : standardRuleTableDividerClass
                      }
                    >
                      <td className="px-3 py-3">
                        <Button
                          variant="secondary"
                          className={`${standardSecondaryButtonClass} ${size.className} ${size.gapClass}`}
                        >
                          <EditIcon
                            className={`${size.iconClass} text-current`}
                          />
                          Edit
                        </Button>
                      </td>
                      <td className="px-3 py-3">
                        <span className={standardRuleStrongClass}>
                          {size.label}
                        </span>
                        <span className={standardRuleSeparatorClass}>/</span>
                        <span>{size.usage}</span>
                        <br />
                        {size.meta} · icon/text gap {size.gapMeta}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </ExampleCard>
        </div>
      </div>
    </DocsSection>
  );
}

function InputStoryboard() {
  if (!hasStoryboard("Input")) {
    return null;
  }

  return (
    <DocsSection
      id="input"
      title="Input"
      description="文本输入保持紧凑高度，状态通过 border、ring 和禁用底色表达"
      componentId={metadataFor("Input")?.id}
    >
      <div className="-mt-4 grid gap-1 lg:grid-cols-2">
        <ExampleCard
          title="Text Fields"
          description="默认、placeholder 与说明文案"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-2">
              <span className={standardFieldLabelClass}>Workspace name</span>
              <Input variant="md" defaultValue="Tutti Design System" />
            </label>
            <label className="grid gap-2">
              <span className={standardFieldLabelClass}>Search token</span>
              <Input variant="md" placeholder="component, hook, token..." />
            </label>
          </div>
        </ExampleCard>
        <ExampleCard title="Input States" description="禁用、错误和只读输入">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid content-start gap-2">
              <span className={standardFieldLabelClass}>Disabled</span>
              <Input variant="md" disabled value="Locked by policy" readOnly />
            </label>
            <label className="grid content-start gap-2">
              <span className={standardFieldLabelClass}>Invalid</span>
              <Input
                aria-describedby="input-invalid-message"
                variant="md"
                aria-invalid
                defaultValue="invalid#value"
              />
              <span
                className="block text-[11px] font-normal leading-[1.3] text-[var(--state-danger)]"
                id="input-invalid-message"
              >
                Only letters, numbers, dashes, and underscores.
              </span>
            </label>
          </div>
        </ExampleCard>
      </div>
    </DocsSection>
  );
}

function SelectMenuItemPreview({
  children,
  icon,
  showIcon,
  active = false
}: {
  children: ReactNode;
  icon: ReactNode;
  showIcon: boolean;
  active?: boolean;
}) {
  return (
    <div
      className={`${standardSelectMenuItemClass} ${
        active ? standardSelectMenuItemActiveClass : ""
      }`}
    >
      {showIcon ? (
        <span className="flex size-4 shrink-0 items-center justify-center text-[var(--text-tertiary)]">
          {icon}
        </span>
      ) : null}
      <span>{children}</span>
    </div>
  );
}

function SelectMenuPreview({ showLeadingIcon }: { showLeadingIcon: boolean }) {
  return (
    <div className={standardSelectMenuClass}>
      <div className={standardSelectMenuLabelClass}>Workspace</div>
      <SelectMenuItemPreview
        active
        icon={<LocateFolderIcon className="size-4" />}
        showIcon={showLeadingIcon}
      >
        Current workspace
      </SelectMenuItemPreview>
      <SelectMenuItemPreview
        icon={<FileIcon className="size-4" />}
        showIcon={showLeadingIcon}
      >
        File manager
      </SelectMenuItemPreview>
      <div className={standardSelectMenuSeparatorClass} />
      <div className={standardSelectMenuLabelClass}>System</div>
      <SelectMenuItemPreview
        icon={<SettingsIcon className="size-4" />}
        showIcon={showLeadingIcon}
      >
        Settings
      </SelectMenuItemPreview>
      <SelectMenuItemPreview
        icon={<WarningLinedIcon className="size-4" />}
        showIcon={showLeadingIcon}
      >
        Diagnostics
      </SelectMenuItemPreview>
    </div>
  );
}

function SelectSplitMenuItemPreview({
  title,
  description,
  selected = false
}: {
  title: string;
  description?: string;
  selected?: boolean;
}) {
  return (
    <div className={standardSelectSplitItemClass}>
      <span className={standardSelectSplitItemBodyClass}>
        <span className={standardSelectSplitItemTitleClass}>
          <span className="min-w-0 flex-1 truncate">{title}</span>
        </span>
        {description ? (
          <span className={standardSelectSplitItemDescriptionClass}>
            {description}
          </span>
        ) : null}
      </span>
      <span
        className="flex w-[18px] shrink-0 justify-center text-[var(--text-primary)]"
        aria-hidden="true"
      >
        {selected ? <CheckIcon className="size-[15px]" /> : null}
      </span>
    </div>
  );
}

function SelectModelSplitMenuPreview() {
  return (
    <div className={standardSelectSplitMenuClass}>
      <SelectSplitLayout className="h-[252px]">
        <SelectSplitColumn>
          <SelectSplitColumnLabel>Model selection</SelectSplitColumnLabel>
          <SelectSplitColumnItems>
            <SelectSplitMenuItemPreview
              selected
              title="Default (recommended)"
              description="Use the default model (currently GPT-5.1) · $5/$25 per Mtok"
            />
            <SelectSplitMenuItemPreview
              title="GPT-5.1"
              description="Frontier model for complex coding, research, and real-world work."
            />
            <SelectSplitMenuItemPreview
              title="GPT-5.1 Codex Mini"
              description="Small, fast, and cost-efficient model for simpler coding tasks."
            />
          </SelectSplitColumnItems>
        </SelectSplitColumn>
        <SelectSplitDivider />
        <SelectSplitColumn>
          <SelectSplitColumnLabel>Reasoning degree</SelectSplitColumnLabel>
          <SelectSplitColumnItems>
            <SelectSplitMenuItemPreview title="Low" />
            <SelectSplitMenuItemPreview title="Medium" />
            <SelectSplitMenuItemPreview selected title="High" />
            <SelectSplitMenuItemPreview title="X High" />
          </SelectSplitColumnItems>
        </SelectSplitColumn>
      </SelectSplitLayout>
    </div>
  );
}

function ResizableStoryboard() {
  if (!hasStoryboard("ResizablePanelGroup")) {
    return null;
  }

  return (
    <DocsSection
      id="resizable-panel-group"
      title="Resizable Panel Group"
      description="从 react-resizable-panels 提升的 split pane primitive，业务组件只消费 ui-system wrapper。"
      componentId={metadataFor("ResizablePanelGroup")?.id}
    >
      <ExampleCard
        title="Horizontal Split Pane"
        description="ResizablePanelGroup 负责方向和布局，ResizablePanel 承载内容，ResizableHandle 提供拖拽分隔。"
      >
        <div className="h-[220px] overflow-hidden rounded-[12px] border border-[var(--border-1)] bg-[var(--background-fronted)]">
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel defaultSize={34} minSize="120px">
              <div className="flex h-full items-center justify-center bg-[var(--transparency-block)] px-4 text-[13px] font-semibold text-[var(--text-secondary)]">
                Rail
              </div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={66} minSize="120px">
              <div className="flex h-full items-center justify-center px-4 text-[13px] font-semibold text-[var(--text-primary)]">
                Detail
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </ExampleCard>
    </DocsSection>
  );
}

function SelectStoryboard() {
  const [showLeadingIcon, setShowLeadingIcon] = useState(true);

  if (!hasStoryboard("Select")) {
    return null;
  }

  return (
    <DocsSection
      id="select"
      title="Select"
      description="用于单选设置、筛选器和紧凑配置项，内容支持分组和分割线"
      componentId={metadataFor("Select")?.id}
    >
      <div className="grid gap-1 lg:grid-cols-2">
        <ExampleCard
          title="Select Controls"
          description="默认尺寸与小尺寸触发器"
        >
          <div className="mb-5">
            <StorySwitch
              checked={showLeadingIcon}
              label="Leading icon"
              onCheckedChange={setShowLeadingIcon}
            />
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <label className="space-y-1.5">
              <span className={standardFieldLabelClass}>Theme</span>
              <Select defaultValue="system">
                <SelectTrigger
                  className={`${standardSelectTriggerClass} w-[180px]`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {showLeadingIcon ? (
                      <SettingsIcon className="size-4 text-[var(--text-tertiary)]" />
                    ) : null}
                    <SelectValue placeholder="Select theme" />
                  </span>
                </SelectTrigger>
                <SelectContent className={standardSelectContentClass}>
                  <SelectGroup className={standardSelectGroupClass}>
                    <SelectLabel className={standardSelectLabelClass}>
                      Appearance
                    </SelectLabel>
                    <SelectItem
                      className={standardSelectItemClass}
                      value="light"
                    >
                      Light
                    </SelectItem>
                    <SelectItem
                      className={standardSelectItemClass}
                      value="dark"
                    >
                      Dark
                    </SelectItem>
                    <SelectItem
                      className={standardSelectItemClass}
                      value="system"
                    >
                      System
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </label>
          </div>
        </ExampleCard>
        <ExampleCard title="Select Menu" description="呼出菜单面板与选项状态">
          <div className="grid gap-4">
            <SelectMenuPreview showLeadingIcon={showLeadingIcon} />
            <SelectModelSplitMenuPreview />
          </div>
          <p className="mt-4 text-[11px] leading-5 text-[var(--text-tertiary)]">
            Menu surface 消费 <code>--background-fronted</code>、
            <code>--border-1</code>、<code>--shadow-elevated</code>；item hover
            消费 <code>--transparency-block</code>；模型选择使用左右 split
            分组，左侧自适应、右侧 104-132px，selected 仅显示 check，分割线消费{" "}
            <code>--border-2</code>。
          </p>
        </ExampleCard>
      </div>
    </DocsSection>
  );
}

const comboboxStoryOptions = [
  {
    description: "Flagship tier · long-context reasoning",
    label: "Claude Fable 5",
    value: "claude-fable-5"
  },
  {
    description: "Standard tier · balanced default",
    label: "Claude Sonnet 5",
    value: "claude-sonnet-5"
  },
  {
    description: "Economy tier · fast and inexpensive",
    label: "Claude Haiku 4.5",
    value: "claude-haiku-4-5"
  },
  { label: "GPT-5.2", value: "gpt-5.2" },
  { label: "GPT-5.2 mini", value: "gpt-5.2-mini" }
];

function ComboboxStoryboard() {
  const [catalogValue, setCatalogValue] = useState("claude-sonnet-5");
  const [customValue, setCustomValue] = useState("");

  if (!hasStoryboard("Combobox")) {
    return null;
  }

  return (
    <DocsSection
      id="combobox"
      title="Combobox"
      description="用于从较大目录中搜索并选择单个值；列表高度固定，可选支持输入目录外的自定义值"
      componentId={metadataFor("Combobox")?.id}
    >
      <div className="grid gap-1 lg:grid-cols-2">
        <ExampleCard
          title="Catalog Selection"
          description="搜索过滤、键盘导航与选中态"
        >
          <div className="grid max-w-[320px] gap-4">
            <label className="space-y-1.5">
              <span className={standardFieldLabelClass}>Model</span>
              <Combobox
                aria-label="Model"
                emptyMessage="No matching models"
                options={comboboxStoryOptions}
                placeholder="Select model"
                searchPlaceholder="Search models..."
                value={catalogValue}
                onValueChange={setCatalogValue}
              />
            </label>
            <label className="space-y-1.5">
              <span className={standardFieldLabelClass}>Disabled</span>
              <Combobox
                aria-label="Disabled model"
                disabled
                options={comboboxStoryOptions}
                placeholder="Select model"
                value=""
                onValueChange={() => undefined}
              />
            </label>
          </div>
        </ExampleCard>
        <ExampleCard
          title="Custom Value"
          description="目录没有匹配项时，允许把输入内容作为自定义值提交"
        >
          <div className="grid max-w-[320px] gap-4">
            <label className="space-y-1.5">
              <span className={standardFieldLabelClass}>Model id</span>
              <Combobox
                allowCustomValue
                aria-label="Model id"
                customValueLabel={(query) => `Use "${query}"`}
                emptyMessage="No matching models"
                options={comboboxStoryOptions}
                placeholder="Select or type a model id"
                searchPlaceholder="Search or type..."
                value={customValue}
                onValueChange={setCustomValue}
              />
            </label>
            <p className="m-0 text-[11px] leading-5 text-[var(--text-tertiary)]">
              Selected value:{" "}
              <code className="font-mono text-[11px] text-[var(--text-primary)]">
                {customValue || "—"}
              </code>
            </p>
          </div>
        </ExampleCard>
      </div>
    </DocsSection>
  );
}

function DialogStoryboard() {
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!hasStoryboard("Dialog")) {
    return null;
  }

  return (
    <DocsSection
      id="dialog"
      title="Dialog"
      description="用于聚焦流程和危险确认，默认基于 Radix dialog primitive"
      componentId={metadataFor("Dialog")?.id}
    >
      <div className="grid gap-1 lg:grid-cols-2">
        <ExampleCard
          title="Dialog Composition"
          description="标题、描述、内容和 footer"
        >
          <Dialog>
            <DialogTrigger asChild>
              <Button className={standardPrimaryButtonClass}>
                Open dialog
              </Button>
            </DialogTrigger>
            <DialogContent
              className={standardOverlayContentClass}
              overlayClassName={standardOverlayClass}
            >
              <DialogHeader>
                <DialogTitle className={standardDialogTitleClass}>
                  Create workspace
                </DialogTitle>
                <DialogDescription className={standardDialogDescriptionClass}>
                  Name the workspace before Tutti creates the local container.
                </DialogDescription>
              </DialogHeader>
              <Input
                className={standardInputClass}
                defaultValue="Design review"
              />
              <DialogFooter className={standardDialogFooterClass}>
                <DialogClose asChild>
                  <Button
                    variant="ghost"
                    size="dialog"
                    className={standardGhostButtonClass}
                  >
                    Cancel
                  </Button>
                </DialogClose>
                <Button size="dialog">Create</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </ExampleCard>
        <ExampleCard
          title="Confirmation Dialog"
          description="破坏性操作需要明确确认"
        >
          <Button
            variant="destructive"
            className={standardDestructiveButtonClass}
            onClick={() => setConfirmOpen(true)}
          >
            Delete workspace
          </Button>
          <ConfirmationDialog
            cancelLabel="Cancel"
            confirmLabel="Delete"
            className={standardOverlayContentClass}
            description="This removes the local workspace entry. Files on disk remain untouched."
            open={confirmOpen}
            overlayClassName={standardOverlayClass}
            title="Delete workspace?"
            tone="destructive"
            onCancel={() => setConfirmOpen(false)}
            onConfirm={() => setConfirmOpen(false)}
            onOpenChange={setConfirmOpen}
          />
        </ExampleCard>
      </div>
    </DocsSection>
  );
}

function DrawerStoryboard() {
  if (!hasStoryboard("Drawer")) {
    return null;
  }

  return (
    <DocsSection
      id="drawer"
      title="Drawer"
      description="用于从视口边缘拉出的临时面板，默认基于 Vaul drawer primitive"
      componentId={metadataFor("Drawer")?.id}
    >
      <div className="grid gap-1 lg:grid-cols-2">
        <ExampleCard
          title="Right Drawer"
          description="右侧抽屉覆盖页面 chrome，适合消息中心和详情面板"
        >
          <Drawer direction="right">
            <DrawerTrigger asChild>
              <Button className={standardPrimaryButtonClass}>
                Open drawer
              </Button>
            </DrawerTrigger>
            <DrawerContent className="w-[min(380px,calc(100vw-24px))] max-w-none rounded-none border-y-0 border-r-0">
              <DrawerHeader className="border-b border-[var(--border-1)]">
                <DrawerTitle className={standardDialogTitleClass}>
                  Message center
                </DrawerTitle>
                <DrawerDescription className={standardDialogDescriptionClass}>
                  Review waiting actions and jump back into active sessions.
                </DrawerDescription>
              </DrawerHeader>
              <div className="grid gap-3 p-4">
                <div className="rounded-[8px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-3">
                  <p className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">
                    Approval required
                  </p>
                  <p className="m-0 mt-1 text-[11px] leading-5 text-[var(--text-secondary)]">
                    The drawer owns the edge motion while the content keeps the
                    local product layout.
                  </p>
                </div>
              </div>
              <DrawerFooter className="border-t border-[var(--border-1)]">
                <DrawerClose asChild>
                  <Button
                    variant="ghost"
                    size="dialog"
                    className={standardGhostButtonClass}
                  >
                    Close
                  </Button>
                </DrawerClose>
              </DrawerFooter>
            </DrawerContent>
          </Drawer>
        </ExampleCard>
      </div>
    </DocsSection>
  );
}

function ToastStoryboard() {
  if (!hasStoryboard("ToastRoot")) {
    return null;
  }

  return (
    <DocsSection
      id="toast"
      title="Toast"
      description="用于短时反馈，支持默认和危险语义，实际应用中由 ToastProvider 管理"
      componentId={metadataFor("ToastRoot")?.id}
    >
      <div className="grid gap-1 lg:grid-cols-2">
        <ExampleCard title="Default Toast" description="保存、同步和轻量反馈">
          <div className="flex min-h-[88px] items-start justify-center pt-4">
            <div
              className={`${standardToastClass} flex min-h-8 max-w-[min(92vw,420px)] items-center justify-center rounded-[8px] px-3 py-1.5 text-center text-[13px] font-normal leading-normal shadow-none`}
              role="status"
            >
              <span className="flex min-w-0 flex-col items-center justify-center whitespace-normal break-words text-center">
                <span>Toast text</span>
              </span>
            </div>
          </div>
        </ExampleCard>
        <ExampleCard title="Destructive Toast" description="失败与风险提醒">
          <div className="flex min-h-[88px] items-start justify-center pt-4">
            <div
              className={`${standardToastDestructiveClass} flex min-h-8 max-w-[min(92vw,420px)] items-center justify-center rounded-[8px] px-3 py-1.5 text-center text-[13px] font-normal leading-normal shadow-none`}
              role="alert"
            >
              <span className="flex min-w-0 max-w-full flex-col items-center justify-center whitespace-normal break-words text-center">
                <span className="inline-flex max-w-full items-center justify-center gap-[6px]">
                  <FailedFilledIcon className="size-4 shrink-0 text-current" />
                  <span className="min-w-0 break-words">Upload failed</span>
                </span>
                <span className="text-[11px] font-normal leading-[1.3] text-current opacity-75">
                  The selected file could not be written to the workspace
                </span>
              </span>
            </div>
          </div>
        </ExampleCard>
        <ExampleCard title="Success Toast" description="完成与成功反馈">
          <div className="flex min-h-[88px] items-start justify-center pt-4">
            <div
              className={`${standardToastSuccessClass} flex min-h-8 max-w-[min(92vw,420px)] items-center justify-center rounded-[8px] px-3 py-1.5 text-center text-[13px] font-normal leading-normal shadow-none`}
              role="status"
            >
              <span className="flex min-w-0 max-w-full flex-col items-center justify-center whitespace-normal break-words text-center">
                <span className="inline-flex max-w-full items-center justify-center gap-[6px]">
                  <SuccessFilledIcon className="size-4 shrink-0 text-current" />
                  <span className="min-w-0 break-words">Workspace synced</span>
                </span>
              </span>
            </div>
          </div>
        </ExampleCard>
        <ExampleCard title="Loading Toast" description="长任务进行中反馈">
          <div className="flex min-h-[88px] items-start justify-center pt-4">
            <div
              className={`${standardToastClass} flex min-h-8 max-w-[min(92vw,420px)] items-center justify-center rounded-[8px] px-3 py-1.5 text-center text-[13px] font-normal leading-normal shadow-none`}
              role="status"
              aria-busy="true"
            >
              <span className="flex min-w-0 max-w-full flex-col items-center justify-center whitespace-normal break-words text-center">
                <span className="inline-flex max-w-full items-center justify-center gap-[6px]">
                  <Spinner
                    className="shrink-0 text-current"
                    size={16}
                    strokeWidth={2.5}
                    trackColor="color-mix(in srgb, currentColor 28%, transparent)"
                  />
                  <span className="min-w-0 break-words">Syncing workspace</span>
                </span>
              </span>
            </div>
          </div>
        </ExampleCard>
      </div>
    </DocsSection>
  );
}

function SonnerStoryboard() {
  if (!hasStoryboard("Toaster")) {
    return null;
  }

  return (
    <DocsSection
      id="sonner"
      title="Sonner"
      description="用于较长停留、右上角展示、带动作按钮的通知提示"
      componentId={metadataFor("Toaster")?.id}
    >
      <Toaster />
      <div className="grid gap-1 lg:grid-cols-2">
        <ExampleCard
          title="Action Notification"
          description="需要用户介入的流程提醒"
        >
          <div className="flex min-h-[128px] items-center justify-center">
            <Button
              type="button"
              variant="secondary"
              className={standardSecondaryButtonClass}
              onClick={() => {
                toast.info("Agent needs your decision", {
                  description: "Review the waiting session in Agent messages.",
                  duration: 10000,
                  action: {
                    label: "Review",
                    onClick: () => undefined
                  }
                });
              }}
            >
              Show notification
            </Button>
          </div>
        </ExampleCard>
        <ExampleCard
          title="Notification Surface"
          description="静态校准边界、文字和动作布局"
        >
          <div className="flex min-h-[128px] items-start justify-end p-4">
            <div
              className="grid w-[min(360px,100%)] gap-1.5 rounded-[8px] border border-[var(--line-2)] bg-[var(--background-fronted)] p-3 text-left text-[var(--text-primary)] shadow-[0_14px_40px_var(--shadow-elevated)]"
              role="status"
            >
              <div className="flex min-w-0 items-start gap-2">
                <WarningLinedIcon className="mt-0.5 size-4 shrink-0 text-[var(--accent)]" />
                <div className="min-w-0 flex-1">
                  <p className="m-0 text-[13px] font-medium leading-5 text-[var(--text-primary)]">
                    Agent needs your decision
                  </p>
                  <p className="m-0 mt-0.5 text-[11px] leading-[1.3] text-[var(--text-secondary)]">
                    Review the waiting session in Agent messages.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className={`${standardPrimaryButtonClass} h-7 px-2.5 text-[11px]`}
                >
                  Review
                </Button>
              </div>
            </div>
          </div>
        </ExampleCard>
      </div>
    </DocsSection>
  );
}

function IconsStoryboard() {
  if (iconStories.length === 0) {
    return null;
  }

  return (
    <DocsSection
      id="icons"
      title="Icons"
      description="系统图标统一通过 ui-system 导出，业务侧不直接依赖 lucide-react"
    >
      <ExampleCard title="Icon Inventory" description="当前公开导出的图标组件">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {iconStories.map(({ id, name, Icon }) => (
            <div
              key={id}
              className={`flex min-h-28 flex-col justify-between p-3 ${standardSurfacePanelClass}`}
            >
              <Icon className="size-5 text-[var(--text-primary)]" />
              <div className="mt-3 space-y-2">
                <span className="block break-words text-[11px] leading-4 text-[rgba(43,43,43,0.50)]">
                  {name}
                </span>
                <ComponentIdBadge id={id} />
              </div>
            </div>
          ))}
        </div>
      </ExampleCard>
    </DocsSection>
  );
}

function IconButton({
  ariaLabel,
  className = "",
  children
}: {
  ariaLabel: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Button
      aria-label={ariaLabel}
      variant="secondary"
      size="icon"
      className={`${standardSecondaryButtonClass} p-0 text-[var(--text-primary)] ${className}`}
    >
      {children}
    </Button>
  );
}

export function App() {
  const [language, setLanguage] =
    useState<StoryboardLanguage>(readStoredLanguage);
  const [themeMode, setThemeMode] =
    useState<StoryboardThemeMode>(readStoredTheme);
  const sectionIds = sections.map((section) => section.id);
  const { activeId: activeSection, navigateTo } = useActiveSection(sectionIds);
  const themeVars = useMemo(
    () => getStoryboardThemeVars(themeMode),
    [themeMode]
  );
  const copy = storyboardCopy[language];
  const localizedNavigationGroups = useMemo(
    () =>
      navigationGroups.map((group) => ({
        ...group,
        label: navigationGroupLabel(group.id, language),
        sections: group.sections.map((section) =>
          localizedSection(section, language)
        )
      })),
    [language]
  );

  useEffect(() => {
    for (const [name, value] of Object.entries(themeVars)) {
      document.documentElement.style.setProperty(name, String(value));
    }
    document.documentElement.dataset.theme = themeMode;
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    window.localStorage.setItem(storyboardThemeStorageKey, themeMode);
    window.localStorage.setItem(storyboardLanguageStorageKey, language);
  }, [language, themeMode, themeVars]);

  return (
    <div
      className="min-h-screen bg-[var(--background-1)] font-[var(--font-ui)] text-[var(--storyboard-ink)] transition-colors duration-200"
      data-storyboard-language={language}
      data-storyboard-theme={themeMode}
      style={themeVars}
    >
      <style>{storyboardDarkThemeOverrideCss}</style>
      <div className="mx-auto flex max-w-[1480px] px-4 sm:px-6 lg:px-8">
        <aside className="sticky top-0 hidden h-screen w-[220px] shrink-0 overflow-y-auto border-r border-[var(--border-1)] py-10 pr-7 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden xl:block">
          <div className="mb-10 text-[28px] font-semibold leading-none tracking-normal text-[var(--storyboard-ink)]">
            Tutti
          </div>
          <nav className="space-y-5" aria-label={copy.ariaNavigation}>
            {localizedNavigationGroups.map((group) => (
              <div key={group.id}>
                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-normal text-[var(--text-tertiary)]">
                  {group.label}
                </p>
                <div className="space-y-0.5">
                  {group.sections.map((section) => (
                    <a
                      key={section.id}
                      href={`#${section.id}`}
                      onClick={() => navigateTo(section.id)}
                      className={`block border-l-2 py-1.5 pl-3 text-[13px] transition-colors ${
                        activeSection === section.id
                          ? "border-[var(--text-primary)] font-medium text-[var(--text-primary)]"
                          : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                      }`}
                      title={section.summary}
                    >
                      {section.label}
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 space-y-16 py-10 xl:pl-10">
          <header className="flex flex-col gap-6 border-b border-[var(--border-1)] pb-10 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <h1 className="text-[clamp(36px,6vw,72px)] font-semibold leading-[0.95] tracking-normal text-[var(--storyboard-ink)]">
                {copy.title}
              </h1>
              <p className="mt-4 max-w-2xl text-[13px] leading-5 text-[var(--text-secondary)]">
                {copy.subtitle}
              </p>
            </div>
            <StoryboardControls
              language={language}
              themeMode={themeMode}
              onLanguageChange={setLanguage}
              onThemeChange={setThemeMode}
            />
          </header>

          <OverviewSection language={language} />
          <ColorsSection language={language} />
          <TypographySection language={language} />
          <MetricsSection language={language} />
          {hasBaseStories ? (
            <StoryLayerHeading
              title={copy.baseLayerTitle}
              description={copy.baseLayerDescription}
            />
          ) : null}
          <BadgeStoryboard />
          <ButtonStoryboard />
          <CheckboxStoryboard />
          <ComboboxStoryboard />
          <DialogStoryboard />
          <DrawerStoryboard />
          <IconsStoryboard />
          <InputStoryboard />
          <MentionPillStoryboard />
          <PopoverStoryboard />
          <RadioIndicatorStoryboard />
          <ResizableStoryboard />
          <SelectStoryboard />
          <ShortcutBadgeStoryboard />
          <SpinnerStoryboard />
          <SortableStoryboard />
          <StatusDotStoryboard />
          <SwitchStoryboard />
          <TextareaStoryboard />
          <SonnerStoryboard />
          <ToastStoryboard />
          <TooltipStoryboard />
          <UnderlineTabsStoryboard />
          <MenuSurfaceStoryboard />
          <ViewportMenuSurfaceStoryboard />
          {hasBusinessStories ? (
            <StoryLayerHeading
              title={copy.businessLayerTitle}
              description={copy.businessLayerDescription}
            />
          ) : null}
        </main>
      </div>
    </div>
  );
}
