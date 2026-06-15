package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/coder/websocket"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func terminalServiceUnavailableError() tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return serviceUnavailableError(
		apierrors.WorkspaceTerminalServiceUnavailable(
			apierrors.WithDeveloperMessage("workspace terminal service is unavailable"),
		),
	)
}

func (api DaemonAPI) ListWorkspaceTerminals(ctx context.Context, request tuttigenerated.ListWorkspaceTerminalsRequestObject) (tuttigenerated.ListWorkspaceTerminalsResponseObject, error) {
	if api.TerminalService == nil {
		return tuttigenerated.ListWorkspaceTerminals503JSONResponse{
			ServiceUnavailableErrorJSONResponse: terminalServiceUnavailableError(),
		}, nil
	}
	sessions, err := api.TerminalService.List(ctx, string(request.WorkspaceID))
	if err != nil {
		return writeListWorkspaceTerminalsError(err), nil
	}
	return tuttigenerated.ListWorkspaceTerminals200JSONResponse{
		Terminals:   generatedTerminalSessions(sessions),
		WorkspaceId: string(request.WorkspaceID),
	}, nil
}

func (api DaemonAPI) CreateWorkspaceTerminal(ctx context.Context, request tuttigenerated.CreateWorkspaceTerminalRequestObject) (tuttigenerated.CreateWorkspaceTerminalResponseObject, error) {
	if api.TerminalService == nil {
		return tuttigenerated.CreateWorkspaceTerminal503JSONResponse{
			ServiceUnavailableErrorJSONResponse: terminalServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.CreateWorkspaceTerminal400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body"))),
		}, nil
	}
	session, err := api.TerminalService.Create(ctx, string(request.WorkspaceID), workspaceservice.CreateTerminalInput{
		Cols:         request.Body.Cols,
		Cwd:          request.Body.Cwd,
		InitialInput: request.Body.InitialInput,
		ProfileID:    request.Body.ProfileId,
		Rows:         request.Body.Rows,
	})
	if err != nil {
		return writeCreateWorkspaceTerminalError(err), nil
	}
	return tuttigenerated.CreateWorkspaceTerminal201JSONResponse{
		Terminal: generatedTerminalSession(session),
	}, nil
}

func (api DaemonAPI) GetWorkspaceTerminal(ctx context.Context, request tuttigenerated.GetWorkspaceTerminalRequestObject) (tuttigenerated.GetWorkspaceTerminalResponseObject, error) {
	if api.TerminalService == nil {
		return tuttigenerated.GetWorkspaceTerminal503JSONResponse{
			ServiceUnavailableErrorJSONResponse: terminalServiceUnavailableError(),
		}, nil
	}
	session, err := api.TerminalService.Get(ctx, string(request.WorkspaceID), string(request.TerminalID))
	if err != nil {
		return writeGetWorkspaceTerminalError(err), nil
	}
	return tuttigenerated.GetWorkspaceTerminal200JSONResponse{
		Terminal: generatedTerminalSession(session),
	}, nil
}

func (api DaemonAPI) TerminateWorkspaceTerminal(ctx context.Context, request tuttigenerated.TerminateWorkspaceTerminalRequestObject) (tuttigenerated.TerminateWorkspaceTerminalResponseObject, error) {
	if api.TerminalService == nil {
		return tuttigenerated.TerminateWorkspaceTerminal503JSONResponse{
			ServiceUnavailableErrorJSONResponse: terminalServiceUnavailableError(),
		}, nil
	}
	session, err := api.TerminalService.Terminate(ctx, string(request.WorkspaceID), string(request.TerminalID))
	if err != nil {
		return writeTerminateWorkspaceTerminalError(err), nil
	}
	return tuttigenerated.TerminateWorkspaceTerminal200JSONResponse{
		Terminal: generatedTerminalSession(session),
	}, nil
}

func (api DaemonAPI) CheckWorkspaceTerminalCloseGuard(ctx context.Context, request tuttigenerated.CheckWorkspaceTerminalCloseGuardRequestObject) (tuttigenerated.CheckWorkspaceTerminalCloseGuardResponseObject, error) {
	if api.TerminalService == nil {
		return tuttigenerated.CheckWorkspaceTerminalCloseGuard503JSONResponse{
			ServiceUnavailableErrorJSONResponse: terminalServiceUnavailableError(),
		}, nil
	}
	guard, err := api.TerminalService.CloseGuard(ctx, string(request.WorkspaceID), string(request.TerminalID))
	if err != nil {
		return writeCheckWorkspaceTerminalCloseGuardError(err), nil
	}
	return tuttigenerated.CheckWorkspaceTerminalCloseGuard200JSONResponse{
		Guard: generatedTerminalCloseGuard(guard),
	}, nil
}

func (api DaemonAPI) ResizeWorkspaceTerminal(ctx context.Context, request tuttigenerated.ResizeWorkspaceTerminalRequestObject) (tuttigenerated.ResizeWorkspaceTerminalResponseObject, error) {
	if api.TerminalService == nil {
		return tuttigenerated.ResizeWorkspaceTerminal503JSONResponse{
			ServiceUnavailableErrorJSONResponse: terminalServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.ResizeWorkspaceTerminal400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body"))),
		}, nil
	}
	session, err := api.TerminalService.Resize(ctx, string(request.WorkspaceID), string(request.TerminalID), workspaceservice.ResizeTerminalInput{
		Cols: request.Body.Cols,
		Rows: request.Body.Rows,
	})
	if err != nil {
		return writeResizeWorkspaceTerminalError(err), nil
	}
	return tuttigenerated.ResizeWorkspaceTerminal200JSONResponse{
		Terminal: generatedTerminalSession(session),
	}, nil
}

func (api DaemonAPI) GetWorkspaceTerminalSnapshot(ctx context.Context, request tuttigenerated.GetWorkspaceTerminalSnapshotRequestObject) (tuttigenerated.GetWorkspaceTerminalSnapshotResponseObject, error) {
	if api.TerminalService == nil {
		return tuttigenerated.GetWorkspaceTerminalSnapshot503JSONResponse{
			ServiceUnavailableErrorJSONResponse: terminalServiceUnavailableError(),
		}, nil
	}
	snapshot, err := api.TerminalService.Snapshot(ctx, string(request.WorkspaceID), string(request.TerminalID))
	if err != nil {
		return writeGetWorkspaceTerminalSnapshotError(err), nil
	}
	return tuttigenerated.GetWorkspaceTerminalSnapshot200JSONResponse{
		Snapshot: generatedTerminalSnapshot(snapshot),
	}, nil
}

func (DaemonAPI) AttachWorkspaceTerminal(context.Context, tuttigenerated.AttachWorkspaceTerminalRequestObject) (tuttigenerated.AttachWorkspaceTerminalResponseObject, error) {
	return tuttigenerated.AttachWorkspaceTerminal503JSONResponse{
		ServiceUnavailableErrorJSONResponse: terminalServiceUnavailableError(),
	}, nil
}

type terminalWebSocketClientFrame struct {
	Cols     *int   `json:"cols,omitempty"`
	Data     string `json:"data,omitempty"`
	Encoding string `json:"encoding,omitempty"`
	Rows     *int   `json:"rows,omitempty"`
	Type     string `json:"type"`
}

type terminalWebSocketServerFrame struct {
	Data        string                                   `json:"data,omitempty"`
	Error       *string                                  `json:"error,omitempty"`
	FromSeq     *int64                                   `json:"fromSeq,omitempty"`
	Seq         *int64                                   `json:"seq,omitempty"`
	SessionID   string                                   `json:"sessionId"`
	Status      workspaceservice.TerminalStatus          `json:"status,omitempty"`
	ToSeq       *int64                                   `json:"toSeq,omitempty"`
	Type        workspaceservice.TerminalStreamEventType `json:"type"`
	Code        *int                                     `json:"code,omitempty"`
	Signal      *string                                  `json:"signal,omitempty"`
	Cwd         *string                                  `json:"cwd,omitempty"`
	ProfileID   *string                                  `json:"profileId,omitempty"`
	RuntimeKind *string                                  `json:"runtimeKind,omitempty"`
	Title       *string                                  `json:"title,omitempty"`
}

func (routes daemonRoutes) AttachWorkspaceTerminalWebSocket(w http.ResponseWriter, r *http.Request) {
	routes.api.attachWorkspaceTerminalWebSocket(w, r)
}

func (api DaemonAPI) attachWorkspaceTerminalWebSocket(w http.ResponseWriter, r *http.Request) {
	if api.TerminalService == nil {
		writeTerminalWebSocketError(
			w,
			apierrors.WorkspaceTerminalServiceUnavailable(
				apierrors.WithDeveloperMessage("workspace terminal service is unavailable"),
			),
		)
		return
	}

	workspaceID := r.PathValue("workspaceID")
	terminalID := r.PathValue("terminalID")
	var afterSeq *int64
	if rawAfterSeq := r.URL.Query().Get("afterSeq"); rawAfterSeq != "" {
		parsed, err := strconv.ParseInt(rawAfterSeq, 10, 64)
		if err != nil {
			writeTerminalWebSocketError(
				w,
				apierrors.MalformedRequest(apierrors.WithDeveloperMessage("afterSeq must be an integer")),
			)
			return
		}
		afterSeq = &parsed
	}

	stream, err := api.TerminalService.AttachStream(r.Context(), workspaceID, terminalID, workspaceservice.AttachTerminalInput{
		AfterSeq: afterSeq,
	})
	if err != nil {
		writeTerminalWebSocketError(w, apierrors.Classify(err))
		return
	}
	defer stream.Close()

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "terminal detached")

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	writeErr := make(chan error, 1)
	go func() {
		for {
			select {
			case <-ctx.Done():
				writeErr <- nil
				return
			case event := <-stream.Events:
				frame := terminalWebSocketServerFrame{
					Data:        event.Data,
					Error:       event.Error,
					FromSeq:     event.FromSeq,
					Seq:         event.Seq,
					SessionID:   event.SessionID,
					Status:      event.Status,
					ToSeq:       event.ToSeq,
					Type:        event.Type,
					Code:        event.Code,
					Signal:      event.Signal,
					Cwd:         event.Cwd,
					ProfileID:   event.ProfileID,
					RuntimeKind: event.RuntimeKind,
					Title:       event.Title,
				}
				payload, err := json.Marshal(frame)
				if err != nil {
					writeErr <- err
					return
				}
				if err := conn.Write(ctx, websocket.MessageText, payload); err != nil {
					writeErr <- err
					return
				}
			}
		}
	}()

	for {
		select {
		case err := <-writeErr:
			if err != nil {
				_ = conn.Close(websocket.StatusInternalError, err.Error())
			}
			return
		default:
		}

		messageType, payload, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if messageType != websocket.MessageText && messageType != websocket.MessageBinary {
			continue
		}
		var frame terminalWebSocketClientFrame
		if err := json.Unmarshal(payload, &frame); err != nil {
			_ = conn.Close(websocket.StatusInvalidFramePayloadData, "invalid terminal frame")
			return
		}
		switch frame.Type {
		case "input":
			payload := frame.Data
			if frame.Encoding == "binary" {
				decoded, err := base64.StdEncoding.DecodeString(frame.Data)
				if err != nil {
					_ = conn.Close(websocket.StatusInvalidFramePayloadData, "binary terminal input must be base64 encoded")
					return
				}
				payload = string(decoded)
			}
			if err := api.TerminalService.Write(ctx, workspaceID, terminalID, payload); err != nil {
				_ = conn.Close(websocket.StatusInternalError, err.Error())
				return
			}
		case "resize":
			if frame.Cols == nil || frame.Rows == nil {
				_ = conn.Close(websocket.StatusInvalidFramePayloadData, "resize requires cols and rows")
				return
			}
			if _, err := api.TerminalService.Resize(ctx, workspaceID, terminalID, workspaceservice.ResizeTerminalInput{
				Cols: *frame.Cols,
				Rows: *frame.Rows,
			}); err != nil {
				_ = conn.Close(websocket.StatusInternalError, err.Error())
				return
			}
		case "detach":
			return
		case "ping":
			continue
		default:
			_ = conn.Close(websocket.StatusInvalidFramePayloadData, "unknown terminal frame")
			return
		}
	}
}

func writeTerminalWebSocketError(w http.ResponseWriter, err *apierrors.ProtocolError) {
	if err == nil {
		err = apierrors.WorkspaceOperationFailed()
	}
	tuttitypes.WriteError(
		w,
		err.StatusCode,
		string(err.Code),
		err.Reason,
		err.DeveloperMessage,
	)
}

func generatedTerminalSessions(sessions []workspaceservice.TerminalSession) []tuttigenerated.WorkspaceTerminalSession {
	result := make([]tuttigenerated.WorkspaceTerminalSession, 0, len(sessions))
	for _, session := range sessions {
		result = append(result, generatedTerminalSession(session))
	}
	return result
}

func generatedTerminalSession(session workspaceservice.TerminalSession) tuttigenerated.WorkspaceTerminalSession {
	return tuttigenerated.WorkspaceTerminalSession{
		Cols:        session.Cols,
		CreatedAt:   session.CreatedAt,
		Cwd:         session.Cwd,
		EndedAt:     session.EndedAt,
		Id:          session.ID,
		LastError:   session.LastError,
		ProfileId:   session.ProfileID,
		Rows:        session.Rows,
		RuntimeKind: tuttigenerated.Local,
		Status:      generatedTerminalStatus(session.Status),
		Title:       session.Title,
		UpdatedAt:   session.UpdatedAt,
		WorkspaceId: session.WorkspaceID,
	}
}

func generatedTerminalStatus(status workspaceservice.TerminalStatus) tuttigenerated.WorkspaceTerminalStatus {
	switch status {
	case workspaceservice.TerminalStatusCreated:
		return tuttigenerated.WorkspaceTerminalStatusCreated
	case workspaceservice.TerminalStatusStarting:
		return tuttigenerated.WorkspaceTerminalStatusStarting
	case workspaceservice.TerminalStatusDetached:
		return tuttigenerated.WorkspaceTerminalStatusDetached
	case workspaceservice.TerminalStatusExited:
		return tuttigenerated.WorkspaceTerminalStatusExited
	case workspaceservice.TerminalStatusFailed:
		return tuttigenerated.WorkspaceTerminalStatusFailed
	default:
		return tuttigenerated.WorkspaceTerminalStatusRunning
	}
}

func generatedTerminalCloseGuard(guard workspaceservice.TerminalCloseGuard) tuttigenerated.WorkspaceTerminalCloseGuard {
	return tuttigenerated.WorkspaceTerminalCloseGuard{
		LeaderCommand:        guard.LeaderCommand,
		Reason:               generatedTerminalCloseGuardReason(guard.Reason),
		RequiresConfirmation: guard.RequiresConfirmation,
		Status:               generatedTerminalStatus(guard.Status),
	}
}

func generatedTerminalCloseGuardReason(reason string) tuttigenerated.WorkspaceTerminalCloseGuardReason {
	switch reason {
	case "foreground-process":
		return tuttigenerated.WorkspaceTerminalCloseGuardReasonForegroundProcess
	case "not-running":
		return tuttigenerated.WorkspaceTerminalCloseGuardReasonNotRunning
	case "running":
		return tuttigenerated.WorkspaceTerminalCloseGuardReasonRunning
	default:
		return tuttigenerated.WorkspaceTerminalCloseGuardReasonUnknown
	}
}

func generatedTerminalSnapshot(snapshot workspaceservice.TerminalSnapshot) tuttigenerated.WorkspaceTerminalSnapshot {
	return tuttigenerated.WorkspaceTerminalSnapshot{
		Data:      snapshot.Data,
		FromSeq:   snapshot.FromSeq,
		ToSeq:     snapshot.ToSeq,
		Truncated: snapshot.Truncated,
		UpdatedAt: snapshot.UpdatedAt,
	}
}
