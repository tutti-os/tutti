package agentruntime

import (
	"context"
	"errors"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

var ErrLiveSessionBusy = errors.New("agent live session is busy")

type ProcessSpec struct {
	Provider             string
	AgentSessionID       string
	RoomID               string
	CWD                  string
	Command              []string
	Env                  []string
	OpenclawGatewayReady bool
	DirectStart          bool
}

type ProcessFrame struct {
	Stdout   []byte
	Stderr   []byte
	ExitCode *int
	Message  string
}

type ProcessConnection interface {
	Send([]byte) error
	Recv() (ProcessFrame, error)
	Close() error
}

type GracefulProcessConnection interface {
	ProcessConnection
	CloseInput() error
	Terminate() error
	Kill() error
}

type ProcessTransport interface {
	Start(context.Context, ProcessSpec) (ProcessConnection, error)
}

type EventSink func([]activityshared.Event)
type SessionEventSink func(string, []activityshared.Event)
type CommandSnapshotSink func(AgentSessionCommandSnapshot)
type ConfigOptionsUpdateSink func(AgentSessionConfigOptionsUpdate)

type Adapter interface {
	Provider() string
	Start(context.Context, Session) ([]activityshared.Event, error)
	Resume(context.Context, Session) error
	Close(context.Context, Session) error
	Exec(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error)
	Cancel(context.Context, Session, string) ([]activityshared.Event, error)
}

type AsyncExecAdapter interface {
	ExecAsync(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) error
}

type ActiveTurnGuidanceAdapter interface {
	GuideActiveTurn(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error)
}

type ResumeProbeAdapter interface {
	CanResume(Session) bool
}

type LiveSessionProbeAdapter interface {
	HasLiveSession(Session) bool
}

type LiveSessionReleaseAdapter interface {
	ReleaseLiveSession(context.Context, Session) error
}

type StateAdapter interface {
	SessionState(Session) SessionStateSnapshot
}

type CommandSnapshotAdapter interface {
	SessionCommandSnapshot(Session) (AgentSessionCommandSnapshot, bool)
}

type CommandSnapshotSinkAdapter interface {
	SetCommandSnapshotSink(CommandSnapshotSink)
}

type SessionEventSinkAdapter interface {
	SetSessionEventSink(SessionEventSink)
}

type ConfigOptionsUpdateSinkAdapter interface {
	SetConfigOptionsUpdateSink(ConfigOptionsUpdateSink)
}

type InteractiveAdapter interface {
	SubmitInteractive(context.Context, Session, SubmitInteractiveInput) (SubmitInteractiveResult, error)
}

type PromptContentAdapter interface {
	ValidatePromptContent(Session, []PromptContentBlock) error
}

// GoalControlAction is a direct goal operation invoked from the GUI (banner
// buttons) without going through the prompt pipeline.
type GoalControlAction string

const (
	GoalControlPause  GoalControlAction = "pause"
	GoalControlResume GoalControlAction = "resume"
	GoalControlClear  GoalControlAction = "clear"
	GoalControlSet    GoalControlAction = "set"
)

// GoalControlAdapter executes goal operations as thread-level calls without
// opening a turn, so they keep working while another turn holds the session's
// turn slot.
type GoalControlAdapter interface {
	// GoalControl performs a direct goal action (UI buttons). It returns the
	// session events to apply/publish and the fresh goal snapshot (nil after
	// clear).
	GoalControl(ctx context.Context, session Session, action GoalControlAction, objective string) (events []activityshared.Event, goal map[string]any, err error)
	// ExecGoalControl handles a typed "/goal …" prompt while a turn is
	// active. handled reports whether the prompt was a goal command.
	ExecGoalControl(ctx context.Context, session Session, content []PromptContentBlock, displayPrompt string, turnID string) (events []activityshared.Event, handled bool, err error)
}

type PermissionModeAdapter interface {
	ApplyPermissionMode(context.Context, Session) error
}

type LiveSettingsAdapter interface {
	ApplySessionSettings(context.Context, Session, SessionSettingsPatch) error
}

type NewSessionSettingsAdapter interface {
	RequiresNewSessionForSettings(Session, SessionSettingsPatch) bool
}
