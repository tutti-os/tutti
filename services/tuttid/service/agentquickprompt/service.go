package agentquickprompt

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	agentquickpromptbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentquickprompt"
)

type Store interface {
	ListAgentQuickPrompts(context.Context) ([]agentquickpromptbiz.Prompt, error)
	CountAgentQuickPrompts(context.Context) (int, error)
	CreateAgentQuickPrompt(context.Context, agentquickpromptbiz.Prompt) error
	UpdateAgentQuickPrompt(context.Context, agentquickpromptbiz.Prompt, int64) (agentquickpromptbiz.Prompt, error)
	DeleteAgentQuickPrompt(context.Context, string, int64) error
}

type EventPublisher interface {
	PublishAgentQuickPromptUpdated(context.Context, agentquickpromptbiz.UpdatedEvent) error
}

type Service struct {
	Store     Store
	Publisher EventPublisher
	Now       func() time.Time
	NewID     func() string
}

func (s Service) List(ctx context.Context) ([]agentquickpromptbiz.Prompt, error) {
	if s.Store == nil {
		return nil, errors.New("agent quick prompt store is not configured")
	}
	return s.Store.ListAgentQuickPrompts(ctx)
}

func (s Service) Create(ctx context.Context, input agentquickpromptbiz.CreateInput) (agentquickpromptbiz.Prompt, error) {
	if s.Store == nil {
		return agentquickpromptbiz.Prompt{}, errors.New("agent quick prompt store is not configured")
	}
	title, err := validateFields(input.Title, input.Content)
	if err != nil {
		return agentquickpromptbiz.Prompt{}, err
	}
	count, err := s.Store.CountAgentQuickPrompts(ctx)
	if err != nil {
		return agentquickpromptbiz.Prompt{}, err
	}
	if count >= agentquickpromptbiz.MaxPrompts {
		return agentquickpromptbiz.Prompt{}, agentquickpromptbiz.ErrLimitExceeded
	}
	now := s.now().UTC().UnixMilli()
	prompt := agentquickpromptbiz.Prompt{
		ID:              s.newID(),
		Title:           title,
		Content:         input.Content,
		Version:         1,
		CreatedAtUnixMS: now,
		UpdatedAtUnixMS: now,
	}
	if strings.TrimSpace(prompt.ID) == "" {
		return agentquickpromptbiz.Prompt{}, errors.New("agent quick prompt id generator returned an empty id")
	}
	if err := s.Store.CreateAgentQuickPrompt(ctx, prompt); err != nil {
		return agentquickpromptbiz.Prompt{}, err
	}
	s.publish(ctx, agentquickpromptbiz.UpdatedEvent{
		PromptID: prompt.ID, ChangeKind: agentquickpromptbiz.ChangeKindCreated,
		Version: prompt.Version, OccurredAtUnixMS: now,
	})
	return prompt, nil
}

func (s Service) Update(ctx context.Context, input agentquickpromptbiz.UpdateInput) (agentquickpromptbiz.Prompt, error) {
	if s.Store == nil {
		return agentquickpromptbiz.Prompt{}, errors.New("agent quick prompt store is not configured")
	}
	id := strings.TrimSpace(input.ID)
	if id == "" || input.ExpectedVersion < 1 {
		return agentquickpromptbiz.Prompt{}, agentquickpromptbiz.ErrInvalidArgument
	}
	title, err := validateFields(input.Title, input.Content)
	if err != nil {
		return agentquickpromptbiz.Prompt{}, err
	}
	now := s.now().UTC().UnixMilli()
	prompt, err := s.Store.UpdateAgentQuickPrompt(ctx, agentquickpromptbiz.Prompt{
		ID: id, Title: title, Content: input.Content,
		Version: input.ExpectedVersion + 1, UpdatedAtUnixMS: now,
	}, input.ExpectedVersion)
	if err != nil {
		return agentquickpromptbiz.Prompt{}, err
	}
	s.publish(ctx, agentquickpromptbiz.UpdatedEvent{
		PromptID: prompt.ID, ChangeKind: agentquickpromptbiz.ChangeKindUpdated,
		Version: prompt.Version, OccurredAtUnixMS: now,
	})
	return prompt, nil
}

func (s Service) Delete(ctx context.Context, input agentquickpromptbiz.DeleteInput) error {
	if s.Store == nil {
		return errors.New("agent quick prompt store is not configured")
	}
	id := strings.TrimSpace(input.ID)
	if id == "" || input.ExpectedVersion < 1 {
		return agentquickpromptbiz.ErrInvalidArgument
	}
	if err := s.Store.DeleteAgentQuickPrompt(ctx, id, input.ExpectedVersion); err != nil {
		return err
	}
	now := s.now().UTC().UnixMilli()
	s.publish(ctx, agentquickpromptbiz.UpdatedEvent{
		PromptID: id, ChangeKind: agentquickpromptbiz.ChangeKindDeleted,
		Version: input.ExpectedVersion, OccurredAtUnixMS: now,
	})
	return nil
}

func validateFields(title string, content string) (string, error) {
	title = strings.TrimSpace(title)
	if title == "" || utf8.RuneCountInString(title) > agentquickpromptbiz.MaxTitleRunes {
		return "", agentquickpromptbiz.ErrInvalidArgument
	}
	if strings.TrimSpace(content) == "" || len([]byte(content)) > agentquickpromptbiz.MaxContentBytes {
		return "", agentquickpromptbiz.ErrInvalidArgument
	}
	return title, nil
}

func (s Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s Service) newID() string {
	if s.NewID != nil {
		return s.NewID()
	}
	return uuid.NewString()
}

func (s Service) publish(ctx context.Context, event agentquickpromptbiz.UpdatedEvent) {
	if s.Publisher == nil {
		return
	}
	if err := s.Publisher.PublishAgentQuickPromptUpdated(ctx, event); err != nil {
		slog.Warn("agent quick prompt invalidation publish failed",
			"event", "agent.quick_prompt.invalidation_publish_failed",
			"prompt_id", event.PromptID,
			"change_kind", event.ChangeKind,
			"version", event.Version,
			"error", err,
		)
	}
}
