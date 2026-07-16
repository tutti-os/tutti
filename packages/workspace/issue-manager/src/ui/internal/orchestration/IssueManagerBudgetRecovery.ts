import type {
  IssueManagerBudget,
  IssueManagerExecutionProfile
} from "../../../contracts/index.ts";
import type { IssueDraft } from "../../../services/controllerTypes.ts";

export function createLowerIntensityBudgetRecoveryPatch(input: {
  budget: IssueManagerBudget;
  executionProfile: IssueManagerExecutionProfile;
}): Partial<IssueDraft> {
  return {
    budget: {
      ...input.budget,
      status: "active"
    },
    dispatchPaused: true,
    executionProfile: {
      reasoningIntensity: Math.max(
        0,
        input.executionProfile.reasoningIntensity - 20
      ),
      orchestrationIntensity: Math.max(
        0,
        input.executionProfile.orchestrationIntensity - 20
      )
    }
  };
}
