package agentruntime

import (
	"encoding/json"
	"sync"
)

type scriptedAppServerResponder interface {
	Close() error
	sendJSON(map[string]any)
	sendJSONBatch(...map[string]any)
	sendStderr([]byte)
	notify(string, map[string]any)
}

type scriptedAppServerMessage struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params map[string]any  `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

type fakeCodexAppServer struct {
	mu *sync.Mutex
	scriptedAppServerResponder
	scriptedSessionState
	scriptedTurnState
	scriptedGoalState
	scriptedReviewState
}

func newFakeCodexAppServer(
	responder scriptedAppServerResponder,
	mu *sync.Mutex,
) *fakeCodexAppServer {
	return &fakeCodexAppServer{
		scriptedAppServerResponder: responder,
		mu:                         mu,
		scriptedGoalState: scriptedGoalState{
			goalCompletionAfterTurns: 1,
		},
	}
}

func (s *fakeCodexAppServer) handle(data []byte) error {
	for _, line := range acpScanLines(data) {
		var message scriptedAppServerMessage
		_ = json.Unmarshal([]byte(line), &message)
		if s.handleSessionRPC(message) ||
			s.handleTurnRPC(message) ||
			s.handleGoalReviewRPC(message) {
			continue
		}
		s.handleClientResponse(message, line)
	}
	return nil
}

func (s *fakeCodexAppServer) handleClientResponse(message scriptedAppServerMessage, line string) {
	if message.Method != "" || len(message.ID) == 0 {
		return
	}
	var payload map[string]any
	_ = json.Unmarshal([]byte(line), &payload)
	s.mu.Lock()
	s.approvalResponse = payload
	s.mu.Unlock()
	s.completePendingTurn()
}
