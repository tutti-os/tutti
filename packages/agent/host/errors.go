package agenthost

import "errors"

var (
	ErrInvalidArgument       = errors.New("invalid agent session request")
	ErrSessionNotFound       = errors.New("workspace agent session not found")
	ErrSubmitDeliveryUnknown = errors.New("agent submit delivery is still being confirmed")
	ErrSessionTitleTooLong   = errors.New("agent session title is too long")
)
