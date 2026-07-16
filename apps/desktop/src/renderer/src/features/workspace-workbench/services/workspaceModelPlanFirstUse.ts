import type {
  WorkspaceAgentHarnessTargetOption,
  WorkspaceModelPlan
} from "./workspaceSettingsTypes";
import { modelPlanProtocolForAgentProvider } from "./workspaceModelPlanTemplates.ts";

export function compatibleWorkspaceModelPlanFirstUseTargets(input: {
  plan: Pick<WorkspaceModelPlan, "protocol">;
  targets: readonly WorkspaceAgentHarnessTargetOption[];
}): WorkspaceAgentHarnessTargetOption[] {
  return input.targets.filter(
    (target) =>
      target.enabled &&
      modelPlanProtocolForAgentProvider(target.provider) === input.plan.protocol
  );
}
