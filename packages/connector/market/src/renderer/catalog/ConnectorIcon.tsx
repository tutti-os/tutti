import {
  GitHubBrandIcon,
  GoogleBrandIcon,
  ToolsIcon
} from "@tutti-os/ui-system/icons";

export function ConnectorIcon({
  connectorKey,
  displayName,
  size = "md"
}: {
  connectorKey: string;
  displayName: string;
  size?: "lg" | "md";
}) {
  const iconClassName = size === "lg" ? "size-8" : "size-5";
  const wrapperClassName =
    size === "lg"
      ? "flex size-12 items-center justify-center rounded-xl bg-[var(--transparency-block)]"
      : "flex size-10 items-center justify-center rounded-lg bg-[var(--transparency-block)]";
  const normalizedKey = connectorKey.toLocaleLowerCase();
  const icon = normalizedKey.includes("github") ? (
    <GitHubBrandIcon className={iconClassName} />
  ) : normalizedKey.includes("google") ? (
    <GoogleBrandIcon className={iconClassName} />
  ) : (
    <ToolsIcon className={iconClassName} />
  );

  return (
    <span aria-label={displayName} className={wrapperClassName} role="img">
      {icon}
    </span>
  );
}
