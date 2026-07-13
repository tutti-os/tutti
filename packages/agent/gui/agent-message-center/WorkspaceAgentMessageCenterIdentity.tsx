import {
  cloneElement,
  useCallback,
  useEffect,
  useState,
  type FocusEvent as ReactFocusEvent,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode
} from "react";
import { ExternalLink, Info } from "lucide-react";
import {
  Button,
  cn,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@tutti-os/ui-system";
import { managedAgentRoundedIconUrl } from "../shared/managedAgentIcons";
import { workspaceAgentProviderLabel } from "../shared/workspaceAgentProviderLabel";
import { userAvatarPlaceholderUrl } from "../shared/userAvatarPlaceholder";
import {
  isWaitingMessageCenterItem,
  type WorkspaceAgentMessageCenterIdentity,
  type WorkspaceAgentMessageCenterItem
} from "./workspaceAgentMessageCenterModel";

export function MessageCenterOpenChatButton({
  actionsAccessory,
  alwaysVisible = false,
  item,
  label,
  onOpenChat,
  provider
}: {
  actionsAccessory?: ReactNode;
  alwaysVisible?: boolean;
  item: WorkspaceAgentMessageCenterItem;
  label: string;
  onOpenChat: (input: { agentSessionId: string; provider: string }) => void;
  provider: string;
}): JSX.Element {
  "use memo";

  return (
    <div className="workspace-agent-message-center__footer flex min-w-0 items-center justify-between gap-2">
      <MessageCenterIdentityLabel
        identity={item.identity}
        provider={provider}
      />
      <span className="inline-flex shrink-0 items-center gap-2">
        {actionsAccessory}
        <Button
          type="button"
          variant="ghost"
          size="default"
          className={cn(
            "workspace-agent-message-center__open-chat-button h-auto gap-1.5 border-0 bg-transparent p-0 text-[var(--accent-codex)] shadow-none transition-[color,opacity,visibility] hover:bg-transparent hover:text-[var(--accent-codex)] focus-visible:bg-transparent focus-visible:text-[var(--accent-codex)] active:bg-transparent",
            !alwaysVisible &&
              "invisible opacity-0 group-hover/message-card:visible group-hover/message-card:opacity-100 group-focus-within/message-card:visible group-focus-within/message-card:opacity-100"
          )}
          onClick={() =>
            onOpenChat({
              agentSessionId: item.agentSessionId,
              provider: item.provider
            })
          }
        >
          <ExternalLink
            className="size-[15px]"
            strokeWidth={2.2}
            aria-hidden="true"
          />
          {label}
        </Button>
      </span>
    </div>
  );
}

export function MessageCenterIdentityLabel({
  identity,
  provider
}: {
  identity: WorkspaceAgentMessageCenterIdentity | null;
  provider: string;
}): JSX.Element {
  "use memo";

  if (!identity) {
    return <AgentProviderLabel provider={provider} />;
  }

  const agentAvatarUrl =
    identity.agentAvatarUrl?.trim() || managedAgentRoundedIconUrl(provider);
  const title = `${identity.userName} & ${identity.agentName}`;

  return (
    <span
      className="workspace-agent-message-center__identity inline-flex min-w-0 max-w-full items-center gap-2"
      title={title}
    >
      <MessageCenterIdentityAvatarStack
        userAvatarUrl={identity.userAvatarUrl}
        userName={identity.userName}
        agentAvatarUrl={agentAvatarUrl}
      />
      <span className="workspace-agent-message-center__identity-names flex min-w-0 items-center gap-1 truncate text-[13px] leading-5 text-[var(--text-secondary)]">
        <span className="min-w-0 truncate">{identity.userName}</span>
        <span className="shrink-0 text-[var(--text-tertiary)]">&</span>
        <span className="min-w-0 truncate">{identity.agentName}</span>
      </span>
    </span>
  );
}

export function MessageCenterIdentityAvatarMark({
  identity,
  provider,
  userId
}: {
  identity: WorkspaceAgentMessageCenterIdentity | null;
  provider: string;
  userId?: string | null;
}): JSX.Element {
  "use memo";

  const userName = identity?.userName.trim() || userId?.trim() || "";
  if (!userName) {
    return (
      <img
        src={managedAgentRoundedIconUrl(provider)}
        alt=""
        className="size-5 shrink-0 rounded-full"
        decoding="async"
        loading="lazy"
        draggable={false}
        aria-hidden="true"
      />
    );
  }

  return (
    <MessageCenterIdentityAvatarStack
      userAvatarUrl={identity?.userAvatarUrl}
      userName={userName}
      agentAvatarUrl={
        identity?.agentAvatarUrl?.trim() || managedAgentRoundedIconUrl(provider)
      }
    />
  );
}

export function MessageCenterIdentityAvatarStack({
  agentAvatarUrl,
  userAvatarUrl: rawUserAvatarUrl,
  userName
}: {
  agentAvatarUrl: string;
  userAvatarUrl?: string;
  userName: string;
}): JSX.Element {
  "use memo";
  const [userAvatarFailed, setUserAvatarFailed] = useState(false);
  const userAvatarUrl = rawUserAvatarUrl?.trim() ?? "";
  const userImageUrl =
    userAvatarUrl.length > 0 && !userAvatarFailed
      ? userAvatarUrl
      : userAvatarPlaceholderUrl;

  useEffect(() => {
    setUserAvatarFailed(false);
  }, [userAvatarUrl]);

  return (
    <span
      className="workspace-agent-message-center__identity-avatar-stack inline-flex w-9 shrink-0 items-center"
      aria-hidden="true"
    >
      <span className="inline-flex size-5 shrink-0 overflow-hidden rounded-full bg-[var(--transparency-block)] ring-2 ring-[var(--background-fronted)]">
        <img
          src={userImageUrl}
          alt={userName}
          className="size-full object-cover"
          decoding="async"
          loading="lazy"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => {
            setUserAvatarFailed(true);
          }}
        />
      </span>
      <span className="-ml-1.5 inline-flex size-5 shrink-0 overflow-hidden rounded-full bg-[var(--transparency-block)] ring-2 ring-[var(--background-fronted)]">
        <img
          src={agentAvatarUrl}
          alt=""
          className="size-full object-cover"
          decoding="async"
          loading="lazy"
          draggable={false}
        />
      </span>
    </span>
  );
}

export function ProjectPathInfo({ path }: { path: string }): JSX.Element {
  "use memo";

  return (
    <LazyMessageCenterTooltip
      content={path}
      side="top"
      align="start"
      className="max-w-[320px] text-[11px] [overflow-wrap:anywhere]"
    >
      <button
        type="button"
        className="workspace-agent-message-center__project-info-button invisible inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-[var(--text-secondary)] opacity-0 transition-[background-color,color,opacity,visibility] group-hover/message-card:visible group-hover/message-card:opacity-100 group-focus-within/message-card:visible group-focus-within/message-card:opacity-100 hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:bg-[var(--transparency-hover)] focus-visible:text-[var(--text-primary)] focus-visible:outline-none"
        aria-label={path}
      >
        <Info className="size-3.5" strokeWidth={2} aria-hidden="true" />
      </button>
    </LazyMessageCenterTooltip>
  );
}

type LazyTooltipChildProps = {
  onBlur?: (event: ReactFocusEvent<HTMLElement>) => void;
  onFocus?: (event: ReactFocusEvent<HTMLElement>) => void;
  onPointerEnter?: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: ReactPointerEvent<HTMLElement>) => void;
};

export function LazyMessageCenterTooltip({
  align,
  children,
  className,
  content,
  side
}: {
  align?: "center" | "end" | "start";
  children: ReactElement<LazyTooltipChildProps>;
  className?: string;
  content: ReactNode;
  side?: "bottom" | "left" | "right" | "top";
}): JSX.Element {
  "use memo";
  const [hydrated, setHydrated] = useState(false);
  const [open, setOpen] = useState(false);

  const showTooltip = useCallback(() => {
    setHydrated(true);
    setOpen(true);
  }, []);
  const hideTooltip = useCallback(() => {
    setOpen(false);
  }, []);

  const trigger = cloneElement(children, {
    onBlur: (event: ReactFocusEvent<HTMLElement>) => {
      children.props.onBlur?.(event);
      hideTooltip();
    },
    onFocus: (event: ReactFocusEvent<HTMLElement>) => {
      children.props.onFocus?.(event);
      showTooltip();
    },
    onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => {
      children.props.onPointerEnter?.(event);
      showTooltip();
    },
    onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => {
      children.props.onPointerLeave?.(event);
      hideTooltip();
    }
  });

  if (!hydrated) {
    return trigger;
  }

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side={side} align={align} className={className}>
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

function AgentProviderLabel({ provider }: { provider: string }): JSX.Element {
  "use memo";
  const label = workspaceAgentProviderLabel(provider);

  return (
    <span className="workspace-agent-message-center__provider inline-flex min-w-0 max-w-full items-center gap-1.5">
      <img
        src={managedAgentRoundedIconUrl(provider)}
        alt=""
        className="workspace-agent-message-center__provider-icon size-5 shrink-0 rounded-full"
        decoding="async"
        loading="lazy"
        draggable={false}
        aria-hidden="true"
      />
      <span className="workspace-agent-message-center__provider-name min-w-0 truncate text-[13px] leading-5 text-[var(--text-secondary)]">
        {label}
      </span>
    </span>
  );
}

export function statusClass(item: WorkspaceAgentMessageCenterItem): string {
  if (isWaitingMessageCenterItem(item)) {
    return "waiting";
  }
  if (item.status === "idle") {
    return "completed";
  }
  return item.status;
}

export type MessageCenterStatusTone =
  | "amber"
  | "blue"
  | "green"
  | "neutral"
  | "red";

export function messageCenterStatusTone(
  item: WorkspaceAgentMessageCenterItem
): MessageCenterStatusTone {
  if (isWaitingMessageCenterItem(item)) {
    return "amber";
  }
  if (item.status === "completed" || item.status === "idle") {
    return "green";
  }
  if (item.status === "canceled") {
    return "amber";
  }
  if (item.status === "failed") {
    return "red";
  }
  if (item.status === "working") {
    return "blue";
  }
  return "neutral";
}

export function messageCenterStatusToneClass(
  tone: MessageCenterStatusTone
): string {
  switch (tone) {
    case "amber":
      return "text-[var(--state-warning)]";
    case "blue":
      return "text-[var(--status-running)]";
    case "green":
      return "text-[var(--state-success)]";
    case "red":
      return "text-[var(--state-danger)]";
    case "neutral":
      return "text-[var(--text-secondary)]";
  }
}
