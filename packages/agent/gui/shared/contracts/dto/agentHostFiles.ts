export interface AgentHostRoomTreeInput {
  roomId?: string;
  path?: string;
  depth?: number;
}

export interface AgentHostRoomTreeNode {
  path: string;
  name: string;
  kind: "file" | "directory" | "unknown";
  hasChildren: boolean;
}

export interface AgentHostRoomTreeResult {
  roomId: string;
  root: string;
  nodes: AgentHostRoomTreeNode[];
}
