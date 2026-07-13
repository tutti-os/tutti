package agentruntime

import (
	"fmt"
	"strings"
)

const claudeSDKSidecarProtocolVersion = 1

type claudeSDKSidecarRequest struct {
	Version int            `json:"version"`
	ID      string         `json:"id,omitempty"`
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload,omitempty"`
}

type claudeSDKSidecarEvent struct {
	Version int            `json:"version"`
	ID      string         `json:"id,omitempty"`
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload,omitempty"`
}

func (request *claudeSDKSidecarRequest) normalize() error {
	if request == nil {
		return fmt.Errorf("claude sdk sidecar request is required")
	}
	if request.Version == 0 {
		request.Version = claudeSDKSidecarProtocolVersion
	}
	if request.Version != claudeSDKSidecarProtocolVersion {
		return fmt.Errorf("unsupported claude sdk sidecar protocol version %d", request.Version)
	}
	if strings.TrimSpace(request.Type) == "" {
		return fmt.Errorf("claude sdk sidecar request type is required")
	}
	return nil
}

func (event claudeSDKSidecarEvent) validate() error {
	if event.Version != claudeSDKSidecarProtocolVersion {
		return fmt.Errorf("unsupported claude sdk sidecar protocol version %d", event.Version)
	}
	if strings.TrimSpace(event.Type) == "" {
		return fmt.Errorf("claude sdk sidecar event type is required")
	}
	return nil
}
