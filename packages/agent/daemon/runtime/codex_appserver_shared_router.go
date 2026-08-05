package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type codexPendingSideMessage struct {
	threadID string
	message  acpMessage
}

type codexPendingSideRoute struct {
	sourceThreadID     string
	sideThreadID       string
	sideAgentSessionID string
	messages           []codexPendingSideMessage
}

func (a *CodexAppServerAdapter) beginPendingSideRoute(
	client *codexAppServerClient,
	sourceThreadID string,
) error {
	if a == nil || client == nil {
		return ErrSideConversationExpired
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.pendingSideRoutes == nil {
		a.pendingSideRoutes =
			make(map[*codexAppServerClient]*codexPendingSideRoute)
	}
	if a.pendingSideRoutes[client] != nil {
		return ErrSideConversationConflict
	}
	a.pendingSideRoutes[client] = &codexPendingSideRoute{
		sourceThreadID: strings.TrimSpace(sourceThreadID),
	}
	return nil
}

func (a *CodexAppServerAdapter) discardPendingSideRoute(
	client *codexAppServerClient,
) {
	if a == nil || client == nil {
		return
	}
	a.mu.Lock()
	delete(a.pendingSideRoutes, client)
	a.mu.Unlock()
}

func (a *CodexAppServerAdapter) commitPendingSideRoute(
	client *codexAppServerClient,
	sideAgentSessionID string,
	sideThreadID string,
	session *codexAppServerSession,
) error {
	if a == nil || client == nil || session == nil {
		return ErrSideConversationExpired
	}
	sideAgentSessionID = strings.TrimSpace(sideAgentSessionID)
	sideThreadID = strings.TrimSpace(sideThreadID)
	a.mu.Lock()
	pending := a.pendingSideRoutes[client]
	if pending == nil || sideAgentSessionID == "" || sideThreadID == "" {
		a.mu.Unlock()
		return ErrSideConversationExpired
	}
	if a.sessions[sideAgentSessionID] != nil {
		a.mu.Unlock()
		return ErrSideConversationConflict
	}
	session.ensureInitialized()
	if session.serverInfo == nil {
		session.serverInfo = map[string]any{}
	}
	if session.pendingRequests == nil {
		session.pendingRequests = make(map[string]*pendingInteractiveRequest)
	}
	a.sessions[sideAgentSessionID] = session
	pending.sideAgentSessionID = sideAgentSessionID
	pending.sideThreadID = sideThreadID
	a.mu.Unlock()
	return nil
}

func (a *CodexAppServerAdapter) drainPendingSideMessages(
	client *codexAppServerClient,
) (messages []codexPendingSideMessage, complete bool) {
	if a == nil || client == nil {
		return nil, true
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	pending := a.pendingSideRoutes[client]
	if pending == nil {
		return nil, true
	}
	if len(pending.messages) == 0 {
		delete(a.pendingSideRoutes, client)
		return nil, true
	}
	messages = append(
		[]codexPendingSideMessage(nil),
		pending.messages...,
	)
	pending.messages = nil
	return messages, false
}

// installSharedAppServerRouter upgrades a source-owned connection from the
// legacy one-session callback to connection-scoped thread routing. Codex Side
// must fork and remain on this exact connection so an in-progress source Turn
// is part of the provider snapshot.
func (a *CodexAppServerAdapter) installSharedAppServerRouter(
	client *codexAppServerClient,
	fallback Session,
) {
	if a == nil || client == nil {
		return
	}
	client.SetMessageRouter(func(ctx context.Context, message acpMessage) error {
		return a.routeSharedAppServerMessage(ctx, client, fallback, message)
	})
}

func (a *CodexAppServerAdapter) routeSharedAppServerMessage(
	ctx context.Context,
	client *codexAppServerClient,
	fallback Session,
	message acpMessage,
) error {
	return a.routeSharedAppServerMessageWithPending(
		ctx,
		client,
		fallback,
		message,
		true,
	)
}

func (a *CodexAppServerAdapter) routeSharedAppServerMessageWithPending(
	ctx context.Context,
	client *codexAppServerClient,
	fallback Session,
	message acpMessage,
	allowPending bool,
) error {
	var params map[string]any
	_ = json.Unmarshal(message.Params, &params)
	threadID := appServerMessageThreadID(params)

	session := fallback
	agentSessionID := strings.TrimSpace(fallback.AgentSessionID)
	matchedThread := false
	a.mu.Lock()
	if threadID != "" {
		// An exact runtime session owns its provider thread. Parent child-thread
		// indexes are only a fallback: map iteration order must never let a
		// stale/overlapping child index steal a committed Side thread.
		for candidateID, candidate := range a.sessions {
			if candidate == nil || candidate.client != client {
				continue
			}
			if strings.TrimSpace(candidate.threadID) == threadID {
				agentSessionID = candidateID
				session = candidate.runtimeSession
				matchedThread = true
				break
			}
		}
		if !matchedThread {
			for candidateID, candidate := range a.sessions {
				if candidate == nil || candidate.client != client {
					continue
				}
				if _, knownChild := candidate.childThreads[threadID]; knownChild {
					agentSessionID = candidateID
					session = candidate.runtimeSession
					matchedThread = true
					break
				}
			}
		}
	}
	if allowPending && threadID != "" {
		if pending := a.pendingSideRoutes[client]; pending != nil &&
			threadID != pending.sourceThreadID &&
			(!matchedThread || threadID == pending.sideThreadID) {
			if len(message.ID) > 0 {
				a.mu.Unlock()
				err := errors.New(
					"codex sent a server request for an uncommitted Side thread",
				)
				_ = client.Respond(
					ctx,
					message.ID,
					nil,
					&acpError{Code: -32000, Message: err.Error()},
				)
				return err
			}
			pending.messages = append(pending.messages, codexPendingSideMessage{
				threadID: threadID,
				message:  message,
			})
			a.mu.Unlock()
			return nil
		}
	}
	if strings.TrimSpace(session.AgentSessionID) == "" {
		if candidate := a.sessions[agentSessionID]; candidate != nil {
			session = candidate.runtimeSession
		}
	}
	a.mu.Unlock()

	// Unknown provider child threads remain owned by the source fallback; the
	// existing child-thread router will either resolve or deliberately drop
	// them. A registered Side thread always matches above and never falls
	// through to the parent.
	if strings.TrimSpace(session.AgentSessionID) == "" {
		session = fallback
	}
	if threadID != "" && strings.TrimSpace(session.ProviderSessionID) == "" {
		session.ProviderSessionID = threadID
	}

	turnID := ""
	var normalizer *acpTurnNormalizer
	var emit func([]activityshared.Event)
	var emitCommands CommandSnapshotSink
	if activeTurn := a.sessionActiveTurn(agentSessionID); activeTurn != nil {
		session = activeTurn.session
		turnID = activeTurn.turnID
		normalizer = activeTurn.normalizer
		emit = activeTurn.emit
		emitCommands = activeTurn.emitCommands
	}
	events, err := a.handleAppServerMessage(
		ctx,
		client,
		session,
		turnID,
		message,
		normalizer,
		emit,
		emitCommands,
	)
	if emit != nil {
		emit(events)
	} else {
		// Idle notifications can arrive before OpenSide returns (for example,
		// thread/name/updated emitted by thread/fork). Once replayed against the
		// committed child they must still enter the Side-only observer path.
		a.emitSessionEvents(agentSessionID, events)
	}
	return err
}

func appServerMessageThreadID(params map[string]any) string {
	return strings.TrimSpace(firstNonEmpty(
		asString(params["threadId"]),
		asString(params["conversationId"]),
		asString(payloadObject(params["thread"])["id"]),
	))
}
