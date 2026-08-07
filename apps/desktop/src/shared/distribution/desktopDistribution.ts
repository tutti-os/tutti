export type DesktopDistribution = "direct" | "store";

export interface DesktopDistributionInput {
  platform: NodeJS.Platform;
  windowsStore?: boolean;
}

export function resolveDesktopDistribution(
  input: DesktopDistributionInput
): DesktopDistribution {
  return input.platform === "win32" && input.windowsStore === true
    ? "store"
    : "direct";
}

export function resolveDesktopManualDownloadUrl(input: {
  channel: "rc" | "stable";
  distribution: DesktopDistribution;
  platform: NodeJS.Platform;
}): string {
  if (input.platform === "win32") {
    const channel = input.distribution === "store" ? "stable" : input.channel;
    const directQuery =
      input.distribution === "direct" ? "&distribution=direct&format=exe" : "";
    return `https://tutti.sh/desktop/download?channel=${channel}&platform=windows&arch=x64${directQuery}`;
  }

  const channel = input.channel === "rc" ? "preview" : "stable";
  return `https://tutti.sh/desktop/download?channel=${channel}&platform=macos&arch=universal&format=dmg`;
}
