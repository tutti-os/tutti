package workspace

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/google/uuid"
)

const defaultTerminalCols = 80
const defaultTerminalRows = 24
const maxTerminalSnapshotChars = 400_000
const maxTerminalReplayChars = maxTerminalSnapshotChars * 2

var ErrTerminalNotFound = errors.New("workspace terminal not found")
var ErrTerminalNotRunning = errors.New("workspace terminal is not running")

type TerminalStatus string

const (
	TerminalStatusCreated  TerminalStatus = "created"
	TerminalStatusStarting TerminalStatus = "starting"
	TerminalStatusRunning  TerminalStatus = "running"
	TerminalStatusDetached TerminalStatus = "detached"
	TerminalStatusExited   TerminalStatus = "exited"
	TerminalStatusFailed   TerminalStatus = "failed"
)

type TerminalSession struct {
	ID          string
	WorkspaceID string
	Title       string
	Cwd         *string
	ProfileID   *string
	Status      TerminalStatus
	Cols        int
	Rows        int
	CreatedAt   time.Time
	UpdatedAt   *time.Time
	EndedAt     *time.Time
	LastError   *string
}

type TerminalSnapshot struct {
	Data      string
	FromSeq   *int64
	ToSeq     *int64
	Truncated *bool
	UpdatedAt *int64
}

type TerminalCloseGuard struct {
	Status               TerminalStatus
	Reason               string
	RequiresConfirmation bool
	LeaderCommand        *string
}

type CreateTerminalInput struct {
	Cols         *int
	Cwd          *string
	InitialInput *string
	ProfileID    *string
	Rows         *int
}

type ResizeTerminalInput struct {
	Cols int
	Rows int
}

type AttachTerminalInput struct {
	AfterSeq *int64
}

type TerminalStreamEventType string

const (
	TerminalStreamEventOutput TerminalStreamEventType = "output"
	TerminalStreamEventState  TerminalStreamEventType = "state"
	TerminalStreamEventGap    TerminalStreamEventType = "gap"
	TerminalStreamEventExit   TerminalStreamEventType = "exit"
	TerminalStreamEventError  TerminalStreamEventType = "error"
	TerminalStreamEventMeta   TerminalStreamEventType = "metadata"
)

type TerminalStreamEvent struct {
	Type        TerminalStreamEventType
	SessionID   string
	Data        string
	Seq         *int64
	FromSeq     *int64
	ToSeq       *int64
	Status      TerminalStatus
	Error       *string
	Code        *int
	Signal      *string
	Cwd         *string
	ProfileID   *string
	RuntimeKind *string
	Title       *string
}

type TerminalStream struct {
	Events  <-chan TerminalStreamEvent
	Session TerminalSession
	close   func()
}

func (s TerminalStream) Close() {
	if s.close != nil {
		s.close()
	}
}

type TerminalService struct {
	manager *terminalSessionManager
}

// Close terminates every PTY owned by the daemon. Window/view teardown must
// not call this method; it is reserved for application-level daemon shutdown.
func (s *TerminalService) Close() {
	if s == nil || s.manager == nil {
		return
	}
	s.manager.close()
}

func (s *TerminalService) ensureManager() *terminalSessionManager {
	if s.manager == nil {
		s.manager = newTerminalSessionManager()
	}
	return s.manager
}

func (s *TerminalService) List(ctx context.Context, workspaceID string) ([]TerminalSession, error) {
	_ = ctx
	normalizedWorkspaceID, err := normalizeWorkspaceID(workspaceID)
	if err != nil {
		return nil, err
	}
	return s.ensureManager().list(normalizedWorkspaceID), nil
}

func (s *TerminalService) Create(ctx context.Context, workspaceID string, input CreateTerminalInput) (TerminalSession, error) {
	_ = ctx
	normalizedWorkspaceID, err := normalizeWorkspaceID(workspaceID)
	if err != nil {
		return TerminalSession{}, err
	}
	cwd, err := resolveTerminalCwd(input.Cwd)
	if err != nil {
		return TerminalSession{}, err
	}
	return s.ensureManager().create(normalizedWorkspaceID, cwd, input)
}

func (s *TerminalService) Get(ctx context.Context, workspaceID string, terminalID string) (TerminalSession, error) {
	_ = ctx
	normalizedWorkspaceID, err := normalizeWorkspaceID(workspaceID)
	if err != nil {
		return TerminalSession{}, err
	}
	return s.ensureManager().get(normalizedWorkspaceID, terminalID)
}

func (s *TerminalService) Terminate(ctx context.Context, workspaceID string, terminalID string) (TerminalSession, error) {
	_ = ctx
	normalizedWorkspaceID, err := normalizeWorkspaceID(workspaceID)
	if err != nil {
		return TerminalSession{}, err
	}
	return s.ensureManager().terminate(normalizedWorkspaceID, terminalID)
}

func (s *TerminalService) Resize(ctx context.Context, workspaceID string, terminalID string, input ResizeTerminalInput) (TerminalSession, error) {
	_ = ctx
	normalizedWorkspaceID, err := normalizeWorkspaceID(workspaceID)
	if err != nil {
		return TerminalSession{}, err
	}
	return s.ensureManager().resize(normalizedWorkspaceID, terminalID, input)
}

func (s *TerminalService) Write(ctx context.Context, workspaceID string, terminalID string, data string) error {
	_ = ctx
	normalizedWorkspaceID, err := normalizeWorkspaceID(workspaceID)
	if err != nil {
		return err
	}
	return s.ensureManager().write(normalizedWorkspaceID, terminalID, data)
}

func (s *TerminalService) AttachStream(ctx context.Context, workspaceID string, terminalID string, input AttachTerminalInput) (TerminalStream, error) {
	_ = ctx
	normalizedWorkspaceID, err := normalizeWorkspaceID(workspaceID)
	if err != nil {
		return TerminalStream{}, err
	}
	return s.ensureManager().attachStream(normalizedWorkspaceID, terminalID, input)
}

func (s *TerminalService) Snapshot(ctx context.Context, workspaceID string, terminalID string) (TerminalSnapshot, error) {
	_ = ctx
	normalizedWorkspaceID, err := normalizeWorkspaceID(workspaceID)
	if err != nil {
		return TerminalSnapshot{}, err
	}
	return s.ensureManager().snapshot(normalizedWorkspaceID, terminalID)
}

func (s *TerminalService) CloseGuard(ctx context.Context, workspaceID string, terminalID string) (TerminalCloseGuard, error) {
	_ = ctx
	normalizedWorkspaceID, err := normalizeWorkspaceID(workspaceID)
	if err != nil {
		return TerminalCloseGuard{}, err
	}
	return s.ensureManager().closeGuard(normalizedWorkspaceID, terminalID)
}

func normalizeWorkspaceID(workspaceID string) (string, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return "", errors.New("workspace id is required")
	}
	return workspaceID, nil
}

type terminalSessionManager struct {
	mu       sync.Mutex
	sessions map[string]*terminalRuntimeSession
}

func newTerminalSessionManager() *terminalSessionManager {
	return &terminalSessionManager{
		sessions: make(map[string]*terminalRuntimeSession),
	}
}

func (m *terminalSessionManager) list(workspaceID string) []TerminalSession {
	m.mu.Lock()
	defer m.mu.Unlock()

	result := make([]TerminalSession, 0)
	for _, session := range m.sessions {
		if session.workspaceID == workspaceID {
			result = append(result, session.snapshot())
		}
	}
	return result
}

func (m *terminalSessionManager) create(workspaceID string, cwd string, input CreateTerminalInput) (TerminalSession, error) {
	cols := normalizeTerminalDimension(input.Cols, defaultTerminalCols)
	rows := normalizeTerminalDimension(input.Rows, defaultTerminalRows)
	shell := defaultShellPath()
	shellArgs := resolveTerminalShellInvocation(shell)
	now := time.Now().UTC()
	id := uuid.NewString()

	cmd := exec.Command(shell, shellArgs...)
	cmd.Dir = cwd
	cmd.Env = terminalProcessEnv(cwd)

	file, err := pty.StartWithSize(cmd, &pty.Winsize{
		Cols: uint16(cols),
		Rows: uint16(rows),
	})
	if err != nil {
		return TerminalSession{}, fmt.Errorf("start terminal pty: %w", err)
	}

	session := &terminalRuntimeSession{
		cols:        cols,
		command:     cmd,
		createdAt:   now,
		cwd:         cwd,
		file:        file,
		id:          id,
		profileID:   trimOptionalString(input.ProfileID),
		rows:        rows,
		shell:       shell,
		status:      TerminalStatusRunning,
		title:       filepath.Base(shell),
		workspaceID: workspaceID,
	}

	m.mu.Lock()
	m.sessions[id] = session
	m.mu.Unlock()

	if initialInput := strings.TrimRight(derefString(input.InitialInput), "\x00"); initialInput != "" {
		_, _ = file.Write([]byte(initialInput))
	}
	go session.readLoop()
	go session.waitLoop()

	return session.snapshot(), nil
}

func (m *terminalSessionManager) get(workspaceID string, terminalID string) (TerminalSession, error) {
	session, err := m.find(workspaceID, terminalID)
	if err != nil {
		return TerminalSession{}, err
	}
	return session.snapshot(), nil
}

func (m *terminalSessionManager) terminate(workspaceID string, terminalID string) (TerminalSession, error) {
	session, err := m.find(workspaceID, terminalID)
	if err != nil {
		return TerminalSession{}, err
	}

	shouldBroadcastExit := false
	session.mu.Lock()
	if session.command.Process != nil && !isEndedTerminalStatus(session.status) {
		_ = session.command.Process.Kill()
		now := time.Now().UTC()
		session.endedAt = &now
		session.updatedAt = &now
		session.status = TerminalStatusExited
		shouldBroadcastExit = true
	}
	session.mu.Unlock()
	_ = session.file.Close()

	if shouldBroadcastExit {
		session.broadcast(TerminalStreamEvent{
			Type:      TerminalStreamEventExit,
			SessionID: session.id,
			Status:    TerminalStatusExited,
		})
	}

	return session.snapshot(), nil
}

func (m *terminalSessionManager) close() {
	type terminalIdentity struct {
		workspaceID string
		terminalID  string
	}
	m.mu.Lock()
	identities := make([]terminalIdentity, 0, len(m.sessions))
	for terminalID, session := range m.sessions {
		identities = append(identities, terminalIdentity{
			workspaceID: session.workspaceID,
			terminalID:  terminalID,
		})
	}
	m.mu.Unlock()

	for _, identity := range identities {
		_, _ = m.terminate(identity.workspaceID, identity.terminalID)
	}
}

func (m *terminalSessionManager) resize(workspaceID string, terminalID string, input ResizeTerminalInput) (TerminalSession, error) {
	session, err := m.find(workspaceID, terminalID)
	if err != nil {
		return TerminalSession{}, err
	}

	cols := normalizeTerminalDimension(&input.Cols, defaultTerminalCols)
	rows := normalizeTerminalDimension(&input.Rows, defaultTerminalRows)
	session.mu.Lock()
	session.cols = cols
	session.rows = rows
	session.touchLocked()
	file := session.file
	session.mu.Unlock()

	if err := pty.Setsize(file, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)}); err != nil {
		return TerminalSession{}, fmt.Errorf("resize terminal pty: %w", err)
	}
	return session.snapshot(), nil
}

func (m *terminalSessionManager) write(workspaceID string, terminalID string, data string) error {
	session, err := m.find(workspaceID, terminalID)
	if err != nil {
		return err
	}
	return session.write(data)
}

func (m *terminalSessionManager) attachStream(workspaceID string, terminalID string, input AttachTerminalInput) (TerminalStream, error) {
	session, err := m.find(workspaceID, terminalID)
	if err != nil {
		return TerminalStream{}, err
	}
	return session.attachStream(input), nil
}

func (m *terminalSessionManager) snapshot(workspaceID string, terminalID string) (TerminalSnapshot, error) {
	session, err := m.find(workspaceID, terminalID)
	if err != nil {
		return TerminalSnapshot{}, err
	}
	snapshot := session.outputSnapshot()
	slog.Info(
		"workspace terminal snapshot served",
		"event", "workspace.terminal.snapshot",
		"workspace_id", workspaceID,
		"terminal_session_id", terminalID,
		"from_seq", nullableInt64Value(snapshot.FromSeq),
		"to_seq", nullableInt64Value(snapshot.ToSeq),
		"truncated", boolValue(snapshot.Truncated),
		"data_bytes", len(snapshot.Data),
	)
	return snapshot, nil
}

func (m *terminalSessionManager) closeGuard(workspaceID string, terminalID string) (TerminalCloseGuard, error) {
	session, err := m.find(workspaceID, terminalID)
	if err != nil {
		return TerminalCloseGuard{}, err
	}

	snapshot := session.snapshot()
	if isEndedTerminalStatus(snapshot.Status) {
		return TerminalCloseGuard{
			Status:               snapshot.Status,
			Reason:               "not-running",
			RequiresConfirmation: false,
		}, nil
	}

	if foreground, ok := session.foregroundProcess(); ok {
		if !foreground.hasForegroundProcess {
			return TerminalCloseGuard{
				Status:               snapshot.Status,
				Reason:               "not-running",
				RequiresConfirmation: false,
			}, nil
		}
		return TerminalCloseGuard{
			Status:               snapshot.Status,
			Reason:               "foreground-process",
			RequiresConfirmation: true,
			LeaderCommand:        foreground.leaderCommand,
		}, nil
	}

	return TerminalCloseGuard{
		Status:               snapshot.Status,
		Reason:               "unknown",
		RequiresConfirmation: true,
		LeaderCommand:        &session.shell,
	}, nil
}

func (m *terminalSessionManager) find(workspaceID string, terminalID string) (*terminalRuntimeSession, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	session := m.sessions[strings.TrimSpace(terminalID)]
	if session == nil || session.workspaceID != strings.TrimSpace(workspaceID) {
		return nil, ErrTerminalNotFound
	}
	return session, nil
}
