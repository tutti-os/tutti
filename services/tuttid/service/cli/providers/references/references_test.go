package references

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

type fakeWorkspaceCatalog struct {
	startup workspacebiz.Summary
}

func (f fakeWorkspaceCatalog) Startup(context.Context) (*workspacebiz.Summary, error) {
	return &f.startup, nil
}

func (fakeWorkspaceCatalog) Get(_ context.Context, workspaceID string) (workspacebiz.Summary, error) {
	return workspacebiz.Summary{ID: workspaceID, Name: "requested"}, nil
}

// fakeAppReferences serves a small hierarchy keyed by parentGroupId so the recursion
// (group → children) and flatten behaviour can be asserted.
type fakeAppReferences struct {
	byParent map[string][]workspacebiz.AppReferenceListItem
	calls    []string
}

func (f *fakeAppReferences) ListReferences(_ context.Context, _ string, _ string, input workspacebiz.AppReferenceListInput) (workspacebiz.AppReferenceListResult, error) {
	f.calls = append(f.calls, input.ParentGroupID)
	return workspacebiz.AppReferenceListResult{Items: f.byParent[input.ParentGroupID]}, nil
}

func fileItem(path, name string) workspacebiz.AppReferenceListItem {
	return workspacebiz.AppReferenceListReferenceItem{Reference: workspacebiz.AppFileReference{Path: path, DisplayName: name}}
}

func groupItem(id, name string) workspacebiz.AppReferenceListItem {
	return workspacebiz.AppReferenceGroup{ID: id, DisplayName: name, ReferenceCount: 1}
}

type fakeIssueOutputs struct {
	detail workspaceissues.IssueDetail
	hits   []workspaceissues.RunOutputSearchHit
	search workspaceissues.RunOutputSearchParams
}

func (f *fakeIssueOutputs) GetIssueDetail(_ context.Context, _ string, _ string) (workspaceissues.IssueDetail, error) {
	return f.detail, nil
}

func (f *fakeIssueOutputs) SearchIssueOutputs(_ context.Context, params workspaceissues.RunOutputSearchParams) ([]workspaceissues.RunOutputSearchHit, error) {
	f.search = params
	return f.hits, nil
}

func itemPaths(t *testing.T, value map[string]any) []string {
	t.Helper()
	items, ok := value["items"].([]any)
	if !ok {
		t.Fatalf("items missing or wrong type: %#v", value)
	}
	paths := make([]string, 0, len(items))
	for _, raw := range items {
		paths = append(paths, raw.(map[string]any)["path"].(string))
	}
	return paths
}

func TestReferenceListAppRecursesAndFlattens(t *testing.T) {
	apps := &fakeAppReferences{byParent: map[string][]workspacebiz.AppReferenceListItem{
		"":   {groupItem("g1", "Project 1"), fileItem("/root.txt", "root.txt")},
		"g1": {groupItem("g2", "Nested"), fileItem("/g1.txt", "g1.txt")},
		"g2": {fileItem("/g2.txt", "g2.txt")},
	}}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "ws-1"}}, apps, &fakeIssueOutputs{}).newReferenceListCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input:      map[string]any{"source": "app", "id": "app-1"},
		OutputMode: cliservice.OutputModeJSON,
		Context:    cliservice.InvokeContext{Source: "cli"},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	paths := itemPaths(t, output.Value)
	if len(paths) != 3 {
		t.Fatalf("paths = %#v, want 3 files flattened across nested groups", paths)
	}
	got := map[string]bool{}
	for _, p := range paths {
		got[p] = true
	}
	for _, want := range []string{"/root.txt", "/g1.txt", "/g2.txt"} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, paths)
		}
	}
}

func TestReferenceListCommandAdvertisesAndValidatesSource(t *testing.T) {
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "ws-1"}}, &fakeAppReferences{}, &fakeIssueOutputs{}).newReferenceListCommand()
	properties := command.Capability.InputSchema["properties"].(map[string]any)
	source := properties["source"].(map[string]any)
	if !reflect.DeepEqual(source["enum"], []string{"app", "task"}) {
		t.Fatalf("source schema = %#v", source)
	}

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input:      map[string]any{"source": "bogus", "id": "x"},
		OutputMode: cliservice.OutputModeJSON,
		Context:    cliservice.InvokeContext{Source: "cli"},
	})
	if !errors.Is(err, cliservice.ErrInvalidInput) || !strings.Contains(err.Error(), `invalid input "source": must be one of app, task`) {
		t.Fatalf("err = %v", err)
	}
}

func TestReferenceListTaskIssueUsesLatestOutputs(t *testing.T) {
	issues := &fakeIssueOutputs{detail: workspaceissues.IssueDetail{LatestOutputs: []workspaceissues.RunOutput{
		{Path: "/out-a.png", DisplayName: "out-a.png", MediaType: "image/png", SizeBytes: 10},
		{Path: "/out-b.txt", DisplayName: "out-b.txt"},
	}}}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "ws-1"}}, &fakeAppReferences{}, issues).newReferenceListCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input:      map[string]any{"source": "task", "id": "topic-1", "group-id": "issue-1"},
		OutputMode: cliservice.OutputModeJSON,
		Context:    cliservice.InvokeContext{Source: "cli"},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	paths := itemPaths(t, output.Value)
	if len(paths) != 2 || paths[0] != "/out-a.png" || paths[1] != "/out-b.txt" {
		t.Fatalf("paths = %#v", paths)
	}
}

func TestReferenceListTaskTopicSearchesOutputs(t *testing.T) {
	issues := &fakeIssueOutputs{hits: []workspaceissues.RunOutputSearchHit{
		{Output: workspaceissues.RunOutput{Path: "/hit.txt", DisplayName: "hit.txt"}, IssueTitle: "Issue"},
	}}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "ws-1"}}, &fakeAppReferences{}, issues).newReferenceListCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input:      map[string]any{"source": "task", "id": "topic-1"},
		OutputMode: cliservice.OutputModeJSON,
		Context:    cliservice.InvokeContext{Source: "cli"},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if issues.search.TopicID != "topic-1" {
		t.Fatalf("search scoped to topic = %q, want topic-1", issues.search.TopicID)
	}
	if paths := itemPaths(t, output.Value); len(paths) != 1 || paths[0] != "/hit.txt" {
		t.Fatalf("paths = %#v", paths)
	}
}

func TestReferenceListRejectsUnknownSource(t *testing.T) {
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "ws-1"}}, &fakeAppReferences{}, &fakeIssueOutputs{}).newReferenceListCommand()

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input:      map[string]any{"source": "bogus", "id": "x"},
		OutputMode: cliservice.OutputModeJSON,
		Context:    cliservice.InvokeContext{Source: "cli"},
	})
	if !errors.Is(err, cliservice.ErrInvalidInput) {
		t.Fatalf("err = %v, want ErrInvalidInput", err)
	}
}
