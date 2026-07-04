package api

import (
	"context"
	"regexp"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
)

const (
	maxTrackEventsPerRequest = 100
	maxTrackEventNameLength  = 128
)

var trackEventNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`)

func (api DaemonAPI) TrackEvents(ctx context.Context, request tuttigenerated.TrackEventsRequestObject) (tuttigenerated.TrackEventsResponseObject, error) {
	if response := validateTrackEventsRequest(request); response != nil {
		return response, nil
	}
	if api.AnalyticsReporter == nil {
		return tuttigenerated.TrackEvents503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable(
					"analytics_reporter_unavailable",
					apierrors.WithDeveloperMessage("analytics reporter is not configured"),
				),
			),
		}, nil
	}
	events := make([]reporterservice.Event, 0, len(request.Body.Events))
	for _, event := range request.Body.Events {
		events = append(events, reporterservice.Event{
			Name:     event.Name,
			ClientTS: event.ClientTs,
			Params:   copyTrackEventParams(event.Params),
		})
	}
	api.AnalyticsReporter.Track(ctx, events...)

	return tuttigenerated.TrackEvents202Response{}, nil
}

func validateTrackEventsRequest(request tuttigenerated.TrackEventsRequestObject) tuttigenerated.TrackEventsResponseObject {
	if request.Body == nil || len(request.Body.Events) == 0 {
		return tuttigenerated.TrackEvents400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.InvalidRequest(
					"analytics_events_required",
					apierrors.WithDeveloperMessage("analytics events are required"),
				),
			),
		}
	}
	if len(request.Body.Events) > maxTrackEventsPerRequest {
		return tuttigenerated.TrackEvents400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.InvalidRequest(
					"analytics_events_limit_exceeded",
					apierrors.WithDeveloperMessage("analytics events must not exceed 100"),
				),
			),
		}
	}
	for _, event := range request.Body.Events {
		if !isValidTrackEventName(event.Name) {
			return tuttigenerated.TrackEvents400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(
					apierrors.InvalidRequest(
						"analytics_event_name_invalid",
						apierrors.WithDeveloperMessage("analytics event name is invalid"),
					),
				),
			}
		}
		if event.ClientTs < 1 {
			return tuttigenerated.TrackEvents400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(
					apierrors.InvalidRequest(
						"analytics_event_client_ts_invalid",
						apierrors.WithDeveloperMessage("analytics event client_ts is invalid"),
					),
				),
			}
		}
	}
	return nil
}

func isValidTrackEventName(name string) bool {
	return len(name) > 0 &&
		len(name) <= maxTrackEventNameLength &&
		trackEventNamePattern.MatchString(name)
}

func copyTrackEventParams(params *map[string]interface{}) map[string]any {
	if params == nil {
		return nil
	}
	result := make(map[string]any, len(*params))
	for key, value := range *params {
		result[key] = value
	}
	return result
}
