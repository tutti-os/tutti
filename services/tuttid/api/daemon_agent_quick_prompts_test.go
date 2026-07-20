package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentquickpromptbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentquickprompt"
)

type stubAgentQuickPromptService struct {
	listFn   func(context.Context) ([]agentquickpromptbiz.Prompt, error)
	createFn func(context.Context, agentquickpromptbiz.CreateInput) (agentquickpromptbiz.Prompt, error)
	updateFn func(context.Context, agentquickpromptbiz.UpdateInput) (agentquickpromptbiz.Prompt, error)
	deleteFn func(context.Context, agentquickpromptbiz.DeleteInput) error
	moveFn   func(context.Context, agentquickpromptbiz.MoveInput) ([]agentquickpromptbiz.Prompt, error)
}

func (s stubAgentQuickPromptService) Move(ctx context.Context, input agentquickpromptbiz.MoveInput) ([]agentquickpromptbiz.Prompt, error) {
	if s.moveFn != nil {
		return s.moveFn(ctx, input)
	}
	return s.listFn(ctx)
}

func (s stubAgentQuickPromptService) List(ctx context.Context) ([]agentquickpromptbiz.Prompt, error) {
	return s.listFn(ctx)
}
func (s stubAgentQuickPromptService) Create(ctx context.Context, input agentquickpromptbiz.CreateInput) (agentquickpromptbiz.Prompt, error) {
	return s.createFn(ctx, input)
}
func (s stubAgentQuickPromptService) Update(ctx context.Context, input agentquickpromptbiz.UpdateInput) (agentquickpromptbiz.Prompt, error) {
	return s.updateFn(ctx, input)
}
func (s stubAgentQuickPromptService) Delete(ctx context.Context, input agentquickpromptbiz.DeleteInput) error {
	return s.deleteFn(ctx, input)
}

func TestDaemonAPIRoutesAgentQuickPromptCRUD(t *testing.T) {
	prompt := agentquickpromptbiz.Prompt{ID: "prompt-1", Title: "Title", Content: "private body", Version: 1, CreatedAtUnixMS: 10, UpdatedAtUnixMS: 10}
	service := stubAgentQuickPromptService{
		listFn: func(context.Context) ([]agentquickpromptbiz.Prompt, error) {
			return []agentquickpromptbiz.Prompt{prompt}, nil
		},
		createFn: func(_ context.Context, input agentquickpromptbiz.CreateInput) (agentquickpromptbiz.Prompt, error) {
			if input.Content != prompt.Content {
				t.Fatalf("create input = %#v", input)
			}
			return prompt, nil
		},
		updateFn: func(_ context.Context, input agentquickpromptbiz.UpdateInput) (agentquickpromptbiz.Prompt, error) {
			if input.ID != prompt.ID || input.ExpectedVersion != 1 {
				t.Fatalf("update input = %#v", input)
			}
			prompt.Version = 2
			return prompt, nil
		},
		deleteFn: func(_ context.Context, input agentquickpromptbiz.DeleteInput) error {
			if input.ID != prompt.ID || input.ExpectedVersion != 2 {
				t.Fatalf("delete input = %#v", input)
			}
			return nil
		},
		moveFn: func(_ context.Context, input agentquickpromptbiz.MoveInput) ([]agentquickpromptbiz.Prompt, error) {
			if input.PromptID != prompt.ID || input.ExpectedVersion != 2 || input.BeforePromptID != nil {
				t.Fatalf("move input = %#v", input)
			}
			prompt.Version = 3
			return []agentquickpromptbiz.Prompt{prompt}, nil
		},
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{AgentQuickPromptService: service}))

	list := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/agent-quick-prompts", nil)
	if list.Code != http.StatusOK {
		t.Fatalf("list status = %d; body: %s", list.Code, list.Body.String())
	}
	var listResponse tuttigenerated.AgentQuickPromptListResponse
	decodeGeneratedRouteResponse(t, list, &listResponse)
	if len(listResponse.Prompts) != 1 || listResponse.Prompts[0].Content != "private body" {
		t.Fatalf("list response = %#v", listResponse)
	}

	create := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/agent-quick-prompts", map[string]any{"title": prompt.Title, "content": prompt.Content})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d; body: %s", create.Code, create.Body.String())
	}

	update := performGeneratedRouteRequest(t, mux, http.MethodPut, "/v1/agent-quick-prompts/prompt-1", map[string]any{"title": prompt.Title, "content": prompt.Content, "expectedVersion": 1})
	if update.Code != http.StatusOK {
		t.Fatalf("update status = %d; body: %s", update.Code, update.Body.String())
	}

	move := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/agent-quick-prompts/move", map[string]any{"promptId": prompt.ID, "beforePromptId": nil, "expectedVersion": 2})
	if move.Code != http.StatusOK {
		t.Fatalf("move status = %d; body: %s", move.Code, move.Body.String())
	}

	deleteResponse := performGeneratedRouteRequest(t, mux, http.MethodDelete, "/v1/agent-quick-prompts/prompt-1", map[string]any{"expectedVersion": 2})
	if deleteResponse.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d; body: %s", deleteResponse.Code, deleteResponse.Body.String())
	}
}

func TestDaemonAPIRoutesAgentQuickPromptMoveRejectsOmittedAnchor(t *testing.T) {
	called := false
	service := stubAgentQuickPromptService{
		moveFn: func(context.Context, agentquickpromptbiz.MoveInput) ([]agentquickpromptbiz.Prompt, error) {
			called = true
			return nil, nil
		},
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{AgentQuickPromptService: service}))
	response := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/agent-quick-prompts/move", map[string]any{"promptId": "prompt-1", "expectedVersion": 1})
	if response.Code != http.StatusBadRequest {
		t.Fatalf("move status = %d; body: %s", response.Code, response.Body.String())
	}
	if called {
		t.Fatal("Move called for request missing beforePromptId")
	}
}

func TestDaemonAPIRoutesAgentQuickPromptMoveMapsAnchorAndOrderConflict(t *testing.T) {
	anchor := "prompt-2"
	service := stubAgentQuickPromptService{
		moveFn: func(_ context.Context, input agentquickpromptbiz.MoveInput) ([]agentquickpromptbiz.Prompt, error) {
			if input.BeforePromptID == nil || *input.BeforePromptID != anchor {
				t.Fatalf("move input = %#v", input)
			}
			return nil, agentquickpromptbiz.ErrOrderConflict
		},
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{AgentQuickPromptService: service}))
	response := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/agent-quick-prompts/move", map[string]any{
		"promptId": "prompt-1", "beforePromptId": anchor, "expectedVersion": 1,
	})
	if response.Code != http.StatusConflict {
		t.Fatalf("move status = %d; body: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"reason":"agent_quick_prompt_order_conflict"`) {
		t.Fatalf("move conflict body = %s", response.Body.String())
	}
}

func TestDaemonAPIAgentQuickPromptErrorsDoNotExposeContent(t *testing.T) {
	const secret = "do-not-expose-this-secret"
	tests := []struct {
		name   string
		err    error
		status int
	}{
		{name: "invalid", err: agentquickpromptbiz.ErrInvalidArgument, status: http.StatusBadRequest},
		{name: "missing", err: agentquickpromptbiz.ErrNotFound, status: http.StatusNotFound},
		{name: "conflict", err: agentquickpromptbiz.ErrVersionConflict, status: http.StatusConflict},
		{name: "storage", err: errors.New("storage unavailable: " + secret), status: http.StatusBadGateway},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := stubAgentQuickPromptService{
				listFn: func(context.Context) ([]agentquickpromptbiz.Prompt, error) { return nil, test.err },
				createFn: func(context.Context, agentquickpromptbiz.CreateInput) (agentquickpromptbiz.Prompt, error) {
					return agentquickpromptbiz.Prompt{}, test.err
				},
				updateFn: func(context.Context, agentquickpromptbiz.UpdateInput) (agentquickpromptbiz.Prompt, error) {
					return agentquickpromptbiz.Prompt{}, test.err
				},
				deleteFn: func(context.Context, agentquickpromptbiz.DeleteInput) error { return test.err },
			}
			mux := http.NewServeMux()
			RegisterRoutes(mux, NewRoutes(DaemonAPI{AgentQuickPromptService: service}))
			response := performGeneratedRouteRequest(t, mux, http.MethodPut, "/v1/agent-quick-prompts/prompt-1", map[string]any{"title": "title", "content": secret, "expectedVersion": 1})
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d; body: %s", response.Code, test.status, response.Body.String())
			}
			if strings.Contains(response.Body.String(), secret) {
				t.Fatalf("error response exposes content: %s", response.Body.String())
			}
		})
	}
}

func TestDaemonAPIAgentQuickPromptServiceUnavailable(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{}))
	response := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/agent-quick-prompts", nil)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d; body: %s", response.Code, response.Body.String())
	}
}
