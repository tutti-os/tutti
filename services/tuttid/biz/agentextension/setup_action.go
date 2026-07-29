package agentextension

type SetupActionStatus string
type SetupActionPhase string
type SetupActionKind string

const (
	SetupActionQueued      SetupActionStatus = "queued"
	SetupActionRunning     SetupActionStatus = "running"
	SetupActionSucceeded   SetupActionStatus = "succeeded"
	SetupActionFailed      SetupActionStatus = "failed"
	SetupActionInterrupted SetupActionStatus = "interrupted"

	SetupPhasePreparing      SetupActionPhase = "preparing"
	SetupPhaseInstalling     SetupActionPhase = "installing"
	SetupPhaseVerifying      SetupActionPhase = "verifying"
	SetupPhaseProbing        SetupActionPhase = "probing"
	SetupPhaseActivating     SetupActionPhase = "activating"
	SetupPhaseAuthenticating SetupActionPhase = "authenticating"
	SetupPhaseComplete       SetupActionPhase = "complete"

	SetupActionInstall      SetupActionKind = "install"
	SetupActionAuthenticate SetupActionKind = "authenticate"
)

type SetupActionScope struct {
	AgentTargetID           string
	ExtensionInstallationID string
}

type AuthenticatedAccount struct {
	ID           string `json:"id"`
	DisplayName  string `json:"displayName"`
	AuthMethodID string `json:"authMethodId"`
	Organization string `json:"organization,omitempty"`
}

type SetupAction struct {
	ActionID                string                `json:"actionId"`
	ClientActionID          string                `json:"clientActionId"`
	Kind                    SetupActionKind       `json:"kind"`
	WorkspaceID             string                `json:"workspaceId"`
	AgentTargetID           string                `json:"agentTargetId"`
	ExtensionInstallationID string                `json:"extensionInstallationId"`
	PlanDigest              string                `json:"planDigest"`
	MethodID                string                `json:"methodId,omitempty"`
	Status                  SetupActionStatus     `json:"status"`
	Phase                   SetupActionPhase      `json:"phase"`
	ErrorCode               string                `json:"errorCode,omitempty"`
	ErrorMessage            string                `json:"errorMessage,omitempty"`
	Account                 *AuthenticatedAccount `json:"account,omitempty"`
	CreatedAtUnixMS         int64                 `json:"createdAtUnixMs"`
	UpdatedAtUnixMS         int64                 `json:"updatedAtUnixMs"`
}
