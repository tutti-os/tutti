package agentextension

const AccountUsageCompanionFailureSchemaVersion = "tutti.agent.account-usage-companion-failure.v1"

type AccountUsageCompanionFailureScope struct {
	AgentTargetID           string
	ExtensionInstallationID string
}

// AccountUsageCompanionFailure is intentionally diagnostic-light durable
// retry state. Raw provider or installer errors must never be persisted here.
type AccountUsageCompanionFailure struct {
	SchemaVersion           string `json:"schemaVersion"`
	AgentTargetID           string `json:"agentTargetId"`
	ExtensionInstallationID string `json:"extensionInstallationId"`
	RuntimeIdentity         string `json:"runtimeIdentity"`
	ErrorCode               string `json:"errorCode"`
	ConsecutiveFailures     int    `json:"consecutiveFailures"`
	LastAttemptAtUnixMS     int64  `json:"lastAttemptAtUnixMs"`
	NextAttemptAtUnixMS     int64  `json:"nextAttemptAtUnixMs"`
}
