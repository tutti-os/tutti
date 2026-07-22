package agentruntime

import (
	"context"
	"fmt"
	"log/slog"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/packages/agent/daemon/runtime/codexproto"
)

const appServerMethodChatgptAuthTokensRefresh = "account/chatgptAuthTokens/refresh"

// handleAppServerMessage routes codex app-server server->client traffic.
// Server requests (approvals, user-input questions) register pending resolver
// state and respond asynchronously; notifications are translated into activity
// events through the shared ACP turn normalizer so the rest of the daemon sees
// one event shape.
func (a *CodexAppServerAdapter) handleAppServerMessage(
	ctx context.Context,
	client *codexAppServerClient,
	session Session,
	turnID string,
	message acpMessage,
	normalizer *acpTurnNormalizer,
	emit EventSink,
	emitCommands CommandSnapshotSink,
) ([]activityshared.Event, error) {
	if message.Method == "" {
		return nil, nil
	}
	if len(message.ID) > 0 {
		switch message.Method {
		case appServerMethodCommandApproval,
			appServerMethodFileChangeApproval,
			appServerMethodPermissionsApproval,
			appServerMethodRequestUserInput,
			appServerMethodExecApprovalV1,
			appServerMethodPatchApprovalV1:
			return a.appServerServerRequest(ctx, client, session, turnID, message, normalizer, emit)
		default:
			err := fmt.Errorf("server request method %q is not supported", message.Method)
			if codexproto.IsKnownServerRequestMethod(message.Method) {
				// Schema-known background requests the daemon deliberately
				// declines (auth token refresh, attestation, sandbox setup)
				// get a silent -32601; a transcript failure card would show
				// users spurious red cards for background operations.
				if unexpectedExternalAuthRefresh(session.Provider, message.Method) {
					slog.Warn(
						"tutti-agent requested unexpected external auth refresh",
						"event", "tutti.agent_auth.unexpected_external_refresh",
						"agent_session_id", session.AgentSessionID,
						"method", message.Method,
					)
				} else {
					slog.Debug(
						"agent session app-server declined known server request",
						"agent_session_id", session.AgentSessionID,
						"method", message.Method,
					)
				}
			} else if emit != nil {
				emit(appServerUnsupportedServerRequestEvents(session, turnID, message, err))
			}
			_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32601, Message: err.Error()})
			return nil, nil
		}
	}
	var processingTurn *codexAppServerActiveTurn
	if appServerNotificationUsesNormalizer(message.Method) {
		processingTurn = a.activeTurnForNormalizer(session.AgentSessionID, normalizer)
		if processingTurn != nil {
			processingTurn.processMu.Lock()
			defer processingTurn.processMu.Unlock()
		}
	}
	reduction := newCodexAppServerReducer(a).ReduceNotification(client, session, turnID, message, normalizer, emitCommands)
	return reduction.Events, nil
}

func unexpectedExternalAuthRefresh(provider string, method string) bool {
	descriptor, ok := providerregistry.Find(provider)
	return ok &&
		descriptor.Runtime.AuthRefreshOwner == providerregistry.RuntimeAuthRefreshOwnerRuntime &&
		method == appServerMethodChatgptAuthTokensRefresh
}

func appServerNotificationUsesNormalizer(method string) bool {
	switch method {
	case appServerNotifyAgentMessageDelta, appServerNotifyReasoningDelta, appServerNotifyReasoningSummary,
		appServerNotifyItemStarted, appServerNotifyItemCompleted, appServerNotifyPlanUpdated:
		return true
	default:
		return false
	}
}

func (a *CodexAppServerAdapter) activeTurnForNormalizer(agentSessionID string, normalizer *acpTurnNormalizer) *codexAppServerActiveTurn {
	if a == nil || normalizer == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	session := a.sessions[agentSessionID]
	if session == nil || session.activeTurn == nil || session.activeTurn.normalizer != normalizer {
		return nil
	}
	return session.activeTurn
}

// appServerNoticeItems maps review thread items to a one-line system-notice
// banner. emitOnCompleted selects which lifecycle event carries the banner:
// enteredReviewMode rides item/started (it always fires), while
// exitedReviewMode rides the authoritative item/completed.
var appServerNoticeItems = map[string]struct {
	message         string
	emitOnCompleted bool
}{
	"enteredReviewMode": {message: "Code review started.", emitOnCompleted: false},
	"exitedReviewMode":  {message: "Code review finished.", emitOnCompleted: true},
}

const (
	appServerCompactingContextTitle     = "Compacting context."
	appServerContextCompactedTitle      = "Context compacted."
	appServerCompactionInterruptedTitle = "Context compaction interrupted."
)

// appServerCompactionNoticeEvent emits the compaction banner for both item
// lifecycle events. Both banners share one messageId keyed to the thread item
// so the "Context compacted." notice replaces the in-progress "Compacting
// context." notice in place instead of appending a second transcript row.
