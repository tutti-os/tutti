package workspace

import "sync"

// IssueRunLaunchGate coordinates the short local handoff between a durable Run
// claim and an external Agent launch. It never holds a mutex across external
// work. Stop records intent and returns immediately; launch either skips the
// claim or compensates after the external call completes.
type IssueRunLaunchGate struct {
	mu     sync.Mutex
	states map[string]issueRunLaunchGateState
}

type issueRunLaunchGateState struct {
	launching       bool
	cancelRequested bool
}

func NewIssueRunLaunchGate() *IssueRunLaunchGate {
	return &IssueRunLaunchGate{states: make(map[string]issueRunLaunchGateState)}
}

func (g *IssueRunLaunchGate) begin(workspaceID string, runID string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	key := workspaceID + "/" + runID
	state := g.states[key]
	if state.cancelRequested {
		return false
	}
	state.launching = true
	g.states[key] = state
	return true
}

func (g *IssueRunLaunchGate) finish(workspaceID string, runID string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	key := workspaceID + "/" + runID
	state := g.states[key]
	cancelRequested := state.cancelRequested
	delete(g.states, key)
	return cancelRequested
}

func (g *IssueRunLaunchGate) requestCancel(workspaceID string, runID string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	key := workspaceID + "/" + runID
	state := g.states[key]
	launching := state.launching
	state.cancelRequested = true
	g.states[key] = state
	return launching
}

func (g *IssueRunLaunchGate) clear(workspaceID string, runID string) {
	g.mu.Lock()
	delete(g.states, workspaceID+"/"+runID)
	g.mu.Unlock()
}

var fallbackIssueRunLaunchGate = NewIssueRunLaunchGate()

func (s IssueManagerService) runLaunchGate() *IssueRunLaunchGate {
	if s.RunLaunchGate != nil {
		return s.RunLaunchGate
	}
	return fallbackIssueRunLaunchGate
}
