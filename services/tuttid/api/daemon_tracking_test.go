package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
)

type recordingAnalyticsReporter struct {
	events []reporterservice.Event
	closed bool
}

func (r *recordingAnalyticsReporter) Track(_ context.Context, events ...reporterservice.Event) {
	r.events = append(r.events, events...)
}

func (r *recordingAnalyticsReporter) Close() error {
	r.closed = true
	return nil
}

func TestTrackEventsAcceptsEvents(t *testing.T) {
	reporter := &recordingAnalyticsReporter{}
	params := map[string]interface{}{"source": "dashboard"}
	request := tuttigenerated.TrackEventsRequestObject{
		Body: &tuttigenerated.TrackEventsRequest{
			Events: []tuttigenerated.TrackEvent{
				{
					Name:     "workspace.opened",
					ClientTs: 1749124800000,
					Params:   &params,
				},
				{
					Name:     "app.pageview",
					ClientTs: 1749124800010,
				},
			},
		},
	}

	response, err := DaemonAPI{AnalyticsReporter: reporter}.TrackEvents(context.Background(), request)
	if err != nil {
		t.Fatalf("TrackEvents() error = %v", err)
	}
	if _, ok := response.(tuttigenerated.TrackEvents202Response); !ok {
		t.Fatalf("response = %T, want %T", response, tuttigenerated.TrackEvents202Response{})
	}
	if len(reporter.events) != 2 {
		t.Fatalf("forwarded events = %d, want 2", len(reporter.events))
	}

	event := reporter.events[0]
	if event.Name != "workspace.opened" {
		t.Fatalf("event.Name = %q, want %q", event.Name, "workspace.opened")
	}
	if event.ClientTS != 1749124800000 {
		t.Fatalf("event.ClientTS = %d, want %d", event.ClientTS, int64(1749124800000))
	}
	if !reflect.DeepEqual(event.Params, map[string]any{"source": "dashboard"}) {
		t.Fatalf("event.Params = %#v, want source dashboard", event.Params)
	}

	event.Params["source"] = "mutated"
	if params["source"] != "dashboard" {
		t.Fatalf("request params were mutated through reporter params: %#v", params)
	}

	pageviewEvent := reporter.events[1]
	if pageviewEvent.Name != "app.pageview" {
		t.Fatalf("pageview event.Name = %q, want %q", pageviewEvent.Name, "app.pageview")
	}
	if pageviewEvent.ClientTS != 1749124800010 {
		t.Fatalf("pageview event.ClientTS = %d, want %d", pageviewEvent.ClientTS, int64(1749124800010))
	}
	if pageviewEvent.Params != nil {
		t.Fatalf("pageview event.Params = %#v, want nil", pageviewEvent.Params)
	}
}

func TestTrackEventsRouteRequiresNonEmptyBody(t *testing.T) {
	reporter := &recordingAnalyticsReporter{}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{AnalyticsReporter: reporter}))

	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/track",
		strings.NewReader(`{"events":[]}`),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	mux.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", response.Code, http.StatusBadRequest, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "analytics_events_required") {
		t.Fatalf("body does not include analytics_events_required: %s", response.Body.String())
	}
	if len(reporter.events) != 0 {
		t.Fatalf("forwarded events = %d, want 0", len(reporter.events))
	}
}

func TestTrackEventsRejectsInvalidEventShape(t *testing.T) {
	validEvent := tuttigenerated.TrackEvent{
		Name:     "workspace.opened",
		ClientTs: 1749124800000,
	}
	tooManyEvents := make([]tuttigenerated.TrackEvent, 101)
	for i := range tooManyEvents {
		tooManyEvents[i] = validEvent
	}

	tests := []struct {
		name       string
		events     []tuttigenerated.TrackEvent
		wantReason string
	}{
		{
			name:       "over event limit",
			events:     tooManyEvents,
			wantReason: "analytics_events_limit_exceeded",
		},
		{
			name: "empty name",
			events: []tuttigenerated.TrackEvent{
				{Name: "", ClientTs: 1749124800000},
			},
			wantReason: "analytics_event_name_invalid",
		},
		{
			name: "bad pattern name",
			events: []tuttigenerated.TrackEvent{
				{Name: "ClickWorkspaceCreate", ClientTs: 1749124800000},
			},
			wantReason: "analytics_event_name_invalid",
		},
		{
			name: "legacy single segment pageview name",
			events: []tuttigenerated.TrackEvent{
				{Name: "predefine_pageview", ClientTs: 1749124800000},
			},
			wantReason: "analytics_event_name_invalid",
		},
		{
			name: "too long name",
			events: []tuttigenerated.TrackEvent{
				{Name: strings.Repeat("a", 129), ClientTs: 1749124800000},
			},
			wantReason: "analytics_event_name_invalid",
		},
		{
			name: "zero client timestamp",
			events: []tuttigenerated.TrackEvent{
				{Name: "workspace.opened", ClientTs: 0},
			},
			wantReason: "analytics_event_client_ts_invalid",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reporter := &recordingAnalyticsReporter{}
			request := tuttigenerated.TrackEventsRequestObject{
				Body: &tuttigenerated.TrackEventsRequest{
					Events: tt.events,
				},
			}

			response, err := DaemonAPI{AnalyticsReporter: reporter}.TrackEvents(context.Background(), request)
			if err != nil {
				t.Fatalf("TrackEvents() error = %v", err)
			}
			if _, ok := response.(tuttigenerated.TrackEvents400JSONResponse); !ok {
				t.Fatalf("response = %T, want %T", response, tuttigenerated.TrackEvents400JSONResponse{})
			}
			if !trackEventsResponseContains(t, response, tt.wantReason) {
				t.Fatalf("response does not include %s", tt.wantReason)
			}
			if len(reporter.events) != 0 {
				t.Fatalf("forwarded events = %d, want 0", len(reporter.events))
			}
		})
	}
}

func TestTrackEventsRouteValidatesBeforeReporterAvailability(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{}))

	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/track",
		strings.NewReader(`{"events":[{"client_ts":1749124800000}]}`),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	mux.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", response.Code, http.StatusBadRequest, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "analytics_event_name_invalid") {
		t.Fatalf("body does not include analytics_event_name_invalid: %s", response.Body.String())
	}
}

func TestTrackEventsRouteRejectsMissingClientTimestamp(t *testing.T) {
	reporter := &recordingAnalyticsReporter{}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{AnalyticsReporter: reporter}))

	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/track",
		strings.NewReader(`{"events":[{"name":"workspace.opened"}]}`),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	mux.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", response.Code, http.StatusBadRequest, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "analytics_event_client_ts_invalid") {
		t.Fatalf("body does not include analytics_event_client_ts_invalid: %s", response.Body.String())
	}
	if len(reporter.events) != 0 {
		t.Fatalf("forwarded events = %d, want 0", len(reporter.events))
	}
}

func TestTrackEventsRouteRejectsNonPostMethods(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{}))

	request := httptest.NewRequest(http.MethodGet, "/v1/track", nil)
	response := httptest.NewRecorder()

	mux.ServeHTTP(response, request)

	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d; body: %s", response.Code, http.StatusMethodNotAllowed, response.Body.String())
	}
}

func TestTrackEventsRouteRejectsInvalidJSONBody(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "empty body", body: ""},
		{name: "malformed json", body: `{"events":[`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mux := http.NewServeMux()
			RegisterRoutes(mux, NewRoutes(DaemonAPI{AnalyticsReporter: &recordingAnalyticsReporter{}}))

			request := httptest.NewRequest(http.MethodPost, "/v1/track", strings.NewReader(tt.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()

			mux.ServeHTTP(response, request)

			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body: %s", response.Code, http.StatusBadRequest, response.Body.String())
			}
		})
	}
}

func TestTrackEventsRouteReturnsUnavailableWithoutReporter(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{}))

	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/track",
		strings.NewReader(`{"events":[{"name":"workspace.opened","client_ts":1749124800000,"params":{"source":"dashboard"}}]}`),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	mux.ServeHTTP(response, request)

	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d; body: %s", response.Code, http.StatusServiceUnavailable, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "analytics_reporter_unavailable") {
		t.Fatalf("body does not include analytics_reporter_unavailable: %s", response.Body.String())
	}
}

func trackEventsResponseContains(t *testing.T, response tuttigenerated.TrackEventsResponseObject, text string) bool {
	t.Helper()

	recorder := httptest.NewRecorder()
	if err := response.VisitTrackEventsResponse(recorder); err != nil {
		t.Fatalf("VisitTrackEventsResponse() error = %v", err)
	}
	return strings.Contains(recorder.Body.String(), text)
}
