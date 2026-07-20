package agentquickprompt

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	agentquickpromptbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentquickprompt"
)

type stubStore struct {
	count       int
	created     agentquickpromptbiz.Prompt
	updateErr   error
	deleteErr   error
	movePrompts []agentquickpromptbiz.Prompt
	moveChanged bool
	moveErr     error
}

func (*stubStore) ListAgentQuickPrompts(context.Context) ([]agentquickpromptbiz.Prompt, error) {
	return nil, nil
}
func (s *stubStore) CountAgentQuickPrompts(context.Context) (int, error) { return s.count, nil }
func (s *stubStore) CreateAgentQuickPrompt(_ context.Context, prompt agentquickpromptbiz.Prompt) error {
	s.created = prompt
	return nil
}
func (s *stubStore) UpdateAgentQuickPrompt(_ context.Context, prompt agentquickpromptbiz.Prompt, _ int64) (agentquickpromptbiz.Prompt, error) {
	if s.updateErr != nil {
		return agentquickpromptbiz.Prompt{}, s.updateErr
	}
	prompt.CreatedAtUnixMS = 1
	return prompt, nil
}
func (s *stubStore) DeleteAgentQuickPrompt(context.Context, string, int64) error { return s.deleteErr }
func (s *stubStore) MoveAgentQuickPrompt(context.Context, string, *string, int64, int64) ([]agentquickpromptbiz.Prompt, bool, error) {
	return s.movePrompts, s.moveChanged, s.moveErr
}

type recordingPublisher struct {
	events []agentquickpromptbiz.UpdatedEvent
	err    error
}

func (p *recordingPublisher) PublishAgentQuickPromptUpdated(_ context.Context, event agentquickpromptbiz.UpdatedEvent) error {
	p.events = append(p.events, event)
	return p.err
}

func TestServiceCreateNormalizesAndPublishesAfterCommit(t *testing.T) {
	store := &stubStore{}
	publisher := &recordingPublisher{}
	service := Service{
		Store: store, Publisher: publisher,
		Now:   func() time.Time { return time.UnixMilli(1234) },
		NewID: func() string { return "prompt-1" },
	}
	prompt, err := service.Create(context.Background(), agentquickpromptbiz.CreateInput{Title: "  标题  ", Content: "line one\nline two"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if prompt.Title != "标题" || prompt.Version != 1 || store.created.Content != "line one\nline two" {
		t.Fatalf("created prompt = %#v", prompt)
	}
	if len(publisher.events) != 1 || publisher.events[0].ChangeKind != agentquickpromptbiz.ChangeKindCreated || publisher.events[0].OccurredAtUnixMS != 1234 {
		t.Fatalf("events = %#v", publisher.events)
	}
}

func TestServiceValidationAndLimit(t *testing.T) {
	tests := []struct {
		name  string
		input agentquickpromptbiz.CreateInput
	}{
		{name: "blank title", input: agentquickpromptbiz.CreateInput{Title: " ", Content: "content"}},
		{name: "too many unicode code points", input: agentquickpromptbiz.CreateInput{Title: strings.Repeat("界", agentquickpromptbiz.MaxTitleRunes+1), Content: "content"}},
		{name: "blank content", input: agentquickpromptbiz.CreateInput{Title: "title", Content: " \n "}},
		{name: "content bytes", input: agentquickpromptbiz.CreateInput{Title: "title", Content: strings.Repeat("界", agentquickpromptbiz.MaxContentBytes/3+1)}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := (Service{Store: &stubStore{}}).Create(context.Background(), test.input)
			if !errors.Is(err, agentquickpromptbiz.ErrInvalidArgument) {
				t.Fatalf("Create() error = %v, want invalid argument", err)
			}
		})
	}
	_, err := (Service{Store: &stubStore{count: agentquickpromptbiz.MaxPrompts}}).Create(context.Background(), agentquickpromptbiz.CreateInput{Title: strings.Repeat("界", agentquickpromptbiz.MaxTitleRunes), Content: "content"})
	if !errors.Is(err, agentquickpromptbiz.ErrLimitExceeded) {
		t.Fatalf("limit error = %v, want limit exceeded", err)
	}
}

func TestServicePreservesMutationConflictAndDoesNotPublish(t *testing.T) {
	publisher := &recordingPublisher{}
	store := &stubStore{updateErr: agentquickpromptbiz.ErrVersionConflict, deleteErr: agentquickpromptbiz.ErrNotFound}
	service := Service{Store: store, Publisher: publisher}
	_, err := service.Update(context.Background(), agentquickpromptbiz.UpdateInput{ID: "prompt-1", Title: "title", Content: "content", ExpectedVersion: 2})
	if !errors.Is(err, agentquickpromptbiz.ErrVersionConflict) {
		t.Fatalf("Update() error = %v, want version conflict", err)
	}
	if err := service.Delete(context.Background(), agentquickpromptbiz.DeleteInput{ID: "prompt-1", ExpectedVersion: 2}); !errors.Is(err, agentquickpromptbiz.ErrNotFound) {
		t.Fatalf("Delete() error = %v, want not found", err)
	}
	if len(publisher.events) != 0 {
		t.Fatalf("events = %#v, want none", publisher.events)
	}
}

func TestServicePublisherFailureDoesNotRollBackCommittedCreate(t *testing.T) {
	store := &stubStore{}
	publisher := &recordingPublisher{err: errors.New("publisher unavailable")}
	_, err := (Service{Store: store, Publisher: publisher, NewID: func() string { return "prompt-1" }}).Create(context.Background(), agentquickpromptbiz.CreateInput{Title: "title", Content: "content"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if store.created.ID != "prompt-1" {
		t.Fatalf("created ID = %q", store.created.ID)
	}
}

func TestServiceMoveValidatesAndPublishesOnlyChangedOrder(t *testing.T) {
	prompt := agentquickpromptbiz.Prompt{ID: "prompt-1", Version: 3, UpdatedAtUnixMS: 100}
	store := &stubStore{movePrompts: []agentquickpromptbiz.Prompt{prompt}, moveChanged: true}
	publisher := &recordingPublisher{}
	service := Service{Store: store, Publisher: publisher, Now: func() time.Time { return time.UnixMilli(100) }}
	prompts, err := service.Move(context.Background(), agentquickpromptbiz.MoveInput{
		PromptID: " prompt-1 ", ExpectedVersion: 2,
	})
	if err != nil || len(prompts) != 1 {
		t.Fatalf("Move() prompts = %#v, error = %v", prompts, err)
	}
	if len(publisher.events) != 1 || publisher.events[0].PromptID != "prompt-1" || publisher.events[0].Version != 3 {
		t.Fatalf("move events = %#v", publisher.events)
	}
	store.moveChanged = false
	if _, err := service.Move(context.Background(), agentquickpromptbiz.MoveInput{PromptID: "prompt-1", ExpectedVersion: 3}); err != nil {
		t.Fatalf("no-op Move() error = %v", err)
	}
	if len(publisher.events) != 1 {
		t.Fatalf("no-op published event = %#v", publisher.events)
	}
	publisher.err = errors.New("publisher unavailable")
	store.moveChanged = true
	if _, err := service.Move(context.Background(), agentquickpromptbiz.MoveInput{PromptID: "prompt-1", ExpectedVersion: 3}); err != nil {
		t.Fatalf("committed Move() returned publisher failure = %v", err)
	}
	empty := "  "
	if _, err := service.Move(context.Background(), agentquickpromptbiz.MoveInput{PromptID: "prompt-1", BeforePromptID: &empty, ExpectedVersion: 3}); !errors.Is(err, agentquickpromptbiz.ErrInvalidArgument) {
		t.Fatalf("blank anchor error = %v, want invalid argument", err)
	}
}
