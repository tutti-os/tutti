package runtime

import (
	"net/url"
	"strings"
)

const (
	CapabilitiesPath            = "/v1/cli/capabilities"
	CommandInvokePathPattern    = "/v1/cli/commands/{commandID}/invoke"
	WorkspaceIDQueryName        = "workspaceID"
	IncludeHiddenQueryName      = "includeHidden"
	IncludeIntegrationQueryName = "includeIntegration"
)

// CapabilitiesRequestPath returns the exact upstream path and query spelling
// used by the released CLI protocol.
func CapabilitiesRequestPath(workspaceID string, options CapabilityListOptions) string {
	query := url.Values{}
	if workspaceID = strings.TrimSpace(workspaceID); workspaceID != "" {
		query.Set(WorkspaceIDQueryName, workspaceID)
	}
	if options.IncludeHidden {
		query.Set(IncludeHiddenQueryName, "true")
	}
	if options.IncludeIntegration {
		query.Set(IncludeIntegrationQueryName, "true")
	}
	if len(query) == 0 {
		return CapabilitiesPath
	}
	return CapabilitiesPath + "?" + query.Encode()
}

// CommandInvokePath returns the exact upstream invoke route for commandID.
func CommandInvokePath(commandID string) string {
	return strings.Replace(CommandInvokePathPattern, "{commandID}", escapePathSegment(commandID), 1)
}

func escapePathSegment(value string) string {
	replacer := strings.NewReplacer("%", "%25", "/", "%2F", "?", "%3F", "#", "%23")
	return replacer.Replace(value)
}
