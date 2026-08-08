package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func TestDaemonAPIGeneratedRoutesReadAgentSessionAttachment(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			readAttachmentFn: func(_ context.Context, workspaceID string, agentSessionID string, attachmentID string) (agentservice.PromptAttachment, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
				}
				if agentSessionID != "session-1" {
					t.Fatalf("agentSessionID = %q, want session-1", agentSessionID)
				}
				if attachmentID != "attachment-1" {
					t.Fatalf("attachmentID = %q, want attachment-1", attachmentID)
				}
				return agentservice.PromptAttachment{
					AttachmentID: attachmentID,
					MimeType:     "image/png",
					Data:         "aW1hZ2U=",
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/ws-1/agent-sessions/session-1/attachments/attachment-1",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceAgentSessionAttachmentResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.AttachmentId != "attachment-1" {
		t.Fatalf("attachmentId = %q, want attachment-1", response.AttachmentId)
	}
	if response.MimeType != tuttigenerated.Imagepng {
		t.Fatalf("mimeType = %q, want image/png", response.MimeType)
	}
	if response.Data != "aW1hZ2U=" {
		t.Fatalf("data = %q, want base64 payload", response.Data)
	}
}

func TestDaemonAPIGeneratedRoutesListAgentSessionMessages(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			listMessagesFn: func(_ context.Context, workspaceID string, agentSessionID string, input agentservice.ListMessagesInput) (agentservice.SessionMessagesPage, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
				}
				if agentSessionID != "agent-session-1" {
					t.Fatalf("agentSessionID = %q, want agent-session-1", agentSessionID)
				}
				if input.BeforeVersion != 9 {
					t.Fatalf("beforeVersion = %d, want 9", input.BeforeVersion)
				}
				if input.Order != agentactivitybiz.MessageOrderDesc {
					t.Fatalf("order = %q, want desc", input.Order)
				}
				if input.Limit != 25 {
					t.Fatalf("limit = %d, want 25", input.Limit)
				}
				return agentservice.SessionMessagesPage{
					AgentSessionID: agentSessionID,
					Messages: []agentservice.SessionMessage{
						{
							ID:              8,
							AgentSessionID:  agentSessionID,
							MessageID:       "msg-1",
							TurnID:          "turn-1",
							Role:            "assistant",
							Kind:            "text",
							Payload:         map[string]any{"content": "Done."},
							StartedAtUnixMS: 1717200001000,
							Version:         8,
						},
					},
					LatestVersion: 8,
					HasMore:       false,
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/ws-1/agent-sessions/agent-session-1/messages?beforeVersion=9&order=desc&limit=25",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceAgentSessionMessagesResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if response.AgentSessionId != "agent-session-1" {
		t.Fatalf("agentSessionId = %q, want agent-session-1", response.AgentSessionId)
	}
	if response.LatestVersion != 8 {
		t.Fatalf("latestVersion = %d, want 8", response.LatestVersion)
	}
	if response.HasMore {
		t.Fatal("hasMore = true, want false")
	}
	if len(response.Messages) != 1 {
		t.Fatalf("len(messages) = %d, want 1", len(response.Messages))
	}
	if response.Messages[0].MessageId != "msg-1" {
		t.Fatalf("messageId = %q, want msg-1", response.Messages[0].MessageId)
	}
	if response.Messages[0].Sequence != 8 {
		t.Fatalf("sequence = %d, want durable message id 8", response.Messages[0].Sequence)
	}
	if response.Messages[0].TurnId == nil || *response.Messages[0].TurnId != "turn-1" {
		t.Fatalf("turnId = %v, want turn-1", response.Messages[0].TurnId)
	}
	if response.Messages[0].OccurredAtUnixMs != 1717200001000 {
		t.Fatalf("occurredAtUnixMs = %d, want startedAt fallback", response.Messages[0].OccurredAtUnixMs)
	}
}

// Protocol v2: messages without turn attribution are legitimate
// session-level messages and project turnId null instead of failing.
func TestDaemonAPIGeneratedRoutesProjectTurnlessAgentSessionMessagesAsSessionLevel(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			listMessagesFn: func(_ context.Context, _ string, agentSessionID string, _ agentservice.ListMessagesInput) (agentservice.SessionMessagesPage, error) {
				return agentservice.SessionMessagesPage{
					AgentSessionID: agentSessionID,
					Messages: []agentservice.SessionMessage{
						{
							ID:              8,
							AgentSessionID:  agentSessionID,
							MessageID:       "msg-turnless",
							Role:            "assistant",
							Kind:            "text",
							Payload:         map[string]any{"content": "Done."},
							StartedAtUnixMS: 1717200001000,
							Version:         8,
						},
					},
					LatestVersion: 8,
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/ws-1/agent-sessions/agent-session-1/messages",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceAgentSessionMessagesResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("unmarshal response error = %v", err)
	}
	if len(response.Messages) != 1 {
		t.Fatalf("len(messages) = %d, want 1", len(response.Messages))
	}
	if response.Messages[0].TurnId != nil {
		t.Fatalf("turnId = %v, want null", *response.Messages[0].TurnId)
	}
}

func TestGeneratedWorkspaceAgentSafeIntegerBounds(t *testing.T) {
	t.Parallel()

	value, err := generatedWorkspaceAgentSafeInteger(
		"message version",
		maxWorkspaceAgentJSONSafeInteger,
	)
	if err != nil {
		t.Fatalf("maximum safe integer rejected: %v", err)
	}
	if value != int64(maxWorkspaceAgentJSONSafeInteger) {
		t.Fatalf("value = %d, want %d", value, maxWorkspaceAgentJSONSafeInteger)
	}
	if _, err := generatedWorkspaceAgentSafeInteger(
		"message version",
		maxWorkspaceAgentJSONSafeInteger+1,
	); err == nil {
		t.Fatal("maximum safe integer plus one accepted")
	}
}

func TestDaemonAPIGeneratedRoutesAcceptSafeAgentMessageCursorQueries(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			listMessagesFn: func(_ context.Context, _ string, _ string, input agentservice.ListMessagesInput) (agentservice.SessionMessagesPage, error) {
				if input.AfterVersion != maxWorkspaceAgentJSONSafeInteger {
					t.Fatalf("afterVersion = %d, want %d", input.AfterVersion, maxWorkspaceAgentJSONSafeInteger)
				}
				if input.BeforeVersion != maxWorkspaceAgentJSONSafeInteger {
					t.Fatalf("beforeVersion = %d, want %d", input.BeforeVersion, maxWorkspaceAgentJSONSafeInteger)
				}
				return agentservice.SessionMessagesPage{
					AgentSessionID: "agent-session-1",
					Messages:       []agentservice.SessionMessage{},
					LatestVersion:  maxWorkspaceAgentJSONSafeInteger,
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		fmt.Sprintf(
			"/v1/workspaces/ws-1/agent-sessions/agent-session-1/messages?afterVersion=%d&beforeVersion=%d",
			maxWorkspaceAgentJSONSafeInteger,
			maxWorkspaceAgentJSONSafeInteger,
		),
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
}

func TestDaemonAPIGeneratedRoutesRejectUnsafeAgentMessageCursorQueries(t *testing.T) {
	for _, parameter := range []string{"afterVersion", "beforeVersion"} {
		t.Run(parameter, func(t *testing.T) {
			mux := http.NewServeMux()
			RegisterRoutes(mux, NewRoutes(DaemonAPI{
				AgentSessionService: stubAgentSessionService{
					listMessagesFn: func(context.Context, string, string, agentservice.ListMessagesInput) (agentservice.SessionMessagesPage, error) {
						t.Fatal("unsafe cursor reached the service")
						return agentservice.SessionMessagesPage{}, nil
					},
				},
			}))

			recorder := performGeneratedRouteRequest(
				t,
				mux,
				http.MethodGet,
				fmt.Sprintf(
					"/v1/workspaces/ws-1/agent-sessions/agent-session-1/messages?%s=%d",
					parameter,
					maxWorkspaceAgentJSONSafeInteger+1,
				),
				nil,
			)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
			}
		})
	}
}

func TestDaemonAPIGeneratedRoutesRejectUnsafeAgentMessageResponseIntegers(t *testing.T) {
	tests := []struct {
		name string
		page agentservice.SessionMessagesPage
	}{
		{
			name: "sequence",
			page: agentservice.SessionMessagesPage{
				AgentSessionID: "agent-session-1",
				LatestVersion:  1,
				Messages: []agentservice.SessionMessage{{
					ID:             maxWorkspaceAgentJSONSafeInteger + 1,
					AgentSessionID: "agent-session-1",
					MessageID:      "message-1",
					Kind:           "text",
					Role:           "assistant",
					Version:        1,
				}},
			},
		},
		{
			name: "message version",
			page: agentservice.SessionMessagesPage{
				AgentSessionID: "agent-session-1",
				LatestVersion:  maxWorkspaceAgentJSONSafeInteger + 1,
				Messages: []agentservice.SessionMessage{{
					ID:             1,
					AgentSessionID: "agent-session-1",
					MessageID:      "message-1",
					Kind:           "text",
					Role:           "assistant",
					Version:        maxWorkspaceAgentJSONSafeInteger + 1,
				}},
			},
		},
		{
			name: "latest version",
			page: agentservice.SessionMessagesPage{
				AgentSessionID: "agent-session-1",
				LatestVersion:  maxWorkspaceAgentJSONSafeInteger + 1,
				Messages:       []agentservice.SessionMessage{},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			mux := http.NewServeMux()
			RegisterRoutes(mux, NewRoutes(DaemonAPI{
				AgentSessionService: stubAgentSessionService{
					listMessagesFn: func(context.Context, string, string, agentservice.ListMessagesInput) (agentservice.SessionMessagesPage, error) {
						return test.page, nil
					},
				},
			}))

			recorder := performGeneratedRouteRequest(
				t,
				mux,
				http.MethodGet,
				"/v1/workspaces/ws-1/agent-sessions/agent-session-1/messages",
				nil,
			)
			if recorder.Code != http.StatusBadGateway {
				t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadGateway, recorder.Body.String())
			}
		})
	}
}

func TestDaemonAPIGeneratedRoutesRejectUnsafeSessionMessageVersion(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			getDetailFn: func(context.Context, string, string) (agentservice.SessionDetail, error) {
				return agentservice.SessionDetail{
					Session: agentservice.Session{
						ID:             "agent-session-1",
						Kind:           agentactivitybiz.SessionKindRoot,
						MessageVersion: maxWorkspaceAgentJSONSafeInteger + 1,
						Provider:       "codex",
						RailSectionKey: "conversations",
						CreatedAt:      time.UnixMilli(1),
					},
					ChildSessions: []agentservice.Session{},
					Turns:         []agentactivitybiz.Turn{},
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/ws-1/agent-sessions/agent-session-1",
		nil,
	)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadGateway, recorder.Body.String())
	}
}

func TestDaemonAPIGeneratedRoutesListAgentGeneratedFiles(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			listGeneratedFilesFn: func(_ context.Context, workspaceID string, input agentservice.ListGeneratedFilesInput) (agentservice.GeneratedFileList, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
				}
				if input.Query != "report" {
					t.Fatalf("query = %q, want report", input.Query)
				}
				if input.SectionKey != "project:/workspace" {
					t.Fatalf("sectionKey = %q, want project:/workspace", input.SectionKey)
				}
				if input.Limit != 25 {
					t.Fatalf("limit = %d, want 25", input.Limit)
				}
				if input.Cursor != "v1:25" {
					t.Fatalf("cursor = %q, want v1:25", input.Cursor)
				}
				return agentservice.GeneratedFileList{
					WorkspaceID: workspaceID,
					HasMore:     true,
					NextCursor:  "v1:50",
					Files: []agentservice.GeneratedFile{
						{
							Label: "report.md",
							Path:  "/workspace/report.md",
						},
					},
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/ws-1/agent-generated-files?query=report&sectionKey=project%3A%2Fworkspace&agentTargetIds=local%3Acodex&agentTargetIds=local%3Aclaude-code&cursor=v1%3A25&limit=25",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	var response tuttigenerated.WorkspaceAgentGeneratedFileListResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if response.WorkspaceId != "ws-1" {
		t.Fatalf("workspaceId = %q, want ws-1", response.WorkspaceId)
	}
	if len(response.Entries) != 1 {
		t.Fatalf("len(entries) = %d, want 1", len(response.Entries))
	}
	if response.Entries[0].Path != "/workspace/report.md" {
		t.Fatalf("entry path = %q, want /workspace/report.md", response.Entries[0].Path)
	}
	if !response.HasMore || response.NextCursor == nil || *response.NextCursor != "v1:50" {
		t.Fatalf("pagination = hasMore:%v nextCursor:%v", response.HasMore, response.NextCursor)
	}
}

func TestDaemonAPIGeneratedRoutesRejectsTooManyAgentTargetFilters(t *testing.T) {
	mux := http.NewServeMux()
	serviceCalls := 0
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			listGeneratedFilesFn: func(context.Context, string, agentservice.ListGeneratedFilesInput) (agentservice.GeneratedFileList, error) {
				serviceCalls++
				return agentservice.GeneratedFileList{}, nil
			},
		},
	}))

	query := make(url.Values)
	query.Set("sectionKey", "conversations")
	for index := 0; index <= agentservice.MaxGeneratedFileAgentTargetFilters; index++ {
		query.Add("agentTargetIds", fmt.Sprintf("agent-%d", index))
	}
	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/ws-1/agent-generated-files?"+query.Encode(),
		nil,
	)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}
	if serviceCalls != 0 {
		t.Fatalf("service calls = %d, want 0", serviceCalls)
	}
}
