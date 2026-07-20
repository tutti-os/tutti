package computer

import (
	"errors"
	"testing"
)

func TestAnnotateNativeToolCatalogPreservesEveryToolAndAuthorization(t *testing.T) {
	catalog := ToolCatalog{
		SchemaVersion:     "1",
		CapabilityVersion: "1",
		Tools: []ToolDefinition{
			{Name: "click", Capabilities: []string{"input.pointer.click", "input.pointer.click.left"}},
			{Name: "mixed_future", Capabilities: []string{"input.pointer.click", "future.privileged"}},
			{Name: "kill_app", Capabilities: []string{"app.kill"}},
			{Name: "missing_metadata"},
		},
	}

	annotated, err := annotateNativeToolCatalog(catalog)
	if err != nil {
		t.Fatalf("annotateNativeToolCatalog: %v", err)
	}
	if len(annotated.Tools) != len(catalog.Tools) {
		t.Fatalf("annotated tools = %#v", annotated.Tools)
	}
	if !annotated.Tools[0].Allowed || annotated.Tools[0].DenialReason != "" {
		t.Fatalf("allowed tool = %#v", annotated.Tools[0])
	}
	for _, tool := range annotated.Tools[1:] {
		if tool.Allowed || tool.DenialReason == "" {
			t.Fatalf("denied tool lacks authorization metadata: %#v", tool)
		}
	}
	if annotated.SchemaVersion != "1" || annotated.CapabilityVersion != "1" {
		t.Fatalf("annotated catalog lost versions: %#v", annotated)
	}
}

func TestNativeToolPolicyRejectsUnknownOrMissingCatalogVersions(t *testing.T) {
	for _, catalog := range []ToolCatalog{
		{SchemaVersion: "2", CapabilityVersion: "1"},
		{SchemaVersion: "1", CapabilityVersion: "2"},
		{},
	} {
		if _, err := annotateNativeToolCatalog(catalog); !errors.Is(err, ErrNativeToolCatalogUnsupported) {
			t.Fatalf("annotate err = %v, want ErrNativeToolCatalogUnsupported for %#v", err, catalog)
		}
		if _, err := requireAllowedNativeTool(catalog, "click"); !errors.Is(err, ErrNativeToolCatalogUnsupported) {
			t.Fatalf("require err = %v, want ErrNativeToolCatalogUnsupported for %#v", err, catalog)
		}
	}
}

func TestRequireAllowedNativeToolRejectsUnknownAndDeniedCapabilities(t *testing.T) {
	for _, tool := range []ToolDefinition{
		{Name: "mixed_future", Capabilities: []string{"screen.capture", "future.privileged"}},
		{Name: "missing_metadata"},
	} {
		t.Run(tool.Name, func(t *testing.T) {
			_, err := requireAllowedNativeTool(ToolCatalog{
				SchemaVersion:     "1",
				CapabilityVersion: "1",
				Tools:             []ToolDefinition{tool},
			}, tool.Name)
			if !errors.Is(err, ErrNativeToolNotAllowed) {
				t.Fatalf("err = %v, want ErrNativeToolNotAllowed", err)
			}
		})
	}
}

func TestNativeToolPolicyAllowsGlobalConfigWrites(t *testing.T) {
	tool := ToolDefinition{
		Name:         "set_config",
		Capabilities: []string{"system.config.write"},
	}
	catalog, err := annotateNativeToolCatalog(ToolCatalog{
		SchemaVersion:     "1",
		CapabilityVersion: "1",
		Tools:             []ToolDefinition{tool},
	})
	if err != nil {
		t.Fatalf("annotateNativeToolCatalog(set_config): %v", err)
	}
	if len(catalog.Tools) != 1 || !catalog.Tools[0].Allowed || catalog.Tools[0].DenialReason != "" {
		t.Fatalf("tool = %#v", catalog.Tools)
	}
	got, err := requireAllowedNativeTool(ToolCatalog{
		SchemaVersion:     "1",
		CapabilityVersion: "1",
		Tools:             []ToolDefinition{tool},
	}, tool.Name)
	if err != nil || got.Name != tool.Name || !got.Allowed {
		t.Fatalf("tool = %#v, err = %v", got, err)
	}
}

func TestNativeToolPolicyAllowsConfigReads(t *testing.T) {
	tool := ToolDefinition{Name: "get_config", Capabilities: []string{"system.config.read"}}
	got, err := requireAllowedNativeTool(ToolCatalog{
		SchemaVersion:     "1",
		CapabilityVersion: "1",
		Tools:             []ToolDefinition{tool},
	}, tool.Name)
	if err != nil || got.Name != tool.Name {
		t.Fatalf("tool = %#v, err = %v", got, err)
	}
}
