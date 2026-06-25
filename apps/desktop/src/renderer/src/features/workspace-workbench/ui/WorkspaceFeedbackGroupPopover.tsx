import { forwardRef, useCallback, type ComponentPropsWithoutRef } from "react";
import {
  Button,
  DiscordIcon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  WeChatIcon
} from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService";

const FEEDBACK_GROUP_DISCORD_URL = "https://discord.gg/UUemKEWtw6";
const FEEDBACK_GROUP_QR_ZH_CN_SOURCE = new URL(
  "../../../assets/feedback-group-qr-zh-CN.png",
  import.meta.url
).href;

export function WorkspaceFeedbackGroupPopover() {
  const { locale, t } = useTranslation();
  const hostService = useWorkspaceWorkbenchHostService();
  const openDiscord = useCallback(() => {
    void hostService.openExternal(FEEDBACK_GROUP_DISCORD_URL);
  }, [hostService]);

  if (locale !== "zh-CN") {
    return <WorkspaceFeedbackGroupButton onClick={openDiscord} />;
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <WorkspaceFeedbackGroupButton />
      </PopoverTrigger>
      <PopoverContent
        align="center"
        className="w-auto gap-2 p-2 text-center"
        side="bottom"
        sideOffset={8}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
        }}
      >
        <div className="px-1 text-[13px] font-medium text-[var(--foreground-1)]">
          {t("workspace.feedbackGroup.instruction")}
        </div>
        {locale === "zh-CN" ? (
          <img
            alt={t("workspace.feedbackGroup.qrAlt")}
            className="size-40 rounded-[6px] border border-[var(--border-1)] bg-white p-2"
            draggable={false}
            src={FEEDBACK_GROUP_QR_ZH_CN_SOURCE}
          />
        ) : (
          <FeedbackGroupQrCode label={t("workspace.feedbackGroup.qrAlt")} />
        )}
      </PopoverContent>
    </Popover>
  );
}

const WorkspaceFeedbackGroupButton = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof Button>
>(function WorkspaceFeedbackGroupButton({ className, ...props }, ref) {
  const { locale, t } = useTranslation();
  const FeedbackGroupIcon = locale === "zh-CN" ? WeChatIcon : DiscordIcon;

  return (
    <Button
      ref={ref}
      aria-label={t("workspace.feedbackGroup.triggerAria")}
      className={[
        "cursor-pointer gap-1.5 rounded-[6px] border-transparent bg-transparent px-2.5 text-[13px] font-semibold text-[var(--workbench-chrome-foreground)] shadow-none hover:border-transparent hover:bg-transparent focus-visible:border-transparent focus-visible:bg-transparent active:bg-transparent aria-expanded:bg-transparent aria-expanded:text-[var(--workbench-chrome-foreground)]",
        className
      ]
        .filter(Boolean)
        .join(" ")}
      size="sm"
      title={t("workspace.feedbackGroup.trigger")}
      type="button"
      variant="ghost"
      {...props}
    >
      <FeedbackGroupIcon className="size-5 shrink-0" size={20} />
      <span>{t("workspace.feedbackGroup.trigger")}</span>
    </Button>
  );
});

function FeedbackGroupQrCode({ label }: { label: string }) {
  return (
    <div
      aria-label={label}
      className="relative size-40 rounded-[6px] border border-[var(--border-1)] bg-white p-2"
      role="img"
    >
      <div className="relative size-full">
        {EN_QR_BLOCKS.map(([x, y, width, height], index) => (
          <span
            aria-hidden="true"
            className="absolute bg-[#111827]"
            key={`${x}-${y}-${width}-${height}-${index}`}
            style={{
              height: `${height}%`,
              left: `${x}%`,
              top: `${y}%`,
              width: `${width}%`
            }}
          />
        ))}
      </div>
    </div>
  );
}

type QrBlock = readonly [x: number, y: number, width: number, height: number];

const QR_FINDER_BLOCKS = [
  [0, 0, 31, 31],
  [5.5, 5.5, 20, 20],
  [11, 11, 9, 9],
  [69, 0, 31, 31],
  [74.5, 5.5, 20, 20],
  [80, 11, 9, 9],
  [0, 69, 31, 31],
  [5.5, 74.5, 20, 20],
  [11, 80, 9, 9]
] as const satisfies readonly QrBlock[];

const EN_QR_BLOCKS = [
  ...QR_FINDER_BLOCKS,
  [39, 0, 6, 6],
  [50, 0, 6, 11],
  [39, 11, 11, 6],
  [45, 22, 6, 6],
  [39, 39, 6, 11],
  [50, 39, 11, 6],
  [67, 45, 6, 11],
  [78, 45, 22, 6],
  [34, 56, 11, 6],
  [50, 56, 6, 6],
  [62, 56, 11, 6],
  [94, 56, 6, 11],
  [39, 67, 6, 6],
  [50, 67, 17, 6],
  [73, 67, 6, 11],
  [39, 78, 11, 6],
  [56, 78, 6, 22],
  [67, 84, 11, 6],
  [94, 78, 6, 22],
  [34, 94, 17, 6],
  [42, 42, 6, 6],
  [53, 48, 6, 6],
  [64, 48, 6, 6],
  [86, 62, 6, 6],
  [45, 73, 6, 6],
  [70, 73, 6, 6]
] as const satisfies readonly QrBlock[];
