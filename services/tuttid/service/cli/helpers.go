package cli

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

type WorkspaceCatalog interface {
	Startup(context.Context) (*workspacebiz.Summary, error)
	Get(context.Context, string) (workspacebiz.Summary, error)
}

func ResolveWorkspaceID(ctx context.Context, workspaces WorkspaceCatalog, requested string) (string, error) {
	requested = strings.TrimSpace(requested)
	if requested != "" {
		workspace, err := workspaces.Get(ctx, requested)
		if err != nil {
			return "", err
		}
		return workspace.ID, nil
	}
	workspace, err := workspaces.Startup(ctx)
	if err != nil {
		return "", err
	}
	if workspace == nil || strings.TrimSpace(workspace.ID) == "" {
		return "", fmt.Errorf("workspace is not available")
	}
	return workspace.ID, nil
}

func MissingRequiredInputError(key string) error {
	return fmt.Errorf("%w: required input %q is missing", ErrInvalidInput, strings.TrimSpace(key))
}

func InvalidInputKeyError(key string) error {
	return fmt.Errorf("%w: invalid input %q", ErrInvalidInput, strings.TrimSpace(key))
}

func StringInput(input map[string]any, key string) (string, bool, error) {
	value, ok := input[key]
	if !ok || value == nil {
		return "", false, nil
	}
	text, ok := value.(string)
	if !ok {
		return "", false, InvalidInputKeyError(key)
	}
	return strings.TrimSpace(text), true, nil
}

func RequiredStringInput(input map[string]any, key string) (string, error) {
	value, _, err := StringInput(input, key)
	if err != nil {
		return "", err
	}
	if value == "" {
		return "", MissingRequiredInputError(key)
	}
	return value, nil
}

func IntInput(input map[string]any, key string) (int, bool, error) {
	raw, ok, err := StringInput(input, key)
	if err != nil || !ok || raw == "" {
		return 0, ok, err
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, true, InvalidInputKeyError(key)
	}
	return value, true, nil
}

func Int64Input(input map[string]any, key string) (int64, bool, error) {
	raw, ok, err := StringInput(input, key)
	if err != nil || !ok || raw == "" {
		return 0, ok, err
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, true, InvalidInputKeyError(key)
	}
	return value, true, nil
}
