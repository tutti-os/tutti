package agenthost

import (
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

const WorkspaceAgentSessionOriginImported = "WORKSPACE_AGENT_SESSION_ORIGIN_IMPORTED"

type ResumeMode string

const (
	ResumeModeExisting ResumeMode = "existing"
	ResumeModeRecreate ResumeMode = "recreate"
	ResumeModeReject   ResumeMode = "reject"
)

type ResumePolicy struct {
	Mode ResumeMode
}

func ResolveResumePolicy(session storesqlite.Session) ResumePolicy {
	if strings.TrimSpace(session.Kind) == canonical.SessionKindChild {
		return ResumePolicy{Mode: ResumeModeReject}
	}
	if strings.TrimSpace(session.Origin) != WorkspaceAgentSessionOriginImported {
		return ResumePolicy{Mode: ResumeModeExisting}
	}
	if !ExternalImportResumeSupported(session.InternalRuntimeContext) {
		return ResumePolicy{Mode: ResumeModeReject}
	}
	return ResumePolicy{Mode: ResumeModeRecreate}
}

func ExternalImportResumeSupported(runtimeContext map[string]any) bool {
	value, exists := runtimeContext["externalImportResumeSupported"]
	if !exists {
		return true
	}
	supported, ok := value.(bool)
	return ok && supported
}
