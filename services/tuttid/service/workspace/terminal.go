package workspace

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"time"

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
	ProcessFactory        TerminalProcessFactory
	RTKExecutableResolver func(context.Context) (string, error)
	manager               *terminalSessionManager
}

func NewTerminalService(factory TerminalProcessFactory) *TerminalService {
	return &TerminalService{ProcessFactory: factory}
}

func (s *TerminalService) ensureManager() *terminalSessionManager {
	if s.manager == nil {
		factory := s.ProcessFactory
		if factory == nil {
			factory = NewPlatformTerminalProcessFactory()
		}
		s.manager = newTerminalSessionManager(factory)
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
	normalizedWorkspaceID, err := normalizeWorkspaceID(workspaceID)
	if err != nil {
		return TerminalSession{}, err
	}
	cwd, err := resolveTerminalCwd(input.Cwd)
	if err != nil {
		return TerminalSession{}, err
	}
	env := terminalProcessEnv(cwd)
	if s.RTKExecutableResolver != nil {
		rtkExecutable, resolveErr := s.RTKExecutableResolver(ctx)
		if resolveErr != nil {
			slog.WarnContext(ctx, "Tutti terminal RTK is unavailable; continuing without RTK", "error", resolveErr)
		} else {
			rtkEnv, pathErr := prependTerminalExecutablePath(env, rtkExecutable)
			if pathErr != nil {
				slog.WarnContext(ctx, "Tutti terminal RTK path is invalid; continuing without RTK", "error", pathErr)
			} else {
				env = rtkEnv
			}
		}
	}
	return s.ensureManager().create(normalizedWorkspaceID, cwd, input, env)
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
	processFactory TerminalProcessFactory
	mu             sync.Mutex
	sessions       map[string]*terminalRuntimeSession
}

func newTerminalSessionManager(factory TerminalProcessFactory) *terminalSessionManager {
	return &terminalSessionManager{
		processFactory: factory,
		sessions:       make(map[string]*terminalRuntimeSession),
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

func (m *terminalSessionManager) create(workspaceID string, cwd string, input CreateTerminalInput, env []string) (TerminalSession, error) {
	cols := normalizeTerminalDimension(input.Cols, defaultTerminalCols)
	rows := normalizeTerminalDimension(input.Rows, defaultTerminalRows)
	shellSpec := m.processFactory.DefaultShell()
	shell := shellSpec.Executable
	shellArgs := shellSpec.Args
	now := time.Now().UTC()
	id := uuid.NewString()

	process, err := m.processFactory.Start(shell, shellArgs, cwd, env, cols, rows)
	if err != nil {
		return TerminalSession{}, fmt.Errorf("start terminal pty: %w", err)
	}

	session := &terminalRuntimeSession{
		cols:        cols,
		createdAt:   now,
		cwd:         cwd,
		id:          id,
		process:     process,
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
		_, _ = process.Write([]byte(initialInput))
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
	if session.process != nil && !isEndedTerminalStatus(session.status) {
		_ = session.process.Kill()
		now := time.Now().UTC()
		session.endedAt = &now
		session.updatedAt = &now
		session.status = TerminalStatusExited
		shouldBroadcastExit = true
	}
	session.mu.Unlock()
	if session.process != nil {
		_ = session.process.Close()
	}

	if shouldBroadcastExit {
		session.broadcast(TerminalStreamEvent{
			Type:      TerminalStreamEventExit,
			SessionID: session.id,
			Status:    TerminalStatusExited,
		})
	}

	return session.snapshot(), nil
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
	process := session.process
	session.mu.Unlock()

	if process == nil {
		return TerminalSession{}, ErrTerminalNotRunning
	}
	if err := process.Resize(cols, rows); err != nil {
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
