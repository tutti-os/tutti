package api

import (
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func generatedAgentSessionIsolation(
	isolation *agentservice.SessionIsolation,
) *tuttigenerated.WorkspaceAgentSessionIsolation {
	if isolation == nil {
		return nil
	}
	return &tuttigenerated.WorkspaceAgentSessionIsolation{
		WorktreeId:   optionalStringPointer(strings.TrimSpace(isolation.WorktreeID)),
		Mode:         tuttigenerated.WorkspaceAgentSessionIsolationMode(isolation.Mode),
		WorktreePath: strings.TrimSpace(isolation.WorktreePath),
		Branch:       strings.TrimSpace(isolation.Branch),
		BaseCommit:   strings.TrimSpace(isolation.BaseCommit),
	}
}
