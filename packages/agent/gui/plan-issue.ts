// Cross-host facade for turning an Agent plan into a reviewable Issue draft.
// Parsing/projection helpers stay internal to AgentGUI so this entry point does
// not expose the package's timeline implementation as public API.
export { planIssueDraftFromPlanText } from "./shared/agentConversation/planImplementationPresentation.ts";
export type {
  PlanIssueCreationOptions,
  PlanIssueDraft
} from "./shared/agentConversation/planImplementationPresentation.ts";
