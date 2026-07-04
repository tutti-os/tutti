package workspace

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	pathpkg "path"
	"path/filepath"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agentactivity/daemon/httpx"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

const (
	appReferenceListDefaultLimit = 20
	appReferenceListMaxLimit     = 200
	appReferenceListMaxBytes     = 1024 * 1024
	appReferenceListTimeout      = 1500 * time.Millisecond
	appReferenceTextMaxRunes     = 200
	appReferenceGroupIDMaxRunes  = 2048
	appReferenceCursorMaxRunes   = 2048
	appReferenceDisplayNameRunes = 160
	appReferenceDescriptionRunes = 500
	appReferenceMimeTypeMaxRunes = 128
)

func (s *AppCenterService) ListReferences(ctx context.Context, workspaceID string, appID string, input workspacebiz.AppReferenceListInput) (workspacebiz.AppReferenceListResult, error) {
	if _, err := s.workspaceSummary(ctx, workspaceID); err != nil {
		return workspacebiz.AppReferenceListResult{}, err
	}

	appPackage, installation, err := s.installedPackage(ctx, workspaceID, appID)
	if err != nil {
		return workspacebiz.AppReferenceListResult{}, err
	}
	if !installation.Enabled || !appPackage.ReferenceListSupported() {
		return workspacebiz.AppReferenceListResult{}, nil
	}

	runtimeState := s.runner().State(workspaceID, appPackage.AppID)
	if runtimeState.Status != workspacebiz.AppRuntimeStatusRunning || runtimeState.LaunchURL == nil || strings.TrimSpace(*runtimeState.LaunchURL) == "" {
		return workspacebiz.AppReferenceListResult{}, nil
	}

	endpointURL, err := appReferenceListURL(*runtimeState.LaunchURL, appPackage.Manifest.References.ListEndpoint)
	if err != nil {
		slog.Warn("workspace app reference list endpoint invalid", "workspaceId", workspaceID, "appId", appPackage.AppID, "error", err)
		return workspacebiz.AppReferenceListResult{}, nil
	}

	result, err := s.listAppRuntimeReferences(ctx, endpointURL, appPackage, workspaceID, input)
	if err != nil {
		slog.Warn("workspace app reference list failed", "workspaceId", workspaceID, "appId", appPackage.AppID, "error", err)
		return workspacebiz.AppReferenceListResult{}, nil
	}
	return result, nil
}

func (s *AppCenterService) SearchReferences(ctx context.Context, workspaceID string, appID string, input workspacebiz.AppReferenceSearchInput) (workspacebiz.AppReferenceListResult, error) {
	if _, err := s.workspaceSummary(ctx, workspaceID); err != nil {
		return workspacebiz.AppReferenceListResult{}, err
	}

	appPackage, installation, err := s.installedPackage(ctx, workspaceID, appID)
	if err != nil {
		return workspacebiz.AppReferenceListResult{}, err
	}
	if !installation.Enabled || !appPackage.ReferenceSearchSupported() {
		return workspacebiz.AppReferenceListResult{}, nil
	}

	runtimeState := s.runner().State(workspaceID, appPackage.AppID)
	if runtimeState.Status != workspacebiz.AppRuntimeStatusRunning || runtimeState.LaunchURL == nil || strings.TrimSpace(*runtimeState.LaunchURL) == "" {
		return workspacebiz.AppReferenceListResult{}, nil
	}

	endpointURL, err := appReferenceListURL(*runtimeState.LaunchURL, appPackage.Manifest.References.SearchEndpoint)
	if err != nil {
		slog.Warn("workspace app reference search endpoint invalid", "workspaceId", workspaceID, "appId", appPackage.AppID, "error", err)
		return workspacebiz.AppReferenceListResult{}, nil
	}

	result, err := s.searchAppRuntimeReferences(ctx, endpointURL, appPackage, workspaceID, input)
	if err != nil {
		slog.Warn("workspace app reference search failed", "workspaceId", workspaceID, "appId", appPackage.AppID, "error", err)
		return workspacebiz.AppReferenceListResult{}, nil
	}
	return result, nil
}

func (s *AppCenterService) listAppRuntimeReferences(ctx context.Context, endpointURL string, appPackage workspacebiz.AppPackage, workspaceID string, input workspacebiz.AppReferenceListInput) (workspacebiz.AppReferenceListResult, error) {
	payload := appRuntimeReferenceListRequest{
		FilterText: trimRunes(strings.TrimSpace(input.FilterText), appReferenceTextMaxRunes),
		Limit:      normalizeAppReferenceListLimit(input.Limit),
	}
	if parentGroupID := trimRunes(strings.TrimSpace(input.ParentGroupID), appReferenceGroupIDMaxRunes); parentGroupID != "" {
		payload.ParentGroupID = parentGroupID
	}
	if cursor := trimRunes(strings.TrimSpace(input.Cursor), appReferenceCursorMaxRunes); cursor != "" {
		payload.Cursor = cursor
	}
	if input.TimeRange != nil {
		payload.TimeRange = &appRuntimeReferenceListTimeRange{
			FromMs: input.TimeRange.FromMs,
			ToMs:   input.TimeRange.ToMs,
		}
	}
	if len(input.Kinds) > 0 {
		if !appReferenceKindsIncludeFile(input.Kinds) {
			return workspacebiz.AppReferenceListResult{}, nil
		}
		payload.Kinds = []string{string(workspacebiz.AppReferenceKindFile)}
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return workspacebiz.AppReferenceListResult{}, err
	}
	return s.requestAppRuntimeReferencePage(ctx, endpointURL, body, appPackage, workspaceID, payload.Limit, false)
}

func (s *AppCenterService) searchAppRuntimeReferences(ctx context.Context, endpointURL string, appPackage workspacebiz.AppPackage, workspaceID string, input workspacebiz.AppReferenceSearchInput) (workspacebiz.AppReferenceListResult, error) {
	query := trimRunes(strings.TrimSpace(input.Query), appReferenceTextMaxRunes)
	// 筛选与搜索是同一能力:query 可空、filters 非空时即按类型查,透传给 app 的 searchEndpoint。
	if query == "" && len(input.Filters) == 0 {
		return workspacebiz.AppReferenceListResult{}, nil
	}
	payload := appRuntimeReferenceSearchRequest{
		Query:   query,
		Limit:   normalizeAppReferenceListLimit(input.Limit),
		Filters: input.Filters,
	}
	if cursor := trimRunes(strings.TrimSpace(input.Cursor), appReferenceCursorMaxRunes); cursor != "" {
		payload.Cursor = cursor
	}
	if input.TimeRange != nil {
		payload.TimeRange = &appRuntimeReferenceListTimeRange{
			FromMs: input.TimeRange.FromMs,
			ToMs:   input.TimeRange.ToMs,
		}
	}
	if len(input.Kinds) > 0 {
		if !appReferenceKindsIncludeFile(input.Kinds) {
			return workspacebiz.AppReferenceListResult{}, nil
		}
		payload.Kinds = []string{string(workspacebiz.AppReferenceKindFile)}
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return workspacebiz.AppReferenceListResult{}, err
	}
	// Search results are a flat, relevance-ordered file list; drop any group items defensively.
	return s.requestAppRuntimeReferencePage(ctx, endpointURL, body, appPackage, workspaceID, payload.Limit, true)
}

func (s *AppCenterService) requestAppRuntimeReferencePage(ctx context.Context, endpointURL string, body []byte, appPackage workspacebiz.AppPackage, workspaceID string, limit int, referenceOnly bool) (workspacebiz.AppReferenceListResult, error) {
	requestCtx, cancel := context.WithTimeout(ctx, appReferenceListTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, endpointURL, bytes.NewReader(body))
	if err != nil {
		return workspacebiz.AppReferenceListResult{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")

	client := appReferenceListHTTPClient(s.runner().HTTPClient)
	response, err := client.Do(request)
	if err != nil {
		return workspacebiz.AppReferenceListResult{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return workspacebiz.AppReferenceListResult{}, fmt.Errorf("app reference request returned status %d", response.StatusCode)
	}

	decoder := json.NewDecoder(io.LimitReader(response.Body, appReferenceListMaxBytes))
	var raw appRuntimeReferenceListResponse
	if err := decoder.Decode(&raw); err != nil {
		return workspacebiz.AppReferenceListResult{}, err
	}

	validator := appReferenceLocationValidator{
		dataRoot:    filepath.Join(s.workspaceAppStateRoot(workspaceID, appPackage.AppID), "data"),
		packageRoot: appPackage.PackageDir,
	}
	items := make([]workspacebiz.AppReferenceListItem, 0, len(raw.Items))
	for index, rawItem := range raw.Items {
		item, ok := decodeAppRuntimeReferenceListItem(rawItem, validator)
		if !ok {
			slog.Warn("workspace app reference item dropped", "workspaceId", workspaceID, "appId", appPackage.AppID, "index", index)
			continue
		}
		if referenceOnly && item.AppReferenceListItemType() != workspacebiz.AppReferenceListItemTypeReference {
			continue
		}
		items = append(items, item)
		if len(items) >= limit {
			break
		}
	}

	return workspacebiz.AppReferenceListResult{
		Items:      items,
		NextCursor: normalizeOptionalCursor(raw.NextCursor),
	}, nil
}

type appRuntimeReferenceListRequest struct {
	ParentGroupID string                            `json:"parentGroupId,omitempty"`
	FilterText    string                            `json:"filterText,omitempty"`
	Limit         int                               `json:"limit"`
	Cursor        string                            `json:"cursor,omitempty"`
	Kinds         []string                          `json:"kinds,omitempty"`
	TimeRange     *appRuntimeReferenceListTimeRange `json:"timeRange,omitempty"`
}

type appRuntimeReferenceSearchRequest struct {
	Query string `json:"query"`
	Limit int    `json:"limit"`
	// Filters:已选「文件类型筛选分类」id(全局统一口径),由 app 自行按 id 过滤、未知 id 忽略。
	Filters   []string                          `json:"filters,omitempty"`
	Cursor    string                            `json:"cursor,omitempty"`
	Kinds     []string                          `json:"kinds,omitempty"`
	TimeRange *appRuntimeReferenceListTimeRange `json:"timeRange,omitempty"`
}

type appRuntimeReferenceListTimeRange struct {
	FromMs *int64 `json:"fromMs,omitempty"`
	ToMs   *int64 `json:"toMs,omitempty"`
}

type appRuntimeReferenceListResponse struct {
	Items      []json.RawMessage `json:"items"`
	NextCursor *string           `json:"nextCursor,omitempty"`
}

type appRuntimeReferenceListItemTypeHeader struct {
	Type string `json:"type"`
}

type appRuntimeReferenceGroupItem struct {
	Type           string  `json:"type"`
	ID             string  `json:"id"`
	DisplayName    string  `json:"displayName"`
	Description    *string `json:"description,omitempty"`
	ReferenceCount *int    `json:"referenceCount"`
}

type appRuntimeReferenceListReferenceItem struct {
	Type      string          `json:"type"`
	Reference json.RawMessage `json:"reference"`
}

type appRuntimeReferenceKindHeader struct {
	Kind string `json:"kind"`
}

type appRuntimeFileReference struct {
	Kind             string                       `json:"kind"`
	DisplayName      *string                      `json:"displayName,omitempty"`
	Description      *string                      `json:"description,omitempty"`
	Location         *appRuntimeReferenceLocation `json:"location,omitempty"`
	SizeBytes        *int64                       `json:"sizeBytes,omitempty"`
	MtimeMs          *int64                       `json:"mtimeMs,omitempty"`
	MimeType         *string                      `json:"mimeType,omitempty"`
	Score            *float64                     `json:"score,omitempty"`
	ParentGroupLabel *string                      `json:"parentGroupLabel,omitempty"`
}

type appRuntimeReferenceLocation struct {
	Type string `json:"type"`
	Path string `json:"path"`
}

type appReferenceLocationValidator struct {
	dataRoot    string
	packageRoot string
}

func decodeAppRuntimeReferenceListItem(raw json.RawMessage, validator appReferenceLocationValidator) (workspacebiz.AppReferenceListItem, bool) {
	var header appRuntimeReferenceListItemTypeHeader
	if err := json.Unmarshal(raw, &header); err != nil {
		return nil, false
	}
	switch strings.TrimSpace(header.Type) {
	case string(workspacebiz.AppReferenceListItemTypeGroup):
		return decodeAppRuntimeReferenceGroupItem(raw)
	case string(workspacebiz.AppReferenceListItemTypeReference):
		return decodeAppRuntimeReferenceListReferenceItem(raw, validator)
	default:
		return nil, false
	}
}

func decodeAppRuntimeReferenceGroupItem(raw json.RawMessage) (workspacebiz.AppReferenceListItem, bool) {
	var decoded appRuntimeReferenceGroupItem
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, false
	}
	id, ok := normalizeRequiredBoundedString(decoded.ID, appReferenceGroupIDMaxRunes)
	if !ok {
		return nil, false
	}
	displayName, ok := normalizeRequiredBoundedString(decoded.DisplayName, appReferenceDisplayNameRunes)
	if !ok {
		return nil, false
	}
	description, ok := normalizeOptionalBoundedString(decoded.Description, appReferenceDescriptionRunes)
	if !ok {
		return nil, false
	}
	if decoded.ReferenceCount == nil || *decoded.ReferenceCount < 0 {
		return nil, false
	}
	return workspacebiz.AppReferenceGroup{
		ID:             id,
		DisplayName:    displayName,
		Description:    description,
		ReferenceCount: *decoded.ReferenceCount,
	}, true
}

func decodeAppRuntimeReferenceListReferenceItem(raw json.RawMessage, validator appReferenceLocationValidator) (workspacebiz.AppReferenceListItem, bool) {
	var decoded appRuntimeReferenceListReferenceItem
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, false
	}
	if len(decoded.Reference) == 0 {
		return nil, false
	}
	reference, ok := decodeAppRuntimeReference(decoded.Reference, validator)
	if !ok {
		return nil, false
	}
	return workspacebiz.AppReferenceListReferenceItem{Reference: reference}, true
}

func decodeAppRuntimeReference(raw json.RawMessage, validator appReferenceLocationValidator) (workspacebiz.AppReference, bool) {
	var header appRuntimeReferenceKindHeader
	if err := json.Unmarshal(raw, &header); err != nil {
		return nil, false
	}
	switch strings.TrimSpace(header.Kind) {
	case string(workspacebiz.AppReferenceKindFile):
		return decodeAppRuntimeFileReference(raw, validator)
	default:
		return nil, false
	}
}

func decodeAppRuntimeFileReference(raw json.RawMessage, validator appReferenceLocationValidator) (workspacebiz.AppReference, bool) {
	var decoded appRuntimeFileReference
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, false
	}
	referencePath, ok := normalizeAppRuntimeFileReferencePath(decoded, validator)
	if !ok {
		return nil, false
	}
	sizeBytes, ok := normalizeOptionalNonNegativeInt64(decoded.SizeBytes)
	if !ok {
		return nil, false
	}
	mtimeMs, ok := normalizeOptionalNonNegativeInt64(decoded.MtimeMs)
	if !ok {
		return nil, false
	}
	score, ok := normalizeOptionalScore(decoded.Score)
	if !ok {
		return nil, false
	}
	mimeType, ok := normalizeOptionalBoundedString(decoded.MimeType, appReferenceMimeTypeMaxRunes)
	if !ok {
		return nil, false
	}
	displayName, ok := normalizeOptionalBoundedString(decoded.DisplayName, appReferenceDisplayNameRunes)
	if !ok {
		return nil, false
	}
	if displayName == "" {
		displayName = filepath.Base(referencePath)
	}
	description, ok := normalizeOptionalBoundedString(decoded.Description, appReferenceDescriptionRunes)
	if !ok {
		return nil, false
	}
	parentGroupLabel, ok := normalizeOptionalBoundedString(decoded.ParentGroupLabel, appReferenceDisplayNameRunes)
	if !ok {
		return nil, false
	}
	return workspacebiz.AppFileReference{
		DisplayName:      displayName,
		Description:      description,
		Path:             referencePath,
		SizeBytes:        sizeBytes,
		MtimeMs:          mtimeMs,
		MimeType:         mimeType,
		Score:            score,
		ParentGroupLabel: parentGroupLabel,
	}, true
}

func normalizeAppRuntimeFileReferencePath(reference appRuntimeFileReference, validator appReferenceLocationValidator) (string, bool) {
	if reference.Location == nil {
		return "", false
	}
	return resolveAppRuntimeFileReferenceLocation(*reference.Location, validator)
}

func resolveAppRuntimeFileReferenceLocation(location appRuntimeReferenceLocation, validator appReferenceLocationValidator) (string, bool) {
	relativePath, ok := normalizeAppReferenceRelativePath(location.Path)
	if !ok {
		return "", false
	}
	var root string
	switch strings.TrimSpace(location.Type) {
	case "app-data-relative":
		root = validator.dataRoot
	case "app-package-relative":
		root = validator.packageRoot
	default:
		return "", false
	}
	if strings.TrimSpace(root) == "" {
		return "", false
	}
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return "", false
	}
	absolutePath, err := filepath.Abs(filepath.Join(absoluteRoot, filepath.FromSlash(relativePath)))
	if err != nil {
		return "", false
	}
	if !isPathWithinRoot(absoluteRoot, absolutePath) {
		return "", false
	}
	return absolutePath, true
}

func normalizeAppReferenceRelativePath(value string) (string, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || strings.Contains(trimmed, "\x00") {
		return "", false
	}
	normalized := strings.ReplaceAll(trimmed, "\\", "/")
	if strings.HasPrefix(normalized, "/") || strings.HasPrefix(normalized, "//") || hasAppReferenceDrivePrefix(normalized) {
		return "", false
	}
	for _, segment := range strings.Split(normalized, "/") {
		if segment == ".." {
			return "", false
		}
	}
	cleaned := pathpkg.Clean(normalized)
	if cleaned == "." || strings.HasPrefix(cleaned, "../") || cleaned == ".." || strings.HasPrefix(cleaned, "/") {
		return "", false
	}
	return cleaned, true
}

func hasAppReferenceDrivePrefix(value string) bool {
	return len(value) >= 2 && value[1] == ':' && ((value[0] >= 'a' && value[0] <= 'z') || (value[0] >= 'A' && value[0] <= 'Z'))
}

func appReferenceListURL(launchURL string, listEndpoint string) (string, error) {
	base, err := url.Parse(strings.TrimSpace(launchURL))
	if err != nil {
		return "", err
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", fmt.Errorf("unsupported app launch url scheme %q", base.Scheme)
	}
	endpoint := strings.TrimSpace(listEndpoint)
	if endpoint == "" || !strings.HasPrefix(endpoint, "/") || strings.HasPrefix(endpoint, "//") {
		return "", fmt.Errorf("invalid reference list endpoint %q", listEndpoint)
	}
	base.Path = endpoint
	base.RawQuery = ""
	base.Fragment = ""
	return base.String(), nil
}

func appReferenceListHTTPClient(client *http.Client) *http.Client {
	if client != nil {
		return client
	}
	return httpx.Default()
}

func normalizeAppReferenceListLimit(limit int) int {
	if limit <= 0 {
		return appReferenceListDefaultLimit
	}
	if limit > appReferenceListMaxLimit {
		return appReferenceListMaxLimit
	}
	return limit
}

func appReferenceKindsIncludeFile(kinds []workspacebiz.AppReferenceKind) bool {
	for _, kind := range kinds {
		if kind == workspacebiz.AppReferenceKindFile {
			return true
		}
	}
	return false
}

func normalizeOptionalCursor(value *string) *string {
	if value == nil {
		return nil
	}
	normalized := trimRunes(strings.TrimSpace(*value), appReferenceCursorMaxRunes)
	if normalized == "" {
		return nil
	}
	return &normalized
}

func normalizeRequiredBoundedString(value string, maxRunes int) (string, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || runeCount(trimmed) > maxRunes {
		return "", false
	}
	return trimmed, true
}

func normalizeOptionalBoundedString(value *string, maxRunes int) (string, bool) {
	if value == nil {
		return "", true
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return "", true
	}
	if runeCount(trimmed) > maxRunes {
		return "", false
	}
	return trimmed, true
}

func normalizeOptionalNonNegativeInt64(value *int64) (*int64, bool) {
	if value == nil {
		return nil, true
	}
	if *value < 0 {
		return nil, false
	}
	normalized := *value
	return &normalized, true
}

func normalizeOptionalScore(value *float64) (*float64, bool) {
	if value == nil {
		return nil, true
	}
	if *value < 0 || *value > 1 {
		return nil, false
	}
	normalized := *value
	return &normalized, true
}

func trimRunes(value string, maxRunes int) string {
	if maxRunes <= 0 || runeCount(value) <= maxRunes {
		return value
	}
	runes := []rune(value)
	return string(runes[:maxRunes])
}

func runeCount(value string) int {
	return len([]rune(value))
}

func isPathWithinRoot(rootPath string, candidatePath string) bool {
	root := filepath.Clean(rootPath)
	candidate := filepath.Clean(candidatePath)
	relative, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	return relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative))
}
