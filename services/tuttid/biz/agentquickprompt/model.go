package agentquickprompt

import "errors"

const (
	MaxPrompts      = 100
	MaxTitleRunes   = 80
	MaxContentBytes = 32 * 1024
)

var (
	ErrInvalidArgument = errors.New("invalid agent quick prompt request")
	ErrNotFound        = errors.New("agent quick prompt not found")
	ErrVersionConflict = errors.New("agent quick prompt version conflict")
	ErrLimitExceeded   = errors.New("agent quick prompt limit exceeded")
	ErrOrderConflict   = errors.New("agent quick prompt order conflict")
)

type Prompt struct {
	ID              string
	Title           string
	Content         string
	Version         int64
	CreatedAtUnixMS int64
	UpdatedAtUnixMS int64
}

type CreateInput struct {
	Title   string
	Content string
}

type UpdateInput struct {
	ID              string
	Title           string
	Content         string
	ExpectedVersion int64
}

type DeleteInput struct {
	ID              string
	ExpectedVersion int64
}

type MoveInput struct {
	PromptID        string
	BeforePromptID  *string
	ExpectedVersion int64
}

type ChangeKind string

const (
	ChangeKindCreated ChangeKind = "created"
	ChangeKindUpdated ChangeKind = "updated"
	ChangeKindDeleted ChangeKind = "deleted"
)

type UpdatedEvent struct {
	PromptID         string
	ChangeKind       ChangeKind
	Version          int64
	OccurredAtUnixMS int64
}
