import type { DesktopAgentSessionStatusView } from "./desktopAgentSessionMentionProvider";

/**
 * Build a `resolveSessionStatusView` from the agent-app status normalization +
 * localized label functions, kept neutral (the agent-gui helpers are injected at
 * the desktop wiring seam) so the rich-text-at feature stays agent-app-free.
 *
 * Resolves a raw agent-session status into the display-ready activity status view
 * the session mention row renders, using the SAME normalization +
 * localized label the agent composer uses, so the session status badge matches
 * byte-for-byte across surfaces.
 */
export function createDesktopAgentSessionStatusViewResolver(input: {
  normalizeDisplayStatus: (status: string) => string;
  statusLabel: (dataStatus: string) => string;
}): (status: string) => DesktopAgentSessionStatusView | null {
  return (status: string) => {
    const dataStatus = input.normalizeDisplayStatus(status);
    return {
      dataStatus,
      label: input.statusLabel(dataStatus),
      pulse: dataStatus === "working" || dataStatus === "waiting"
    };
  };
}
