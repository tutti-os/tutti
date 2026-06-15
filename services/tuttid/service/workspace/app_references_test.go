package workspace

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestDecodeAppRuntimeReferenceAcceptsFileUnionBranch(t *testing.T) {
	t.Parallel()

	dataRoot := t.TempDir()
	referencePath := filepath.Join(dataRoot, "reports", "monthly.md")
	raw, err := json.Marshal(map[string]any{
		"kind":        "file",
		"displayName": "Report",
		"description": "Monthly report",
		"location": map[string]any{
			"type": "app-data-relative",
			"path": "reports/monthly.md",
		},
		"sizeBytes": 42,
		"mtimeMs":   1710000000000,
		"mimeType":  "text/markdown",
		"score":     0.75,
	})
	if err != nil {
		t.Fatalf("marshal reference: %v", err)
	}
	reference, ok := decodeAppRuntimeReference(raw, appReferenceLocationValidator{
		dataRoot:    dataRoot,
		packageRoot: t.TempDir(),
	})
	if !ok {
		t.Fatal("decodeAppRuntimeReference() ok = false, want true")
	}
	fileReference, ok := reference.(workspacebiz.AppFileReference)
	if !ok {
		t.Fatalf("decodeAppRuntimeReference() = %T, want AppFileReference", reference)
	}
	if fileReference.Path != referencePath {
		t.Fatalf("Path = %q, want %q", fileReference.Path, referencePath)
	}
	if fileReference.DisplayName != "Report" {
		t.Fatalf("DisplayName = %q, want Report", fileReference.DisplayName)
	}
}

func TestDecodeAppRuntimeReferenceAcceptsFileLocationTypes(t *testing.T) {
	t.Parallel()

	dataRoot := t.TempDir()
	packageRoot := t.TempDir()
	for _, tt := range []struct {
		name         string
		locationType string
		relativePath string
		root         string
	}{
		{
			name:         "data relative",
			locationType: "app-data-relative",
			relativePath: "reports/monthly.md",
			root:         dataRoot,
		},
		{
			name:         "package relative",
			locationType: "app-package-relative",
			relativePath: "docs/guide.md",
			root:         packageRoot,
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			raw, err := json.Marshal(map[string]any{
				"kind":        "file",
				"displayName": "Report",
				"location": map[string]any{
					"type": tt.locationType,
					"path": tt.relativePath,
				},
			})
			if err != nil {
				t.Fatalf("marshal reference: %v", err)
			}
			reference, ok := decodeAppRuntimeReference(raw, appReferenceLocationValidator{
				dataRoot:    dataRoot,
				packageRoot: packageRoot,
			})
			if !ok {
				t.Fatal("decodeAppRuntimeReference() ok = false, want true")
			}
			fileReference, ok := reference.(workspacebiz.AppFileReference)
			if !ok {
				t.Fatalf("decodeAppRuntimeReference() = %T, want AppFileReference", reference)
			}
			expectedPath := filepath.Join(tt.root, filepath.FromSlash(tt.relativePath))
			if fileReference.Path != expectedPath {
				t.Fatalf("Path = %q, want %q", fileReference.Path, expectedPath)
			}
		})
	}
}

func TestDecodeAppRuntimeReferenceDropsInvalidLocation(t *testing.T) {
	t.Parallel()

	for _, raw := range []string{
		`{"kind":"file","path":""}`,
		`{"kind":"file","path":"relative.txt"}`,
		`{"kind":"file","path":"/etc/passwd"}`,
		`{"kind":"file","path":"https://example.test/file.md"}`,
		"{\"kind\":\"file\",\"path\":\"/tmp/bad\\u0000name.txt\"}",
		`{"kind":"file","type":"app-data-relative","path":"a.txt"}`,
		`{"kind":"file","location":{"type":"workspace-relative","path":"a.txt"}}`,
		`{"kind":"file","location":{"type":"app-data-relative","path":""}}`,
		`{"kind":"file","location":{"type":"app-data-relative","path":"/a.txt"}}`,
		`{"kind":"file","location":{"type":"app-data-relative","path":"../secret.txt"}}`,
		`{"kind":"file","location":{"type":"app-data-relative","path":"safe/../secret.txt"}}`,
		`{"kind":"file","location":{"type":"app-data-relative","path":"C:/secret.txt"}}`,
		"{\"kind\":\"file\",\"location\":{\"type\":\"app-data-relative\",\"path\":\"bad\\u0000name.txt\"}}",
	} {
		t.Run(raw, func(t *testing.T) {
			if _, ok := decodeAppRuntimeReference(json.RawMessage(raw), appReferenceLocationValidator{
				dataRoot:    t.TempDir(),
				packageRoot: t.TempDir(),
			}); ok {
				t.Fatal("decodeAppRuntimeReference() ok = true, want false")
			}
		})
	}
}

func TestDecodeAppRuntimeReferenceListItemDropsInvalidGroups(t *testing.T) {
	t.Parallel()

	for _, raw := range []string{
		`{"type":"group","id":"","displayName":"Reports","referenceCount":1}`,
		`{"type":"group","id":"reports","displayName":"","referenceCount":1}`,
		`{"type":"group","id":"reports","displayName":"Reports"}`,
		`{"type":"group","id":"reports","displayName":"Reports","referenceCount":-1}`,
	} {
		t.Run(raw, func(t *testing.T) {
			if _, ok := decodeAppRuntimeReferenceListItem(json.RawMessage(raw), appReferenceLocationValidator{
				dataRoot:    t.TempDir(),
				packageRoot: t.TempDir(),
			}); ok {
				t.Fatal("decodeAppRuntimeReferenceListItem() ok = true, want false")
			}
		})
	}
}

func TestListReferencesQueriesRunningEnabledAppAndDropsInvalidItems(t *testing.T) {
	t.Parallel()

	packageDir := t.TempDir()
	guidePath := filepath.Join(packageDir, "docs", "guide.md")
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		if request.URL.Path != "/references/list" {
			t.Fatalf("request path = %q, want /references/list", request.URL.Path)
		}
		var body appRuntimeReferenceListRequest
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		if body.ParentGroupID != "reports" || body.FilterText != "guide" || body.Limit != 5 || body.Cursor != "cursor" || len(body.Kinds) != 1 || body.Kinds[0] != "file" {
			t.Fatalf("request body = %#v", body)
		}
		if body.TimeRange == nil || body.TimeRange.FromMs == nil || *body.TimeRange.FromMs != 1000 || body.TimeRange.ToMs == nil || *body.TimeRange.ToMs != 2000 {
			t.Fatalf("request timeRange = %#v", body.TimeRange)
		}
		response.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(response).Encode(map[string]any{
			"items": []map[string]any{
				{"type": "group", "id": "", "displayName": "Invalid", "referenceCount": 1},
				{"type": "group", "id": "monthly", "displayName": "Monthly", "description": "Reports", "referenceCount": 12},
				{"type": "reference", "reference": map[string]any{"kind": "url", "url": "https://example.test"}},
				{"type": "reference", "reference": map[string]any{"kind": "file", "location": map[string]any{
					"type": "app-package-relative",
					"path": "../secret.txt",
				}}},
				{"type": "reference", "reference": map[string]any{"kind": "file", "displayName": "Guide", "location": map[string]any{
					"type": "app-package-relative",
					"path": "docs/guide.md",
				}}},
			},
			"nextCursor": "next-page",
		}); err != nil {
			t.Fatalf("encode response: %v", err)
		}
	}))
	t.Cleanup(server.Close)

	fromMs := int64(1000)
	toMs := int64(2000)
	service := newAppReferenceListServiceForTest(t, appReferenceListServiceTestInput{
		enabled:             true,
		referenceList:       true,
		runtimeLaunchURL:    server.URL,
		runtimeStatus:       workspacebiz.AppRuntimeStatusRunning,
		runtimeHTTPClient:   server.Client(),
		runtimeResolverStub: &appRuntimeResolverStub{called: make(chan struct{})},
		packageDir:          packageDir,
	})

	result, err := service.ListReferences(context.Background(), "ws-1", "docs", workspacebiz.AppReferenceListInput{
		ParentGroupID: "reports",
		FilterText:    "guide",
		Limit:         5,
		Cursor:        "cursor",
		Kinds:         []workspacebiz.AppReferenceKind{workspacebiz.AppReferenceKindFile},
		TimeRange:     &workspacebiz.AppReferenceListTimeRange{FromMs: &fromMs, ToMs: &toMs},
	})
	if err != nil {
		t.Fatalf("ListReferences() error = %v", err)
	}
	if requests != 1 {
		t.Fatalf("runtime requests = %d, want 1", requests)
	}
	if len(result.Items) != 2 {
		t.Fatalf("items = %#v, want two valid items", result.Items)
	}
	group, ok := result.Items[0].(workspacebiz.AppReferenceGroup)
	if !ok {
		t.Fatalf("first item type = %T, want AppReferenceGroup", result.Items[0])
	}
	if group.ID != "monthly" || group.DisplayName != "Monthly" || group.Description != "Reports" || group.ReferenceCount != 12 {
		t.Fatalf("group = %#v", group)
	}
	referenceItem, ok := result.Items[1].(workspacebiz.AppReferenceListReferenceItem)
	if !ok {
		t.Fatalf("second item type = %T, want AppReferenceListReferenceItem", result.Items[1])
	}
	fileReference, ok := referenceItem.Reference.(workspacebiz.AppFileReference)
	if !ok {
		t.Fatalf("reference type = %T, want AppFileReference", referenceItem.Reference)
	}
	if fileReference.Path != guidePath {
		t.Fatalf("reference path = %q, want %q", fileReference.Path, guidePath)
	}
	if result.NextCursor == nil || *result.NextCursor != "next-page" {
		t.Fatalf("nextCursor = %#v, want next-page", result.NextCursor)
	}
	assertRuntimeResolverNotCalled(t, service.Runner.RuntimeResolver.(*appRuntimeResolverStub))
}

func TestListReferencesOmitsOptionalRuntimeFiltersWhenAbsent(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		for _, field := range []string{"parentGroupId", "filterText", "cursor", "kinds", "timeRange"} {
			if _, ok := body[field]; ok {
				t.Fatalf("request body unexpectedly includes %s: %#v", field, body)
			}
		}
		if body["limit"] != float64(appReferenceListDefaultLimit) {
			t.Fatalf("limit = %#v, want default %d", body["limit"], appReferenceListDefaultLimit)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"items":[],"nextCursor":null}`))
	}))
	t.Cleanup(server.Close)

	service := newAppReferenceListServiceForTest(t, appReferenceListServiceTestInput{
		enabled:           true,
		referenceList:     true,
		runtimeLaunchURL:  server.URL,
		runtimeStatus:     workspacebiz.AppRuntimeStatusRunning,
		runtimeHTTPClient: server.Client(),
	})

	if _, err := service.ListReferences(context.Background(), "ws-1", "docs", workspacebiz.AppReferenceListInput{}); err != nil {
		t.Fatalf("ListReferences() error = %v", err)
	}
}

func TestListReferencesDoesNotQueryAppsThatAreNotEligible(t *testing.T) {
	t.Parallel()

	for _, tt := range []struct {
		name          string
		enabled       bool
		referenceList bool
		runtimeStatus workspacebiz.AppRuntimeStatus
		launchURL     string
	}{
		{
			name:          "disabled",
			enabled:       false,
			referenceList: true,
			runtimeStatus: workspacebiz.AppRuntimeStatusRunning,
			launchURL:     "http://127.0.0.1:1",
		},
		{
			name:          "references unsupported",
			enabled:       true,
			referenceList: false,
			runtimeStatus: workspacebiz.AppRuntimeStatusRunning,
			launchURL:     "http://127.0.0.1:1",
		},
		{
			name:          "not running",
			enabled:       true,
			referenceList: true,
			runtimeStatus: workspacebiz.AppRuntimeStatusIdle,
			launchURL:     "http://127.0.0.1:1",
		},
		{
			name:          "missing launch url",
			enabled:       true,
			referenceList: true,
			runtimeStatus: workspacebiz.AppRuntimeStatusRunning,
			launchURL:     "",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			resolver := &appRuntimeResolverStub{called: make(chan struct{})}
			service := newAppReferenceListServiceForTest(t, appReferenceListServiceTestInput{
				enabled:             tt.enabled,
				referenceList:       tt.referenceList,
				runtimeLaunchURL:    tt.launchURL,
				runtimeStatus:       tt.runtimeStatus,
				runtimeResolverStub: resolver,
			})

			result, err := service.ListReferences(context.Background(), "ws-1", "docs", workspacebiz.AppReferenceListInput{})
			if err != nil {
				t.Fatalf("ListReferences() error = %v", err)
			}
			if len(result.Items) != 0 || result.NextCursor != nil {
				t.Fatalf("result = %#v, want empty", result)
			}
			assertRuntimeResolverNotCalled(t, resolver)
		})
	}
}

func TestListReferencesRuntimeFailuresReturnEmptyResults(t *testing.T) {
	t.Parallel()

	for _, tt := range []struct {
		name       string
		statusCode int
		body       string
	}{
		{name: "http error", statusCode: http.StatusInternalServerError, body: `{"items":[]}`},
		{name: "invalid json", statusCode: http.StatusOK, body: `{`},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				response.WriteHeader(tt.statusCode)
				_, _ = response.Write([]byte(tt.body))
			}))
			t.Cleanup(server.Close)
			service := newAppReferenceListServiceForTest(t, appReferenceListServiceTestInput{
				enabled:           true,
				referenceList:     true,
				runtimeLaunchURL:  server.URL,
				runtimeStatus:     workspacebiz.AppRuntimeStatusRunning,
				runtimeHTTPClient: server.Client(),
			})

			result, err := service.ListReferences(context.Background(), "ws-1", "docs", workspacebiz.AppReferenceListInput{})
			if err != nil {
				t.Fatalf("ListReferences() error = %v", err)
			}
			if len(result.Items) != 0 || result.NextCursor != nil {
				t.Fatalf("result = %#v, want empty", result)
			}
		})
	}
}

type appReferenceListServiceTestInput struct {
	enabled             bool
	referenceList       bool
	runtimeLaunchURL    string
	runtimeStatus       workspacebiz.AppRuntimeStatus
	runtimeHTTPClient   *http.Client
	runtimeResolverStub *appRuntimeResolverStub
	packageDir          string
}

func newAppReferenceListServiceForTest(t *testing.T, input appReferenceListServiceTestInput) *AppCenterService {
	t.Helper()

	store := newAppStoreStub()
	packageDir := input.packageDir
	if packageDir == "" {
		packageDir = t.TempDir()
	}
	references := (*workspacebiz.AppManifestReferences)(nil)
	if input.referenceList {
		references = &workspacebiz.AppManifestReferences{ListEndpoint: "/references/list"}
	}
	if err := store.PutAppPackage(context.Background(), workspacebiz.AppPackage{
		AppID:      "docs",
		Version:    "1.0.0",
		PackageDir: packageDir,
		Manifest: workspacebiz.AppManifest{
			SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
			AppID:         "docs",
			Version:       "1.0.0",
			Name:          "Docs",
			Description:   "Docs app",
			Icon:          workspacebiz.AppManifestIcon{Type: "asset", Src: "icon.png"},
			Runtime: workspacebiz.AppManifestRuntime{
				Bootstrap:       "bootstrap.sh",
				HealthcheckPath: "/healthz",
			},
			References: references,
		},
		Source: workspacebiz.AppPackageSourceGenerated,
	}); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	if err := store.PutWorkspaceAppInstallation(context.Background(), workspacebiz.AppInstallation{
		WorkspaceID: "ws-1",
		AppID:       "docs",
		Enabled:     input.enabled,
	}); err != nil {
		t.Fatalf("PutWorkspaceAppInstallation() error = %v", err)
	}
	runner := &AppRunner{
		HTTPClient:         input.runtimeHTTPClient,
		RuntimeResolver:    input.runtimeResolverStub,
		HealthcheckTimeout: 0,
	}
	state := workspacebiz.AppRuntimeState{Status: input.runtimeStatus}
	if input.runtimeLaunchURL != "" {
		state.LaunchURL = &input.runtimeLaunchURL
	}
	runner.setState(appRuntimeKey("ws-1", "docs"), state)
	return &AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         runner,
		StateDir:       t.TempDir(),
	}
}

func assertRuntimeResolverNotCalled(t *testing.T, resolver *appRuntimeResolverStub) {
	t.Helper()
	if resolver == nil {
		return
	}
	select {
	case <-resolver.called:
		t.Fatal("runtime resolver was called")
	default:
	}
}
