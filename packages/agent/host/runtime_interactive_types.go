package agenthost

type RuntimeSubmitInteractiveResult struct {
	Disposition RuntimeInteractiveDisposition
	// FollowUpPrompt is an intent returned by Runtime. Host submits it through
	// SendInput so the prompt receives normal idempotency, admission, and
	// recovery semantics.
	FollowUpPrompt string
}
