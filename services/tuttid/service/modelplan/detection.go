package modelplan

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
)

// Failure reason and remedy codes are machine-readable; UI layers localize
// them. Raw provider errors go into StageResult.Detail with credentials never
// included.
const (
	FailureConnection       = "connection_failed"
	FailureUnauthorized     = "unauthorized"
	FailureCatalogNotFound  = "model_catalog_unavailable"
	FailureCatalogDecode    = "model_catalog_decode_failed"
	FailureNoModel          = "no_model_selected"
	FailureModelRejected    = "model_rejected"
	FailureInference        = "inference_failed"
	RemedyCheckNetwork      = "check_network_or_base_url"
	RemedyCheckAPIKey       = "check_api_key"
	RemedyAddModelsManually = "add_models_manually"
	RemedyCheckModelID      = "check_model_id"
	RemedySelectModel       = "select_model"
)

var ErrDetectionInput = errors.New("invalid model plan detection input")

// DetectInput drives one staged detection run. When PlanID is set the run
// reuses stored fields for anything omitted and persists the outcome; without
// PlanID it verifies an unsaved draft.
type DetectInput struct {
	WorkspaceID string
	PlanID      string
	Protocol    string
	BaseURL     string
	// APIKey nil reuses the stored plan credential.
	APIKey *string
	Models []modelplanbiz.Model
	// Model selects the inference-stage model; defaults to the plan default
	// model, then the first known model.
	Model string
}

// DetectResult carries the staged outcome plus any models discovered during
// the model-discovery stage so the UI can offer them for selection.
type DetectResult struct {
	Detection        modelplanbiz.DetectionSnapshot
	DiscoveredModels []modelplanbiz.Model
}

// Detect runs the daemon-verifiable stages in order: network, auth, model
// discovery, minimal real inference. The agent_runtime stage stays pending
// until the plan completes its first real agent call.
func (s *Service) Detect(ctx context.Context, input DetectInput) (DetectResult, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	planID := strings.TrimSpace(input.PlanID)

	var stored modelplanbiz.Plan
	hasStored := false
	if planID != "" {
		plan, err := s.Store.GetModelPlan(ctx, workspaceID, planID)
		if err != nil {
			return DetectResult{}, err
		}
		stored = plan
		hasStored = true
	}

	protocol := modelplanbiz.Protocol(strings.TrimSpace(input.Protocol))
	if protocol == "" && hasStored {
		protocol = stored.Protocol
	}
	if !modelplanbiz.IsProtocol(string(protocol)) {
		return DetectResult{}, fmt.Errorf("%w: protocol is unsupported", ErrDetectionInput)
	}
	baseURL := strings.TrimSpace(input.BaseURL)
	if baseURL == "" && hasStored {
		baseURL = stored.BaseURL
	}
	apiKey := ""
	if input.APIKey != nil {
		apiKey = strings.TrimSpace(*input.APIKey)
	} else if hasStored {
		apiKey = stored.APIKey
	}
	models := modelplanbiz.NormalizeModels(input.Models)
	if len(models) == 0 && hasStored {
		models = stored.Models
	}
	inferenceModel := strings.TrimSpace(input.Model)
	if inferenceModel == "" && hasStored {
		inferenceModel = stored.DefaultModel
	}
	if inferenceModel == "" && len(models) > 0 {
		inferenceModel = models[0].ID
	}

	now := s.now()
	snapshot := modelplanbiz.DetectionSnapshot{CheckedAt: now, Model: inferenceModel}
	var discovered []modelplanbiz.Model

	networkResult := s.checkNetwork(ctx, protocol, baseURL, now)
	snapshot.Stages = append(snapshot.Stages, networkResult)

	authResult := modelplanbiz.StageResult{Stage: modelplanbiz.StageAuth, Status: modelplanbiz.StageSkipped, CheckedAt: now}
	discoveryResult := modelplanbiz.StageResult{Stage: modelplanbiz.StageModelDiscovery, Status: modelplanbiz.StageSkipped, CheckedAt: now}
	inferenceResult := modelplanbiz.StageResult{Stage: modelplanbiz.StageInference, Status: modelplanbiz.StageSkipped, CheckedAt: now}

	if networkResult.Status == modelplanbiz.StagePassed {
		authResult, discoveryResult, discovered = s.checkAuthAndDiscovery(ctx, protocol, baseURL, apiKey, models, now)
		if authResult.Status != modelplanbiz.StageFailed {
			inferenceResult = s.checkInference(ctx, protocol, baseURL, apiKey, inferenceModel, now)
			if inferenceResult.Status == modelplanbiz.StageFailed && inferenceResult.FailureReason == FailureUnauthorized {
				// Inference is the authoritative credential check when the
				// catalog endpoint could not verify the key.
				authResult = modelplanbiz.StageResult{
					Stage:         modelplanbiz.StageAuth,
					Status:        modelplanbiz.StageFailed,
					FailureReason: FailureUnauthorized,
					Remedy:        RemedyCheckAPIKey,
					CheckedAt:     now,
				}
			} else if inferenceResult.Status == modelplanbiz.StagePassed && authResult.Status == modelplanbiz.StageSkipped {
				authResult = modelplanbiz.StageResult{Stage: modelplanbiz.StageAuth, Status: modelplanbiz.StagePassed, CheckedAt: now}
			}
		}
	}

	snapshot.Stages = append(snapshot.Stages, authResult, discoveryResult, inferenceResult)

	agentStage := modelplanbiz.StageResult{Stage: modelplanbiz.StageAgentRuntime, Status: modelplanbiz.StagePending, CheckedAt: now}
	if hasStored {
		if existing, ok := stored.Detection.StageOutcome(modelplanbiz.StageAgentRuntime); ok && existing.Status == modelplanbiz.StagePassed && stored.FirstUse.Status == modelplanbiz.FirstUseCompleted {
			agentStage = existing
		}
	}
	snapshot.Stages = append(snapshot.Stages, agentStage)

	if hasStored {
		stored.Detection = snapshot
		stored.UpdatedAt = now
		if err := s.Store.PutModelPlan(ctx, stored); err != nil {
			return DetectResult{}, err
		}
	}

	return DetectResult{Detection: snapshot, DiscoveredModels: discovered}, nil
}

func (s *Service) checkNetwork(ctx context.Context, protocol modelplanbiz.Protocol, baseURL string, now time.Time) modelplanbiz.StageResult {
	catalogURLs, err := planModelCatalogURLs(protocol, baseURL)
	if err != nil || len(catalogURLs) == 0 {
		return modelplanbiz.StageResult{
			Stage:         modelplanbiz.StageNetwork,
			Status:        modelplanbiz.StageFailed,
			FailureReason: FailureConnection,
			Remedy:        RemedyCheckNetwork,
			Detail:        "invalid base url",
			CheckedAt:     now,
		}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, catalogURLs[0], nil)
	if err != nil {
		return modelplanbiz.StageResult{
			Stage:         modelplanbiz.StageNetwork,
			Status:        modelplanbiz.StageFailed,
			FailureReason: FailureConnection,
			Remedy:        RemedyCheckNetwork,
			CheckedAt:     now,
		}
	}
	started := time.Now()
	response, err := s.httpClient().Do(request)
	latency := time.Since(started).Milliseconds()
	if err != nil {
		return modelplanbiz.StageResult{
			Stage:         modelplanbiz.StageNetwork,
			Status:        modelplanbiz.StageFailed,
			LatencyMs:     latency,
			FailureReason: FailureConnection,
			Remedy:        RemedyCheckNetwork,
			Detail:        sanitizeTransportError(err),
			CheckedAt:     now,
		}
	}
	response.Body.Close()
	// Any HTTP response proves the endpoint is reachable; status handling
	// belongs to the auth stage.
	return modelplanbiz.StageResult{Stage: modelplanbiz.StageNetwork, Status: modelplanbiz.StagePassed, LatencyMs: latency, CheckedAt: now}
}

func (s *Service) checkAuthAndDiscovery(ctx context.Context, protocol modelplanbiz.Protocol, baseURL string, apiKey string, manualModels []modelplanbiz.Model, now time.Time) (modelplanbiz.StageResult, modelplanbiz.StageResult, []modelplanbiz.Model) {
	auth := modelplanbiz.StageResult{Stage: modelplanbiz.StageAuth, CheckedAt: now}
	discovery := modelplanbiz.StageResult{Stage: modelplanbiz.StageModelDiscovery, CheckedAt: now}
	if apiKey == "" {
		auth.Status = modelplanbiz.StageFailed
		auth.FailureReason = FailureUnauthorized
		auth.Remedy = RemedyCheckAPIKey
		discovery.Status = modelplanbiz.StageSkipped
		return auth, discovery, nil
	}
	catalogURLs, err := planModelCatalogURLs(protocol, baseURL)
	if err != nil {
		auth.Status = modelplanbiz.StageSkipped
		discovery.Status = modelplanbiz.StageFailed
		discovery.FailureReason = FailureCatalogNotFound
		discovery.Remedy = RemedyAddModelsManually
		return auth, discovery, nil
	}
	var lastStatus int
	for _, catalogURL := range catalogURLs {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, catalogURL, nil)
		if err != nil {
			continue
		}
		applyPlanAuthHeaders(request, protocol, apiKey)
		request.Header.Set("Accept", "application/json")
		started := time.Now()
		response, err := s.httpClient().Do(request)
		latency := time.Since(started).Milliseconds()
		if err != nil {
			auth.Status = modelplanbiz.StageSkipped
			discovery.Status = modelplanbiz.StageFailed
			discovery.LatencyMs = latency
			discovery.FailureReason = FailureConnection
			discovery.Remedy = RemedyCheckNetwork
			discovery.Detail = sanitizeTransportError(err)
			return auth, discovery, nil
		}
		switch {
		case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
			response.Body.Close()
			auth.Status = modelplanbiz.StageFailed
			auth.LatencyMs = latency
			auth.FailureReason = FailureUnauthorized
			auth.Remedy = RemedyCheckAPIKey
			discovery.Status = modelplanbiz.StageSkipped
			return auth, discovery, nil
		case response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusMethodNotAllowed:
			response.Body.Close()
			continue
		case response.StatusCode >= http.StatusOK && response.StatusCode < http.StatusMultipleChoices:
			auth.Status = modelplanbiz.StagePassed
			auth.LatencyMs = latency
			models, decodeErr := decodePlanModelCatalog(response.Body)
			response.Body.Close()
			if decodeErr != nil {
				discovery.Status = modelplanbiz.StageFailed
				discovery.FailureReason = FailureCatalogDecode
				discovery.Remedy = RemedyAddModelsManually
				return auth, discovery, nil
			}
			discovery.Status = modelplanbiz.StagePassed
			discovery.LatencyMs = latency
			discovery.Detail = fmt.Sprintf("%d models", len(models))
			return auth, discovery, models
		default:
			lastStatus = response.StatusCode
			response.Body.Close()
			auth.Status = modelplanbiz.StageSkipped
			discovery.Status = modelplanbiz.StageFailed
			discovery.FailureReason = FailureCatalogNotFound
			discovery.Remedy = RemedyAddModelsManually
			discovery.Detail = fmt.Sprintf("status %d", lastStatus)
			return auth, discovery, nil
		}
	}
	// Every candidate endpoint returned 404/405: the provider has no model
	// catalog. The key is verified by the inference stage instead, and manual
	// models keep discovery non-fatal.
	auth.Status = modelplanbiz.StageSkipped
	if len(manualModels) > 0 {
		discovery.Status = modelplanbiz.StageSkipped
		discovery.Detail = "catalog unavailable; manual models configured"
	} else {
		discovery.Status = modelplanbiz.StageFailed
		discovery.FailureReason = FailureCatalogNotFound
		discovery.Remedy = RemedyAddModelsManually
	}
	return auth, discovery, nil
}

func (s *Service) checkInference(ctx context.Context, protocol modelplanbiz.Protocol, baseURL string, apiKey string, model string, now time.Time) modelplanbiz.StageResult {
	result := modelplanbiz.StageResult{Stage: modelplanbiz.StageInference, CheckedAt: now}
	if strings.TrimSpace(model) == "" {
		result.Status = modelplanbiz.StageFailed
		result.FailureReason = FailureNoModel
		result.Remedy = RemedySelectModel
		return result
	}
	completion, err := s.complete(ctx, completionRequest{
		Protocol:  protocol,
		BaseURL:   baseURL,
		APIKey:    apiKey,
		Model:     model,
		Prompt:    "Reply with the single word: ok",
		MaxTokens: 8,
	})
	result.LatencyMs = completion.LatencyMs
	if err != nil {
		var httpErr *completionHTTPError
		switch {
		case errors.As(err, &httpErr) && (httpErr.StatusCode == http.StatusUnauthorized || httpErr.StatusCode == http.StatusForbidden):
			result.Status = modelplanbiz.StageFailed
			result.FailureReason = FailureUnauthorized
			result.Remedy = RemedyCheckAPIKey
		case errors.As(err, &httpErr) && (httpErr.StatusCode == http.StatusNotFound || httpErr.StatusCode == http.StatusBadRequest):
			result.Status = modelplanbiz.StageFailed
			result.FailureReason = FailureModelRejected
			result.Remedy = RemedyCheckModelID
		default:
			result.Status = modelplanbiz.StageFailed
			result.FailureReason = FailureInference
			result.Remedy = RemedyCheckNetwork
			result.Detail = sanitizeTransportError(err)
		}
		return result
	}
	result.Status = modelplanbiz.StagePassed
	result.Detail = "model " + model
	return result
}

func planModelCatalogURLs(protocol modelplanbiz.Protocol, baseURL string) ([]string, error) {
	base, err := normalizePlanBaseURL(protocol, baseURL)
	if err != nil {
		return nil, err
	}
	if endsWithVersionSegment(base.Path) {
		return []string{base.String() + "/models"}, nil
	}
	return []string{base.String() + "/v1/models", base.String() + "/models"}, nil
}

func planCompletionURL(protocol modelplanbiz.Protocol, baseURL string) (string, error) {
	base, err := normalizePlanBaseURL(protocol, baseURL)
	if err != nil {
		return "", err
	}
	suffix := "/chat/completions"
	if protocol == modelplanbiz.ProtocolAnthropic {
		suffix = "/messages"
	}
	if endsWithVersionSegment(base.Path) {
		return base.String() + suffix, nil
	}
	return base.String() + "/v1" + suffix, nil
}

func normalizePlanBaseURL(protocol modelplanbiz.Protocol, baseURL string) (*url.URL, error) {
	trimmed := strings.TrimSpace(baseURL)
	if trimmed == "" {
		if protocol == modelplanbiz.ProtocolAnthropic {
			trimmed = "https://api.anthropic.com/v1"
		} else {
			trimmed = "https://api.openai.com/v1"
		}
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return nil, err
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("base url must be absolute")
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	return parsed, nil
}

func applyPlanAuthHeaders(request *http.Request, protocol modelplanbiz.Protocol, apiKey string) {
	if protocol == modelplanbiz.ProtocolAnthropic {
		request.Header.Set("x-api-key", apiKey)
		request.Header.Set("anthropic-version", "2023-06-01")
		return
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
}

func decodePlanModelCatalog(body io.Reader) ([]modelplanbiz.Model, error) {
	var payload struct {
		Data   []planCatalogModel `json:"data"`
		Models []planCatalogModel `json:"models"`
	}
	if err := json.NewDecoder(io.LimitReader(body, 1<<20)).Decode(&payload); err != nil {
		return nil, err
	}
	items := payload.Data
	if len(items) == 0 {
		items = payload.Models
	}
	models := make([]modelplanbiz.Model, 0, len(items))
	for _, item := range items {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			continue
		}
		name := strings.TrimSpace(item.Name)
		if name == "" {
			name = strings.TrimSpace(item.DisplayName)
		}
		models = append(models, modelplanbiz.Model{ID: id, Name: name})
	}
	return modelplanbiz.NormalizeModels(models), nil
}

type planCatalogModel struct {
	DisplayName string `json:"display_name"`
	ID          string `json:"id"`
	Name        string `json:"name"`
}

func endsWithVersionSegment(path string) bool {
	last := path[strings.LastIndex(path, "/")+1:]
	if len(last) < 2 || last[0] != 'v' {
		return false
	}
	for _, char := range last[1:] {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

// sanitizeTransportError keeps transport failures loggable without leaking
// request bodies or credentials.
func sanitizeTransportError(err error) string {
	if err == nil {
		return ""
	}
	message := err.Error()
	if len(message) > 300 {
		message = message[:300]
	}
	return message
}

// completionRequest is the minimal request used by the detection inference
// stage.
type completionRequest struct {
	Protocol  modelplanbiz.Protocol
	BaseURL   string
	APIKey    string
	Model     string
	Prompt    string
	MaxTokens int
}

type completionResult struct {
	LatencyMs int64
}

type completionHTTPError struct {
	StatusCode int
}

func (e *completionHTTPError) Error() string {
	return fmt.Sprintf("completion endpoint returned status %d", e.StatusCode)
}

func (s *Service) complete(ctx context.Context, request completionRequest) (completionResult, error) {
	endpoint, err := planCompletionURL(request.Protocol, request.BaseURL)
	if err != nil {
		return completionResult{}, err
	}
	maxTokens := request.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 256
	}
	var payload any
	if request.Protocol == modelplanbiz.ProtocolAnthropic {
		body := map[string]any{
			"model":      request.Model,
			"max_tokens": maxTokens,
			"messages": []map[string]any{
				{"role": "user", "content": request.Prompt},
			},
		}
		payload = body
	} else {
		payload = map[string]any{
			"model":      request.Model,
			"max_tokens": maxTokens,
			"messages":   []map[string]any{{"role": "user", "content": request.Prompt}},
			"stream":     false,
		}
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return completionResult{}, err
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return completionResult{}, err
	}
	applyPlanAuthHeaders(httpRequest, request.Protocol, request.APIKey)
	httpRequest.Header.Set("Content-Type", "application/json")

	started := time.Now()
	response, err := s.httpClient().Do(httpRequest)
	latency := time.Since(started).Milliseconds()
	if err != nil {
		return completionResult{LatencyMs: latency}, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return completionResult{LatencyMs: latency}, err
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return completionResult{LatencyMs: latency}, &completionHTTPError{StatusCode: response.StatusCode}
	}
	if !json.Valid(raw) {
		return completionResult{LatencyMs: latency}, errors.New("decode completion response: invalid json")
	}
	return completionResult{LatencyMs: latency}, nil
}
