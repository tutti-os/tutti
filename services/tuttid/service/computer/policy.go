package computer

import (
	"errors"
	"fmt"
	"strings"
)

// ErrNativeToolNotAllowed marks a native tool that is absent from the live
// catalog or not authorized by Tutti's computer-use capability policy.
var ErrNativeToolNotAllowed = errors.New("native computer tool is not allowed")

// ErrNativeToolCatalogUnsupported marks a missing or breaking version of the
// cua-driver discovery contract. Authorization must fail closed in this case.
var ErrNativeToolCatalogUnsupported = errors.New("native computer tool catalog version is unsupported")

var allowedNativeCapabilities = map[string]struct{}{
	"accessibility.element_tokens":            {},
	"accessibility.tree":                      {},
	"accessibility.tree.bounded":              {},
	"accessibility.tree.structured":           {},
	"accessibility.window_state":              {},
	"agent_cursor.move":                       {},
	"agent_cursor.set_enabled":                {},
	"agent_cursor.set_motion":                 {},
	"agent_cursor.set_style":                  {},
	"agent_cursor.state":                      {},
	"app.launch":                              {},
	"app.list":                                {},
	"input.keyboard.hotkey":                   {},
	"input.keyboard.press":                    {},
	"input.keyboard.type":                     {},
	"input.keyboard.type.terminal_safe":       {},
	"input.pointer.button":                    {},
	"input.pointer.click":                     {},
	"input.pointer.click.double":              {},
	"input.pointer.click.left":                {},
	"input.pointer.click.right":               {},
	"input.pointer.drag":                      {},
	"input.pointer.scroll":                    {},
	"screen.capture":                          {},
	"screen.capture.region":                   {},
	"screen.capture.window":                   {},
	"screen.cursor.position":                  {},
	"screen.dimensions":                       {},
	"system.config.read":                      {},
	"system.config.write":                     {},
	"system.permissions.tcc":                  {},
	"system.permissions.tcc.accessibility":    {},
	"system.permissions.tcc.screen_recording": {},
	"window.activate":                         {},
	"window.list":                             {},
}

func annotateNativeToolCatalog(catalog ToolCatalog) (ToolCatalog, error) {
	if err := validateNativeToolCatalog(catalog); err != nil {
		return ToolCatalog{}, err
	}
	annotated := catalog
	annotated.Tools = make([]ToolDefinition, 0, len(catalog.Tools))
	for _, tool := range catalog.Tools {
		allowed, denialReason := authorizeNativeTool(tool)
		tool.Allowed = allowed
		tool.DenialReason = denialReason
		annotated.Tools = append(annotated.Tools, tool)
	}
	return annotated, nil
}

func requireAllowedNativeTool(catalog ToolCatalog, name string) (ToolDefinition, error) {
	if err := validateNativeToolCatalog(catalog); err != nil {
		return ToolDefinition{}, err
	}
	name = strings.TrimSpace(name)
	for _, tool := range catalog.Tools {
		if tool.Name != name {
			continue
		}
		allowed, denialReason := authorizeNativeTool(tool)
		if !allowed {
			return ToolDefinition{}, fmt.Errorf("%w: %q: %s", ErrNativeToolNotAllowed, name, denialReason)
		}
		tool.Allowed = true
		tool.DenialReason = ""
		return tool, nil
	}
	return ToolDefinition{}, fmt.Errorf("%w: %q was not reported by cua-driver", ErrNativeToolNotAllowed, name)
}

func validateNativeToolCatalog(catalog ToolCatalog) error {
	if catalog.SchemaVersion != "1" || catalog.CapabilityVersion != "1" {
		return fmt.Errorf(
			"%w: schema_version=%q capability_version=%q",
			ErrNativeToolCatalogUnsupported,
			catalog.SchemaVersion,
			catalog.CapabilityVersion,
		)
	}
	return nil
}

func authorizeNativeTool(tool ToolDefinition) (bool, string) {
	if len(tool.Capabilities) == 0 {
		return false, "tool has no capability metadata"
	}
	var denied []string
	for _, capability := range tool.Capabilities {
		if _, ok := allowedNativeCapabilities[capability]; !ok {
			denied = append(denied, capability)
		}
	}
	if len(denied) > 0 {
		return false, fmt.Sprintf("tool has denied or unknown capabilities: %s", strings.Join(denied, ", "))
	}
	return true, ""
}
