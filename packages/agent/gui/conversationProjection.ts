/**
 * DOM-free conversation projections for alternate renderers such as Mobile.
 *
 * Consumers keep rendering, navigation, and interaction submission locally;
 * this entry owns only the canonical AgentGUI display semantics.
 */
export {
  projectAgentActivitySessionToConversationVM,
  type ProjectAgentActivitySessionConversationInput
} from "./shared/agentConversation/projection/workspaceAgentMessageProjection.ts";
export {
  reconcileProjectedAgentConversationVM,
  type AgentConversationProjectionOptions
} from "./shared/agentConversation/projection/agentConversationProjection.ts";
export {
  resolveAgentConversationNavigationAction,
  type AgentConversationNavigationAction
} from "./shared/agentConversation/actions/agentConversationNavigationActions.ts";
export { projectAgentConversationPromptFromInteraction } from "./shared/agentConversation/projection/agentInteractionPromptProjection.ts";
export type {
  AgentConversationPromptVM,
  AgentConversationVM
} from "./shared/agentConversation/contracts/agentConversationVM.ts";
