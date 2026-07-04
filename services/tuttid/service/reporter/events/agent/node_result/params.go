package node_result

import "strings"

type NodeResultInput struct {
	AgentSessionID string
	DurationMS     *int64
	ErrorCode      string
	ErrorMessage   string
	Flow           string
	Node           string
	Provider       string
	Status         string
}

func BuildParams(input NodeResultInput) Params {
	status := strings.TrimSpace(input.Status)
	if status == "" {
		status = "success"
	}
	errorCode := strings.TrimSpace(input.ErrorCode)
	errorMessage := strings.TrimSpace(input.ErrorMessage)
	success := status == "success"
	if success {
		errorCode = ErrorCodeNone
		errorMessage = ""
	} else if errorCode == "" {
		errorCode = ErrorCodeUnknown
	}
	var duration any
	if input.DurationMS != nil {
		duration = *input.DurationMS
	}
	return Params{
		"agent_session_id": strings.TrimSpace(input.AgentSessionID),
		"duration_ms":      duration,
		"error_code":       errorCode,
		"error_message":    errorMessage,
		"flow":             strings.TrimSpace(input.Flow),
		"node":             strings.TrimSpace(input.Node),
		"node_name":        strings.TrimSpace(input.Node),
		"provider":         strings.TrimSpace(input.Provider),
		"status":           status,
		"success":          success,
	}
}
