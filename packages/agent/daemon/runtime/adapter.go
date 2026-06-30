package agentruntime

import (
	"context"

	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
)

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

type ResumeProbeAdapter interface {
	CanResume(Session) bool
}

type LiveSessionProbeAdapter interface {
	HasLiveSession(Session) bool
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

type PermissionModeAdapter interface {
	ApplyPermissionMode(context.Context, Session) error
}

type LiveSettingsAdapter interface {
	ApplySessionSettings(context.Context, Session, SessionSettingsPatch) error
}

type NewSessionSettingsAdapter interface {
	RequiresNewSessionForSettings(Session, SessionSettingsPatch) bool
}
