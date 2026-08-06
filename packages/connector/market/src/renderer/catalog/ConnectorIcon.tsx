export function ConnectorIcon({
  displayName,
  iconUrl,
  size = "md"
}: {
  displayName: string;
  iconUrl: string;
  size?: "lg" | "md";
}) {
  const iconClassName = size === "lg" ? "size-8" : "size-5";
  const wrapperClassName =
    size === "lg"
      ? "flex size-12 items-center justify-center rounded-xl bg-[var(--transparency-block)]"
      : "flex size-10 items-center justify-center rounded-lg bg-[var(--transparency-block)]";

  return (
    <span aria-label={displayName} className={wrapperClassName} role="img">
      <img alt="" className={`${iconClassName} object-contain`} src={iconUrl} />
    </span>
  );
}
