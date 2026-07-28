import { Avatar } from "@tutti-os/ui-system";

interface AgentGUIOwnerAvatarProps {
  className: string;
  iconUrl: string;
  imageClassName?: string;
  label?: string | null;
}

export function AgentGUIOwnerAvatar({
  className,
  iconUrl,
  imageClassName,
  label
}: AgentGUIOwnerAvatarProps): React.JSX.Element {
  const ownerLabel = label?.trim() || "?";

  return (
    <span
      aria-hidden="true"
      className={className}
      data-agent-owner-badge="true"
    >
      <Avatar
        aria-hidden="true"
        imageClassName={imageClassName}
        label={ownerLabel}
        size="md"
        src={iconUrl}
        style={{ height: "100%", width: "100%" }}
      />
    </span>
  );
}
