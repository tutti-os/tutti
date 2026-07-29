export interface AgentActivitySessionCapabilities {
  imageInput: boolean;
  modelImageInputRequired: boolean;
  modelPlanBinding: boolean;
  skills: boolean;
  compact: boolean;
  tokenUsage: boolean;
  rateLimits: boolean;
  planMode: boolean;
  interrupt: boolean;
  modelSwitch: boolean;
  activeTurnGuidance: boolean;
  browserUse: boolean;
  computerUse: boolean;
  goalPause: boolean;
  planImplementation: boolean;
  permissionModeChangeDuringTurn: boolean;
  permissionModeChangeDeferred: boolean;
  review: boolean;
  resumeRunningTurn: boolean;
}
