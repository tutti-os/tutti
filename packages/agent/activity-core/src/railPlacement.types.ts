export type AgentActivityRailPlacement =
  | {
      version: 1;
      kind: "conversations";
      sectionKey: "conversations";
      projectPath?: never;
    }
  | {
      version: 1;
      kind: "project";
      projectPath: string;
      sectionKey: string;
    };
