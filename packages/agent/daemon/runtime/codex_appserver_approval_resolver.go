package agentruntime

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
)

type pendingInteractiveRequestState string

const (
	pendingInteractiveRequestStatePending     pendingInteractiveRequestState = "pending"
	pendingInteractiveRequestStateResolved    pendingInteractiveRequestState = "resolved"
	pendingInteractiveRequestStateInterrupted pendingInteractiveRequestState = "interrupted"
)

var errAppServerServerRequestResolved = fmt.Errorf("codex app-server server request resolved out of band")

func appServerRequestIDParam(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return strings.TrimSpace(typed.String())
	case float64:
		if typed == math.Trunc(typed) {
			return strconv.FormatInt(int64(typed), 10)
		}
		return strings.TrimSpace(strconv.FormatFloat(typed, 'f', -1, 64))
	case float32:
		value := float64(typed)
		if value == math.Trunc(value) {
			return strconv.FormatInt(int64(value), 10)
		}
		return strings.TrimSpace(strconv.FormatFloat(value, 'f', -1, 32))
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case int32:
		return strconv.FormatInt(int64(typed), 10)
	case uint:
		return strconv.FormatUint(uint64(typed), 10)
	case uint64:
		return strconv.FormatUint(typed, 10)
	case uint32:
		return strconv.FormatUint(uint64(typed), 10)
	default:
		return ""
	}
}

func (a *CodexAppServerAdapter) resolvePendingRequestFromProvider(
	agentSessionID string,
	params map[string]any,
) bool {
	if a == nil {
		return false
	}
	requestID := appServerRequestIDParam(params["requestId"])
	if requestID == "" {
		return false
	}
	a.mu.Lock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	var pending *pendingInteractiveRequest
	if appSession != nil && appSession.pendingRequests != nil {
		pending = appSession.pendingRequests[requestID]
		if pending != nil {
			pending.state = pendingInteractiveRequestStateResolved
			delete(appSession.pendingRequests, requestID)
		}
	}
	a.mu.Unlock()
	if pending == nil {
		return false
	}
	select {
	case pending.response <- pendingInteractiveResponse{
		action:            "resolved",
		err:               errAppServerServerRequestResolved,
		outOfBandResolved: true,
	}:
	default:
	}
	return true
}
