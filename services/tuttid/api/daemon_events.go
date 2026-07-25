package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	eventprotocol "github.com/tutti-os/tutti/services/tuttid/api/events/generated"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

type eventStreamClientKindFrame struct {
	Kind      string `json:"kind"`
	RequestID string `json:"requestId,omitempty"`
}

type eventStreamClientPublishFrame struct {
	Kind      string          `json:"kind"`
	RequestID string          `json:"requestId"`
	Event     json.RawMessage `json:"event"`
}

func eventStreamServiceUnavailableError() tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return serviceUnavailableError(
		apierrors.EventStreamServiceUnavailable(
			apierrors.WithDeveloperMessage("event stream service is unavailable"),
		),
	)
}

func (DaemonAPI) AttachEventStream(context.Context, tuttigenerated.AttachEventStreamRequestObject) (tuttigenerated.AttachEventStreamResponseObject, error) {
	return tuttigenerated.AttachEventStream503JSONResponse{
		ServiceUnavailableErrorJSONResponse: eventStreamServiceUnavailableError(),
	}, nil
}

func (routes daemonRoutes) AttachEventStreamWebSocket(w http.ResponseWriter, r *http.Request) {
	routes.api.attachEventStreamWebSocket(w, r)
}

func (api DaemonAPI) attachEventStreamWebSocket(w http.ResponseWriter, r *http.Request) {
	if api.EventStreamService == nil {
		writeEventStreamHTTPError(
			w,
			apierrors.EventStreamServiceUnavailable(
				apierrors.WithDeveloperMessage("event stream service is unavailable"),
			),
		)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "event stream detached")

	ctx, cancel := context.WithCancel(r.Context())

	session := api.EventStreamService.OpenSession()
	defer func() {
		// Cancel first so the forwarder can distinguish ordinary handler
		// teardown from a registry-initiated close after queue overflow.
		cancel()
		api.EventStreamService.CloseSession(session)
	}()

	outbound := make(chan any, 64)
	writeErr := make(chan error, 1)

	go writeEventStreamFrames(ctx, conn, outbound, writeErr)
	go forwardEventStreamEvents(
		ctx,
		api.EventStreamService,
		session,
		outbound,
		func() {
			slog.Warn(
				"event stream subscription closed after outbound queue overflow",
				"event", "event_stream.subscription.overflow",
			)
			_ = conn.Close(
				websocket.StatusTryAgainLater,
				"event stream consumer fell behind; reconnect required",
			)
		},
	)

	if !enqueueEventStreamFrame(ctx, outbound, readyEventStreamFrame()) {
		return
	}

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

		var frameKind eventStreamClientKindFrame
		if err := json.Unmarshal(payload, &frameKind); err != nil {
			if !enqueueEventStreamFrame(ctx, outbound, eventStreamErrorFrame("", &eventstreamservice.ValidationError{
				Code:    eventstreamservice.ValidationCodeInvalidPayload,
				Message: "invalid event stream frame",
			})) {
				return
			}
			continue
		}

		switch strings.TrimSpace(frameKind.Kind) {
		case "subscribe":
			var frame eventprotocol.ClientSubscribeFrame
			if err := strictDecodeEventStreamJSON(payload, &frame); err != nil {
				if !enqueueEventStreamFrame(ctx, outbound, eventStreamErrorFrame(frameKind.RequestID, &eventstreamservice.ValidationError{
					Code:    eventstreamservice.ValidationCodeInvalidPayload,
					Message: "invalid subscribe frame",
				})) {
					return
				}
				continue
			}

			if err := api.EventStreamService.Subscribe(
				session,
				topicsFromGenerated(frame.Topics),
				eventScopeFromGenerated(frame.Scope),
			); err != nil {
				if !enqueueEventStreamFrame(ctx, outbound, eventStreamErrorFrame(frame.RequestID, err)) {
					return
				}
				continue
			}
			if !enqueueEventStreamFrame(ctx, outbound, ackEventStreamFrame(frame.RequestID)) {
				return
			}
		case "unsubscribe":
			var frame eventprotocol.ClientUnsubscribeFrame
			if err := strictDecodeEventStreamJSON(payload, &frame); err != nil {
				if !enqueueEventStreamFrame(ctx, outbound, eventStreamErrorFrame(frameKind.RequestID, &eventstreamservice.ValidationError{
					Code:    eventstreamservice.ValidationCodeInvalidPayload,
					Message: "invalid unsubscribe frame",
				})) {
					return
				}
				continue
			}

			if err := api.EventStreamService.Unsubscribe(
				session,
				topicsFromGenerated(frame.Topics),
				eventScopeFromGenerated(frame.Scope),
			); err != nil {
				if !enqueueEventStreamFrame(ctx, outbound, eventStreamErrorFrame(frame.RequestID, err)) {
					return
				}
				continue
			}
			if !enqueueEventStreamFrame(ctx, outbound, ackEventStreamFrame(frame.RequestID)) {
				return
			}
		case "publish":
			frame, event, err := parseEventStreamClientPublishFrame(payload)
			if err != nil {
				if !enqueueEventStreamFrame(ctx, outbound, eventStreamErrorFrame(frameKind.RequestID, &eventstreamservice.ValidationError{
					Code:    eventstreamservice.ValidationCodeInvalidPayload,
					Message: "invalid publish frame",
				})) {
					return
				}
				continue
			}

			if err := api.EventStreamService.PublishFromClient(ctx, event); err != nil {
				if !enqueueEventStreamFrame(ctx, outbound, eventStreamErrorFrame(frame.RequestID, err)) {
					return
				}
				continue
			}
			if !enqueueEventStreamFrame(ctx, outbound, ackEventStreamFrame(frame.RequestID)) {
				return
			}
		case "ping":
			var frame eventprotocol.ClientPingFrame
			if err := strictDecodeEventStreamJSON(payload, &frame); err != nil {
				if !enqueueEventStreamFrame(ctx, outbound, eventStreamErrorFrame(frameKind.RequestID, &eventstreamservice.ValidationError{
					Code:    eventstreamservice.ValidationCodeInvalidPayload,
					Message: "invalid ping frame",
				})) {
					return
				}
				continue
			}

			if !enqueueEventStreamFrame(ctx, outbound, eventprotocol.ServerPongFrame{
				Kind:      "pong",
				RequestID: frame.RequestID,
				SentAt:    time.Now().UTC().Format(time.RFC3339Nano),
			}) {
				return
			}
		case "pong":
			continue
		default:
			if !enqueueEventStreamFrame(ctx, outbound, eventStreamErrorFrame(frameKind.RequestID, &eventstreamservice.ValidationError{
				Code:    eventstreamservice.ValidationCodeInvalidPayload,
				Message: "unknown event stream frame",
			})) {
				return
			}
		}
	}
}

func forwardEventStreamEvents(
	ctx context.Context,
	service EventStreamService,
	session *eventstreamservice.Session,
	outbound chan<- any,
	onSubscriptionClosed func(),
) {
	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-service.Events(session):
			if !ok {
				select {
				case <-ctx.Done():
					return
				default:
				}
				if onSubscriptionClosed != nil {
					onSubscriptionClosed()
				}
				return
			}
			if !enqueueEventStreamFrame(ctx, outbound, eventprotocol.ServerEventFrame{
				Kind:  "event",
				Event: generatedEventEnvelope(event),
			}) {
				return
			}
		}
	}
}

func writeEventStreamFrames(
	ctx context.Context,
	conn *websocket.Conn,
	outbound <-chan any,
	writeErr chan<- error,
) {
	for {
		select {
		case <-ctx.Done():
			writeErr <- nil
			return
		case frame := <-outbound:
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
}

func enqueueEventStreamFrame(ctx context.Context, outbound chan<- any, frame any) bool {
	select {
	case <-ctx.Done():
		return false
	case outbound <- frame:
		return true
	}
}

func readyEventStreamFrame() eventprotocol.ServerReadyFrame {
	return eventprotocol.ServerReadyFrame{
		Kind:            "ready",
		ProtocolVersion: eventprotocol.BusinessEventProtocolVersion,
		CatalogRevision: eventprotocol.BusinessEventCatalogRevision,
		ServerTime:      time.Now().UTC().Format(time.RFC3339Nano),
	}
}

func ackEventStreamFrame(requestID string) eventprotocol.ServerAckFrame {
	return eventprotocol.ServerAckFrame{
		Kind:       "ack",
		RequestID:  strings.TrimSpace(requestID),
		AcceptedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
}

func eventStreamErrorFrame(requestID string, err error) eventprotocol.ServerErrorFrame {
	frame := eventprotocol.ServerErrorFrame{
		Kind:    "error",
		Code:    "internal_error",
		Message: err.Error(),
	}

	if trimmedRequestID := strings.TrimSpace(requestID); trimmedRequestID != "" {
		frame.RequestID = &trimmedRequestID
	}

	var validationErr *eventstreamservice.ValidationError
	if errors.As(err, &validationErr) {
		frame.Code = string(validationErr.Code)
		frame.Message = validationErr.Message
	}

	return frame
}

func topicsFromGenerated(topics []eventprotocol.Topic) []string {
	result := make([]string, 0, len(topics))
	for _, topic := range topics {
		result = append(result, string(topic))
	}
	return result
}

func generatedEventEnvelope(event eventstreamservice.PublishedEvent) eventprotocol.EventEnvelope {
	envelope := eventprotocol.EventEnvelope{
		ID:        event.ID,
		Topic:     eventprotocol.Topic(event.Topic),
		Version:   event.Version,
		EmittedAt: event.EmittedAt,
		Payload:   append(json.RawMessage(nil), event.Payload...),
	}
	if strings.TrimSpace(event.Scope.WorkspaceID) != "" {
		workspaceID := strings.TrimSpace(event.Scope.WorkspaceID)
		envelope.Scope = &eventprotocol.EventScope{
			WorkspaceID: &workspaceID,
		}
	}
	return envelope
}

func eventScopeFromGenerated(scope *eventprotocol.EventScope) eventstreamservice.EventScope {
	if scope == nil || scope.WorkspaceID == nil {
		return eventstreamservice.EventScope{}
	}
	return eventstreamservice.EventScope{WorkspaceID: *scope.WorkspaceID}
}

func writeEventStreamHTTPError(w http.ResponseWriter, err *apierrors.ProtocolError) {
	if err == nil {
		err = apierrors.ServiceUnavailable(
			apierrors.ReasonEventStreamServiceUnavailable,
			apierrors.WithDeveloperMessage("event stream service is unavailable"),
		)
	}
	tuttitypes.WriteError(
		w,
		err.StatusCode,
		string(err.Code),
		err.Reason,
		err.DeveloperMessage,
	)
}

func strictDecodeEventStreamJSON(payload []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}

	var extra json.RawMessage
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("unexpected trailing JSON content")
		}
		return err
	}
	return nil
}

func parseEventStreamClientPublishFrame(payload []byte) (eventStreamClientPublishFrame, eventstreamservice.ClientEvent, error) {
	var frame eventStreamClientPublishFrame
	if err := strictDecodeEventStreamJSON(payload, &frame); err != nil {
		return eventStreamClientPublishFrame{}, eventstreamservice.ClientEvent{}, err
	}

	var envelope eventprotocol.EventEnvelope
	if err := strictDecodeEventStreamJSON(frame.Event, &envelope); err != nil {
		return eventStreamClientPublishFrame{}, eventstreamservice.ClientEvent{}, err
	}
	if err := validateClientPublishEnvelope(envelope); err != nil {
		return eventStreamClientPublishFrame{}, eventstreamservice.ClientEvent{}, err
	}

	definition, ok := eventprotocol.LookupEventDefinition(envelope.Topic)
	if !ok {
		return eventStreamClientPublishFrame{}, eventstreamservice.ClientEvent{}, &eventstreamservice.ValidationError{
			Code:    eventstreamservice.ValidationCodeInvalidTopic,
			Message: fmt.Sprintf("unknown topic %q", strings.TrimSpace(string(envelope.Topic))),
			Topic:   strings.TrimSpace(string(envelope.Topic)),
		}
	}
	if definition.Direction != eventprotocol.DirectionClientToServer {
		return eventStreamClientPublishFrame{}, eventstreamservice.ClientEvent{}, &eventstreamservice.ValidationError{
			Code:      eventstreamservice.ValidationCodeInvalidDirection,
			Message:   fmt.Sprintf("topic %q does not allow %s", definition.Topic, eventstreamservice.DirectionClientToServer),
			Topic:     string(definition.Topic),
			Direction: eventstreamservice.DirectionClientToServer,
		}
	}
	if envelope.Version != definition.Version {
		return eventStreamClientPublishFrame{}, eventstreamservice.ClientEvent{}, &eventstreamservice.ValidationError{
			Code:      eventstreamservice.ValidationCodeInvalidPayload,
			Message:   fmt.Sprintf("event version must be %d for topic %q", definition.Version, definition.Topic),
			Topic:     string(definition.Topic),
			Direction: eventstreamservice.DirectionClientToServer,
		}
	}

	prototype, ok := eventprotocol.EventPrototypeForTopic(envelope.Topic)
	if !ok {
		return eventStreamClientPublishFrame{}, eventstreamservice.ClientEvent{}, &eventstreamservice.ValidationError{
			Code:    eventstreamservice.ValidationCodeInvalidTopic,
			Message: fmt.Sprintf("unknown topic %q", strings.TrimSpace(string(envelope.Topic))),
			Topic:   strings.TrimSpace(string(envelope.Topic)),
		}
	}
	if err := strictDecodeEventStreamJSON(frame.Event, prototype); err != nil {
		return eventStreamClientPublishFrame{}, eventstreamservice.ClientEvent{}, err
	}

	return frame, eventstreamservice.ClientEvent{
		Topic:   strings.TrimSpace(string(envelope.Topic)),
		Payload: append([]byte(nil), envelope.Payload...),
	}, nil
}

func validateClientPublishEnvelope(envelope eventprotocol.EventEnvelope) error {
	if strings.TrimSpace(envelope.ID) == "" {
		return &eventstreamservice.ValidationError{
			Code:    eventstreamservice.ValidationCodeInvalidPayload,
			Message: "event id must not be empty",
			Topic:   strings.TrimSpace(string(envelope.Topic)),
		}
	}
	if len(envelope.Payload) == 0 {
		return &eventstreamservice.ValidationError{
			Code:    eventstreamservice.ValidationCodeInvalidPayload,
			Message: "event payload is required",
			Topic:   strings.TrimSpace(string(envelope.Topic)),
		}
	}

	emittedAt := strings.TrimSpace(envelope.EmittedAt)
	if emittedAt == "" {
		return &eventstreamservice.ValidationError{
			Code:    eventstreamservice.ValidationCodeInvalidPayload,
			Message: "event emittedAt must not be empty",
			Topic:   strings.TrimSpace(string(envelope.Topic)),
		}
	}
	if _, err := time.Parse(time.RFC3339Nano, emittedAt); err != nil {
		return &eventstreamservice.ValidationError{
			Code:    eventstreamservice.ValidationCodeInvalidPayload,
			Message: "event emittedAt must be a valid RFC3339 timestamp",
			Topic:   strings.TrimSpace(string(envelope.Topic)),
		}
	}

	if envelope.Scope != nil && envelope.Scope.WorkspaceID != nil && strings.TrimSpace(*envelope.Scope.WorkspaceID) == "" {
		return &eventstreamservice.ValidationError{
			Code:    eventstreamservice.ValidationCodeInvalidPayload,
			Message: "event scope.workspaceId must not be empty",
			Topic:   strings.TrimSpace(string(envelope.Topic)),
		}
	}

	return nil
}
