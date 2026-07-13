import { cn, StatusDot } from "@tutti-os/ui-system";
import {
  MessageCenterIdentityAvatarMark,
  MessageCenterIdentityLabel,
  messageCenterStatusToneClass,
  type MessageCenterStatusTone
} from "./WorkspaceAgentMessageCenterCard";
import type { MessageCenterGroup } from "./workspaceAgentMessageCenterViewModel";

export function MessageCenterGroupHeading({
  group
}: {
  group: MessageCenterGroup;
}): React.JSX.Element {
  "use memo";
  const statusSignal = messageCenterGroupStatusSignal(group.id);

  if (group.provider) {
    return (
      <h3
        aria-label={`${group.label} · ${group.items.length}`}
        className="flex min-w-0 items-center gap-1.5 text-[11px] font-normal leading-4 text-[var(--text-tertiary)]"
        title={`${group.label} · ${group.items.length}`}
      >
        {group.identity ? (
          <MessageCenterIdentityLabel
            identity={group.identity}
            provider={group.provider}
          />
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <MessageCenterIdentityAvatarMark
              identity={null}
              provider={group.provider}
              userId={group.userId ?? null}
            />
            <span className="min-w-0 truncate">{group.label}</span>
          </span>
        )}
        <span className="shrink-0">· {group.items.length}</span>
      </h3>
    );
  }

  return (
    <h3
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-[11px] font-normal leading-4",
        statusSignal
          ? messageCenterStatusToneClass(statusSignal.tone)
          : "text-[var(--text-tertiary)]"
      )}
      title={`${group.label} · ${group.items.length}`}
    >
      {statusSignal ? (
        <StatusDot
          tone={statusSignal.tone}
          pulse={statusSignal.pulse}
          size="sm"
          title={group.label}
        />
      ) : null}
      <span className="min-w-0 truncate">
        {group.label} · {group.items.length}
      </span>
    </h3>
  );
}

function messageCenterGroupStatusSignal(groupId: string): {
  pulse: boolean;
  tone: Exclude<MessageCenterStatusTone, "neutral">;
} | null {
  switch (groupId) {
    case "needs-attention":
    case "waiting":
      return { pulse: true, tone: "amber" };
    case "working":
      return { pulse: true, tone: "blue" };
    case "failed":
      return { pulse: false, tone: "red" };
    case "recently-completed":
    case "completed":
      return { pulse: false, tone: "green" };
    default:
      return null;
  }
}
