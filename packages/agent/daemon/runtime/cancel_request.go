package agentruntime

// CancelRequest carries the user-visible cancel reason for adapter.Cancel.
// This is intentionally not a turnID: adapters derive live turns from their
// own registry.
type CancelRequest struct {
	Reason string
}
