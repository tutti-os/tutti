package modelgateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
)

func (g *Gateway) handleResponses(writer http.ResponseWriter, request *http.Request, route Route) {
	responsesInput, err := decodeResponsesRequest(request.Body, g.maxRequestBytes)
	if err != nil {
		writeInvalidRequest(writer, err)
		return
	}
	if !routeAllowsModel(route, responsesInput.Model) {
		writeResponsesError(
			writer,
			http.StatusBadRequest,
			"invalid_request_error",
			"model_not_found",
			"model",
			fmt.Sprintf("Model %q is not authorized by this Model Plan", responsesInput.Model),
		)
		return
	}
	chatInput, toolMap, err := convertResponsesRequest(responsesInput)
	if err != nil {
		writeInvalidRequest(writer, err)
		return
	}
	if len(chatInput.filteredToolTypes) > 0 {
		g.logger.DebugContext(
			request.Context(),
			"filtered untranslatable Responses tool registrations",
			"event", "model_gateway.tools.filtered",
			"workspace_id", route.WorkspaceID,
			"agent_session_id", route.AgentSessionID,
			"tool_types", strings.Join(chatInput.filteredToolTypes, ","),
			"tool_type_count", len(chatInput.filteredToolTypes),
		)
	}
	encoded, err := json.Marshal(chatInput)
	if err != nil {
		writeResponsesError(writer, http.StatusInternalServerError, "server_error", "gateway_error", "", "Could not encode upstream request")
		return
	}
	upstreamContext := request.Context()
	cancel := func() {}
	if g.requestTimeout > 0 {
		upstreamContext, cancel = context.WithTimeout(upstreamContext, g.requestTimeout)
	}
	defer cancel()
	upstreamRequest, err := http.NewRequestWithContext(
		upstreamContext,
		http.MethodPost,
		route.UpstreamURL,
		bytes.NewReader(encoded),
	)
	if err != nil {
		writeResponsesError(writer, http.StatusBadGateway, "server_error", "upstream_error", "", "Could not create upstream request")
		return
	}
	upstreamRequest.Header.Set("Authorization", "Bearer "+route.UpstreamAPIKey)
	upstreamRequest.Header.Set("Content-Type", "application/json")
	upstreamRequest.Header.Set("Accept", "application/json")
	if responsesInput.Stream {
		upstreamRequest.Header.Set("Accept", "text/event-stream")
	}
	upstreamRequest.Header.Set("User-Agent", "tuttid-model-gateway/1")
	upstreamResponse, err := g.client.Do(upstreamRequest)
	if err != nil {
		if errors.Is(upstreamContext.Err(), context.Canceled) {
			return
		}
		if errors.Is(upstreamContext.Err(), context.DeadlineExceeded) {
			writeResponsesError(writer, http.StatusGatewayTimeout, "server_error", "upstream_timeout", "", "Upstream model request timed out")
			return
		}
		writeResponsesError(writer, http.StatusBadGateway, "server_error", "upstream_error", "", "Upstream model request failed")
		return
	}
	defer upstreamResponse.Body.Close()
	if upstreamResponse.StatusCode < 200 || upstreamResponse.StatusCode >= 300 {
		writeUpstreamHTTPError(writer, upstreamResponse, route.UpstreamAPIKey)
		return
	}
	if responsesInput.Stream {
		mediaType, _, _ := mime.ParseMediaType(upstreamResponse.Header.Get("Content-Type"))
		if mediaType == "application/json" {
			var chatOutput chatCompletionResponse
			if err := json.NewDecoder(io.LimitReader(upstreamResponse.Body, g.maxRequestBytes+1)).Decode(&chatOutput); err != nil {
				writeResponsesError(writer, http.StatusBadGateway, "server_error", "upstream_error", "", "Upstream returned invalid Chat JSON")
				return
			}
			writeSyntheticStream(writer, responsesInput, chatOutput, toolMap)
			return
		}
		g.convertChatStream(writer, request, responsesInput, upstreamResponse, toolMap)
		return
	}
	var chatOutput chatCompletionResponse
	decoder := json.NewDecoder(io.LimitReader(upstreamResponse.Body, g.maxRequestBytes+1))
	if err := decoder.Decode(&chatOutput); err != nil {
		writeResponsesError(writer, http.StatusBadGateway, "server_error", "upstream_error", "", "Upstream returned invalid Chat JSON")
		return
	}
	response, err := convertChatResponse(responsesInput, chatOutput, toolMap)
	if err != nil {
		writeResponsesError(writer, http.StatusBadGateway, "server_error", "upstream_error", "", "Upstream Chat response could not be converted")
		return
	}
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(writer).Encode(response)
}

func routeAllowsModel(route Route, model string) bool {
	if len(route.Models) == 0 {
		return true
	}
	for _, allowed := range route.Models {
		if model == allowed {
			return true
		}
	}
	return false
}

func writeInvalidRequest(writer http.ResponseWriter, err error) {
	var invalid *invalidRequestError
	if errors.As(err, &invalid) {
		writeResponsesError(
			writer,
			http.StatusBadRequest,
			"invalid_request_error",
			invalid.Code,
			invalid.Param,
			invalid.Message,
		)
		return
	}
	writeResponsesError(writer, http.StatusBadRequest, "invalid_request_error", "invalid_value", "", err.Error())
}

func writeUpstreamHTTPError(writer http.ResponseWriter, response *http.Response, secret string) {
	body, _ := io.ReadAll(io.LimitReader(response.Body, defaultMaxErrorBytes))
	body = sanitizedUpstreamBody(body, secret)
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	if retryAfter := strings.TrimSpace(response.Header.Get("Retry-After")); retryAfter != "" {
		writer.Header().Set("Retry-After", retryAfter)
	}
	writer.WriteHeader(response.StatusCode)
	var payload map[string]any
	if json.Unmarshal(body, &payload) == nil {
		if _, exists := payload["error"]; exists {
			_ = json.NewEncoder(writer).Encode(payload)
			return
		}
	}
	_ = json.NewEncoder(writer).Encode(responsesErrorEnvelope{
		Error: responsesError{
			Message: fmt.Sprintf("Upstream Chat endpoint returned HTTP %d", response.StatusCode),
			Type:    "server_error",
			Code:    "upstream_error",
		},
	})
}
