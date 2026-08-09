package hostadapter

import (
	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	host "github.com/tutti-os/tutti/packages/agent/host"
)

func runtimeGoalGenerationFences(input []host.RuntimeGoalGenerationFenceInput) []agentruntime.GoalGenerationFenceInput {
	result := make([]agentruntime.GoalGenerationFenceInput, 0, len(input))
	for _, fence := range input {
		result = append(result, agentruntime.GoalGenerationFenceInput{
			OperationID: fence.TargetOperationID, Revision: fence.TargetRevision,
			RepairEpoch: fence.TargetRepairEpoch, Reason: fence.Reason,
		})
	}
	return result
}
