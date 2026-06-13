import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function readComponentSource(fileName: string) {
  const relativePath =
    fileName === "index.ts"
      ? fileName
      : `./${fileName.replace(/\.tsx$/, "")}/${fileName}`;

  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function readMetadataIds() {
  const metadataPath = new URL("../metadata/components.json", import.meta.url);
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
    components: Array<{ id: string }>;
  };

  return new Set(metadata.components.map((component) => component.id));
}

test("promoted base primitives export from the shared component barrel", () => {
  const indexSource = readComponentSource("index.ts");

  for (const exportLine of [
    'export * from "./checkbox";',
    'export * from "./bare-icon-button";',
    'export * from "./switch";',
    'export * from "./tooltip";',
    'export * from "./popover";',
    'export * from "./textarea";',
    'export * from "./shortcut-badge";',
    'export * from "./spinner";',
    'export * from "./sonner";',
    'export * from "./mention-pill";',
    'export * from "./section-tabs";'
  ]) {
    assert.match(
      indexSource,
      new RegExp(exportLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
  }
});

test("promoted base primitives register stable ui-system metadata ids", () => {
  const metadataIds = readMetadataIds();

  for (const id of [
    "checkbox",
    "bare-icon-button",
    "switch",
    "tooltip",
    "tooltip-provider",
    "tooltip-trigger",
    "tooltip-content",
    "tooltip-portal",
    "popover",
    "popover-trigger",
    "popover-content",
    "popover-anchor",
    "popover-portal",
    "popover-close",
    "textarea",
    "shortcut-badge",
    "spinner",
    "toaster",
    "sonner-toast",
    "mention-pill",
    "section-tabs"
  ]) {
    assert.equal(metadataIds.has(id), true, `missing metadata id ${id}`);
  }
});

test("promoted base primitive sources stay on the shared workbench contract", () => {
  const buttonSource = readComponentSource("button.tsx");
  assert.match(buttonSource, /data-slot="button"/);
  assert.match(buttonSource, /React\.forwardRef<HTMLButtonElement/);
  assert.match(buttonSource, /ref=\{ref\}/);
  assert.match(buttonSource, /cursor-pointer/);
  assert.match(buttonSource, /h-8 gap-\[6px\]/);
  assert.match(
    buttonSource,
    /\[&_svg\[data-icon=inline-start\]:not\(\[class\*='size-'\]\)\]:size-3\.5/
  );
  assert.match(
    buttonSource,
    /\[&_svg\[data-icon=inline-start\]:not\(\[class\*='size-'\]\)\]:size-3/
  );
  assert.match(
    buttonSource,
    /\[&_svg\[data-icon=inline-start\]:not\(\[class\*='size-'\]\)\]:size-2\.5/
  );
  assert.doesNotMatch(buttonSource, /h-8 gap-2/);

  const bareIconButtonSource = readComponentSource("bare-icon-button.tsx");
  assert.match(bareIconButtonSource, /data-slot="bare-icon-button"/);
  assert.match(bareIconButtonSource, /React\.forwardRef<HTMLButtonElement/);
  assert.match(bareIconButtonSource, /ref=\{ref\}/);

  const checkboxSource = readComponentSource("checkbox.tsx");
  assert.match(checkboxSource, /data-slot="checkbox"/);
  assert.match(checkboxSource, /data-\[state=checked\]/);
  assert.match(checkboxSource, /--text-primary/);
  assert.match(checkboxSource, /--text-disabled/);
  assert.match(checkboxSource, /--transparency-block/);
  assert.match(checkboxSource, /--border-focus/);
  assert.match(checkboxSource, /--state-danger/);
  assert.match(checkboxSource, /disabled:border-\[var\(--border-1\)\]/);
  assert.match(checkboxSource, /data-disabled:border-\[var\(--border-1\)\]/);
  assert.doesNotMatch(checkboxSource, /border-border/);
  assert.doesNotMatch(checkboxSource, /bg-muted/);
  assert.doesNotMatch(checkboxSource, /ring-destructive/);
  assert.doesNotMatch(checkboxSource, /--workbench-field-bg/);
  assert.doesNotMatch(
    checkboxSource,
    /disabled:border-\[var\(--text-disabled\)\]/
  );
  assert.doesNotMatch(checkboxSource, /data-\[state=checked\]:bg-primary/);

  const switchSource = readComponentSource("switch.tsx");
  assert.match(switchSource, /data-slot="switch"/);
  assert.match(switchSource, /data-\[state=checked\]/);
  assert.match(switchSource, /--tutti-purple/);
  assert.doesNotMatch(switchSource, /--accent/);
  assert.match(switchSource, /--text-disabled/);
  assert.match(switchSource, /--border-focus/);
  assert.match(switchSource, /--state-danger/);
  assert.match(switchSource, /--white-stationary/);
  assert.doesNotMatch(switchSource, /bg-input/);
  assert.doesNotMatch(switchSource, /focus-visible:border-border/);
  assert.doesNotMatch(switchSource, /ring-destructive/);
  assert.doesNotMatch(
    switchSource,
    /dark:data-\[state=.*\]:bg-(primary-foreground|foreground)/
  );

  const tooltipSource = readComponentSource("tooltip.tsx");
  assert.match(tooltipSource, /data-slot="tooltip-content"/);
  assert.match(tooltipSource, /sideOffset = 8/);
  assert.doesNotMatch(tooltipSource, /sideOffset = 24/);
  assert.match(tooltipSource, /gap-2/);
  assert.match(tooltipSource, /px-2/);
  assert.match(tooltipSource, /py-1/);
  assert.match(tooltipSource, /text-\[13px\]/);
  assert.match(tooltipSource, /leading-\[1\.3\]/);
  assert.match(tooltipSource, /--border-1/);
  assert.match(tooltipSource, /--background-fronted/);
  assert.match(tooltipSource, /zIndex:\s*"var\(--z-tooltip,\s*100700\)"/);
  assert.doesNotMatch(tooltipSource, /z-50/);
  assert.doesNotMatch(tooltipSource, /px-2\.5/);
  assert.doesNotMatch(tooltipSource, /py-2/);
  assert.doesNotMatch(tooltipSource, /border-border\/70/);
  assert.doesNotMatch(tooltipSource, /bg-popover/);

  const mentionPillSource = readComponentSource("mention-pill.tsx");
  assert.match(mentionPillSource, /data-slot="mention-pill"/);
  assert.match(mentionPillSource, /--rich-text-mention-issue/);
  assert.match(mentionPillSource, /--rich-text-mention-session/);
  assert.match(mentionPillSource, /--folder/);
  assert.match(mentionPillSource, /iconUrl\?: string \| null/);
  assert.match(mentionPillSource, /src=\{normalizedIconUrl\}/);
  assert.match(mentionPillSource, /--rich-text-folder/);
  assert.match(mentionPillSource, /const iconSizeClassName = "size-4"/);
  assert.match(mentionPillSource, /isFile \? "size-4" : "size-\[18px\]"/);
  assert.match(mentionPillSource, /top-\[3px\]/);
  assert.match(mentionPillSource, /data-agent-mention-kind/);
  assert.match(mentionPillSource, /removable &&/);
  assert.match(mentionPillSource, /group-hover:opacity-0/);
  assert.doesNotMatch(
    mentionPillSource,
    /app: "var\(--rich-text-mention-app\)"/
  );
  assert.match(mentionPillSource, /app: "var\(--rich-text-folder\)"/);

  const sectionTabsSource = readComponentSource("section-tabs.tsx");
  assert.match(sectionTabsSource, /data-slot="section-tabs"/);
  assert.match(sectionTabsSource, /data-slot="section-tabs-tab"/);
  assert.match(sectionTabsSource, /role="tablist"/);
  assert.match(sectionTabsSource, /role="tab"/);
  assert.match(sectionTabsSource, /aria-selected=\{isActive\}/);
  assert.match(sectionTabsSource, /text-\[15px\]/);
  assert.match(sectionTabsSource, /font-semibold/);

  const popoverSource = readComponentSource("popover.tsx");
  assert.match(popoverSource, /data-slot="popover-content"/);
  assert.match(popoverSource, /t-dropdown/);
  assert.match(popoverSource, /--border-1/);
  assert.match(popoverSource, /--background-fronted/);
  assert.match(popoverSource, /p-3/);
  assert.doesNotMatch(popoverSource, /border-border\/70/);
  assert.doesNotMatch(popoverSource, /bg-popover/);
  assert.doesNotMatch(popoverSource, /data-open:animate-in/);
  assert.doesNotMatch(popoverSource, /data-closed:animate-out/);
  assert.doesNotMatch(popoverSource, /\sp-2\.5\s/);

  const menuSurfaceSource = readComponentSource("menu-surface.tsx");
  assert.match(menuSurfaceSource, /t-dropdown/);
  assert.match(menuSurfaceSource, /--border-1/);
  assert.match(menuSurfaceSource, /--background-fronted/);
  assert.match(menuSurfaceSource, /menuItemClassName/);
  assert.match(menuSurfaceSource, /menuItemWithIndicatorClassName/);
  assert.match(menuSurfaceSource, /menuItemIndicatorClassName/);
  assert.match(menuSurfaceSource, /cursor-pointer/);
  assert.match(menuSurfaceSource, /--transparency-hover/);
  assert.match(menuSurfaceSource, /--text-primary/);
  const baseStylesSource = readFileSync(
    new URL("../styles/base.css", import.meta.url),
    "utf8"
  );
  assert.match(baseStylesSource, /button:not\(:disabled\)/);
  assert.match(baseStylesSource, /cursor: pointer/);
  assert.match(baseStylesSource, /@keyframes tutti-dropdown-open/);
  assert.match(baseStylesSource, /@keyframes tutti-dropdown-close/);
  assert.match(baseStylesSource, /--dropdown-open-dur/);
  assert.match(baseStylesSource, /--dropdown-close-dur/);
  assert.match(baseStylesSource, /--dropdown-pre-scale/);
  assert.match(baseStylesSource, /--dropdown-closing-scale/);
  assert.match(baseStylesSource, /--dropdown-ease/);
  assert.match(baseStylesSource, /prefers-reduced-motion/);

  const selectSource = readComponentSource("select.tsx");
  assert.match(selectSource, /MenuSurface/);
  assert.match(selectSource, /asChild/);
  assert.match(selectSource, /data-slot="select-content"/);
  assert.match(selectSource, /data-slot="select-split-layout"/);
  assert.match(
    selectSource,
    /grid-cols-\[minmax\(0,1fr\)_1px_minmax\(104px,132px\)\]/
  );
  assert.match(selectSource, /data-slot="select-split-divider"/);
  assert.match(selectSource, /--border-2,var\(--border-1\)/);
  assert.match(selectSource, /data-slot="select-split-column-items"/);
  assert.match(selectSource, /--background-fronted/);
  assert.match(selectSource, /--text-primary/);
  assert.match(selectSource, /--text-secondary/);
  assert.match(selectSource, /--text-placeholder/);
  assert.match(selectSource, /cursor-pointer/);
  assert.match(selectSource, /menuItemWithIndicatorClassName/);
  assert.match(selectSource, /menuItemIndicatorClassName/);
  assert.doesNotMatch(selectSource, /bg-popover/);
  assert.doesNotMatch(selectSource, /text-popover-foreground/);
  assert.doesNotMatch(selectSource, /text-foreground/);
  assert.doesNotMatch(selectSource, /text-muted-foreground/);
  assert.doesNotMatch(selectSource, /rounded-md py-1 pr-9 pl-3/);
  assert.doesNotMatch(selectSource, /data-\[state=checked\]:bg-transparent/);
  assert.doesNotMatch(selectSource, /data-\[state=open\]:animate-in/);

  const dialogSource = readComponentSource("dialog.tsx");
  assert.match(dialogSource, /data-slot="dialog-description"/);
  assert.match(dialogSource, /font-\[400\]/);
  assert.match(dialogSource, /leading-\[1\.3\]/);
  assert.doesNotMatch(
    dialogSource,
    /dialog-description"[\s\S]*font-(?:medium|semibold)/
  );
  assert.doesNotMatch(dialogSource, /leading-\[1\.45\]/);

  const toastSource = readComponentSource("toast.tsx");
  assert.match(toastSource, /data-slot="toast-description"/);
  assert.match(toastSource, /box-border w-full px-2/);
  assert.match(toastSource, /\[overflow-wrap:anywhere\]/);
  assert.match(toastSource, /leading-\[1\.3\]/);
  assert.match(toastSource, /min-h-8/);
  assert.match(toastSource, /rounded-\[8px\]/);
  assert.match(toastSource, /px-3/);
  assert.match(toastSource, /--toast-neutral-bg/);
  assert.match(toastSource, /--toast-neutral-fg/);
  assert.match(toastSource, /--toast-neutral-border/);
  assert.match(toastSource, /--state-danger/);
  assert.match(toastSource, /--state-success/);
  assert.match(toastSource, /--white-stationary/);
  assert.match(
    toastSource,
    /bg-\[var\(--state-danger\)\]\s+text-\[var\(--white-stationary\)\]/
  );
  assert.match(
    toastSource,
    /bg-\[var\(--state-success\)\]\s+text-\[var\(--text-inverted\)\]/
  );
  assert.match(toastSource, /busy/);
  assert.match(toastSource, /SuccessFilledIcon/);
  assert.match(toastSource, /FailedFilledIcon/);
  assert.match(
    toastSource,
    /trackColor="color-mix\(in srgb, currentColor 28%, transparent\)"/
  );
  assert.match(toastSource, /stripToastTrailingSentencePunctuation/);

  const cardSource = readComponentSource("card.tsx");
  assert.match(cardSource, /data-slot="card-description"/);
  assert.match(cardSource, /leading-\[1\.3\]/);

  const inputSource = readComponentSource("input.tsx");
  assert.match(inputSource, /data-slot="input"/);
  assert.match(inputSource, /aria-invalid:border-\[var\(--state-danger\)\]/);
  assert.match(inputSource, /aria-invalid:ring-0/);
  assert.match(inputSource, /aria-invalid:shadow-none/);
  assert.doesNotMatch(inputSource, /aria-invalid:border-destructive/);
  assert.doesNotMatch(inputSource, /aria-invalid:ring-3/);
  assert.doesNotMatch(inputSource, /aria-invalid:ring-destructive/);

  const textareaSource = readComponentSource("textarea.tsx");
  assert.match(textareaSource, /data-slot="textarea"/);
  assert.match(textareaSource, /bg-\[var\(--transparency-block\)\]/);
  assert.match(textareaSource, /px-3 py-3/);
  assert.match(textareaSource, /text-\[13px\]/);
  assert.match(textareaSource, /leading-\[1\.3\]/);
  assert.match(textareaSource, /text-\[var\(--text-primary\)\]/);
  assert.match(
    textareaSource,
    /placeholder:text-\[var\(--text-placeholder\)\]/
  );
  assert.match(textareaSource, /disabled:text-\[var\(--text-disabled\)\]/);
  assert.match(textareaSource, /aria-invalid:border-\[var\(--state-danger\)\]/);
  assert.match(textareaSource, /aria-invalid:ring-0/);
  assert.match(textareaSource, /aria-invalid:shadow-none/);
  assert.doesNotMatch(textareaSource, /aria-invalid:ring-2/);
  assert.doesNotMatch(textareaSource, /state-danger\)_35%/);
  assert.doesNotMatch(textareaSource, /--workbench-field-bg/);
  assert.doesNotMatch(textareaSource, /placeholder:text-muted-foreground/);

  const spinnerSource = readComponentSource("spinner.tsx");
  assert.match(spinnerSource, /data-slot="spinner"/);
  assert.match(spinnerSource, /animate-spin/);
  assert.match(spinnerSource, /LoadingIcon/);
  assert.match(spinnerSource, /trackColor/);

  const systemIconsSource = readFileSync(
    new URL("../icons/system-icons.tsx", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(systemIconsSource, /lucide-react/);
  assert.doesNotMatch(systemIconsSource, /createLucideIcon/);
  assert.match(systemIconsSource, /function SvgIcon/);
});
