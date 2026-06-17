package browser

import (
	"context"
	"strings"
	"sync"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agentactivity/daemon/runtime"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

// defaultIdleTTL shuts a workspace's browser (and its Chrome) down after a
// period with no tool calls.
const defaultIdleTTL = 5 * time.Minute

// Service drives a browser for agents via the `tutti browser` CLI. It owns one
// chrome-devtools-mcp subprocess per workspace, reused across CLI calls and
// torn down on idle or daemon shutdown.
type Service struct {
	transport            agentruntime.ProcessTransport
	preferences          PreferencesReader
	idleTTL              time.Duration
	autoConnectPreflight func() error

	mu       sync.Mutex
	sessions map[string]*browserSession
}

// PreferencesReader reads desktop preferences that affect browser launch.
type PreferencesReader interface {
	GetDesktopPreferences(context.Context) (preferencesbiz.DesktopPreferences, error)
}

// NewService constructs a browser Service using a local process transport.
func NewService(preferences ...PreferencesReader) *Service {
	var reader PreferencesReader
	if len(preferences) > 0 {
		reader = preferences[0]
	}
	return &Service{
		transport:            agentruntime.NewLocalProcessTransport(),
		preferences:          reader,
		idleTTL:              defaultIdleTTL,
		autoConnectPreflight: validateAutoConnectChromeReady,
		sessions:             make(map[string]*browserSession),
	}
}

// CallTool invokes a chrome-devtools-mcp tool against the workspace's browser
// session, lazily starting it on first use.
func (s *Service) CallTool(ctx context.Context, workspaceID, cwd, tool string, args map[string]any) (ToolResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	currentMode := resolveBrowserUseConnectionMode(ctx, s.preferences)

	s.mu.Lock()
	session, sessionExisted := s.sessions[workspaceID]
	if session != nil && session.connectionMode != "" && session.connectionMode != currentMode {
		s.mu.Unlock()
		s.Shutdown(workspaceID)
		s.mu.Lock()
		sessionExisted = false
	}
	s.mu.Unlock()

	if currentMode == "autoConnect" && !sessionExisted {
		preflight := s.autoConnectPreflight
		if preflight == nil {
			preflight = validateAutoConnectChromeReady
		}
		if err := preflight(); err != nil {
			return ToolResult{}, err
		}
	}

	session = s.getOrCreate(workspaceID, currentMode)
	session.beginCall()
	defer session.endCall(func() { s.resetIdle(workspaceID, session) })

	if err := session.start(ctx, cwd); err != nil {
		// A failed start should not be cached; drop the session so the next
		// call retries (e.g. transient npx/network failure).
		s.Shutdown(workspaceID)
		return ToolResult{}, err
	}
	result, err := session.callTool(ctx, tool, args)
	if err != nil && session.client != nil && session.client.isClosed() {
		s.Shutdown(workspaceID)
	}
	return result, err
}

func (s *Service) getOrCreate(workspaceID, connectionMode string) *browserSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	if session, ok := s.sessions[workspaceID]; ok {
		return session
	}
	session := &browserSession{
		transport:      s.transport,
		command:        s.resolveCommand,
		connectionMode: connectionMode,
	}
	s.sessions[workspaceID] = session
	return session
}

func (s *Service) resolveCommand(ctx context.Context) []string {
	return resolveBrowserMCPCommand(ctx, s.preferences)
}

func (s *Service) resetIdle(workspaceID string, session *browserSession) {
	if session.inFlightCount() != 0 {
		return
	}
	session.idleMu.Lock()
	defer session.idleMu.Unlock()
	if session.inFlightCount() != 0 {
		return
	}
	if session.idle != nil {
		session.idle.Stop()
	}
	session.idle = time.AfterFunc(s.idleTTL, func() { s.Shutdown(workspaceID) })
}

// Shutdown tears down a single workspace's browser session.
func (s *Service) Shutdown(workspaceID string) {
	s.mu.Lock()
	session := s.sessions[strings.TrimSpace(workspaceID)]
	delete(s.sessions, strings.TrimSpace(workspaceID))
	s.mu.Unlock()
	if session == nil {
		return
	}
	session.idleMu.Lock()
	if session.idle != nil {
		session.idle.Stop()
	}
	session.idleMu.Unlock()
	session.close()
}

// Close tears down all browser sessions (daemon shutdown).
func (s *Service) Close() {
	s.mu.Lock()
	sessions := s.sessions
	s.sessions = make(map[string]*browserSession)
	s.mu.Unlock()
	for _, session := range sessions {
		session.idleMu.Lock()
		if session.idle != nil {
			session.idle.Stop()
		}
		session.idleMu.Unlock()
		session.close()
	}
}
