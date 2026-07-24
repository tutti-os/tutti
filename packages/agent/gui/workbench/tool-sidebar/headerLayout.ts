import type { ReactNode } from "react";

export interface AgentToolSidebarHeaderLayout {
  actions: ReactNode;
  isSidebarOpen: boolean;
  layoutWidthPx: number;
}

export interface AgentToolSidebarHeaderContract {
  layout: "overlay" | "stacked";
  owner: "host" | "window";
  render(layout: AgentToolSidebarHeaderLayout): ReactNode;
}
