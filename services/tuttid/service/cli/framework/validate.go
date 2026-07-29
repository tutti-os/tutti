package framework

import (
	"fmt"
	"regexp"
	"strings"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

var kebabNamePattern = regexp.MustCompile(`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`)

func ValidateSpec[T any](spec CommandSpec[T]) error {
	if strings.TrimSpace(spec.ID) == "" {
		return fmt.Errorf("%w: id is required", cliservice.ErrInvalidCommand)
	}
	if len(spec.Path) == 0 {
		return fmt.Errorf("%w: path is required", cliservice.ErrInvalidCommand)
	}
	for _, segment := range spec.Path {
		if !kebabNamePattern.MatchString(segment) {
			return fmt.Errorf("%w: invalid path segment %q", cliservice.ErrInvalidCommand, segment)
		}
	}
	if strings.TrimSpace(spec.Summary) == "" {
		return fmt.Errorf("%w: summary is required", cliservice.ErrInvalidCommand)
	}
	if strings.TrimSpace(spec.Description) == "" {
		return fmt.Errorf("%w: description is required", cliservice.ErrInvalidCommand)
	}
	if spec.Kind != KindList && spec.Kind != KindGet && spec.Kind != KindAction {
		return fmt.Errorf("%w: invalid command kind %q", cliservice.ErrInvalidCommand, spec.Kind)
	}
	if spec.Run == nil {
		return fmt.Errorf("%w: run is required", cliservice.ErrInvalidCommand)
	}
	if spec.Output.DefaultMode == "" {
		return fmt.Errorf("%w: default output mode is required", cliservice.ErrInvalidCommand)
	}
	if err := validateExecution(spec.Execution, spec.Output); err != nil {
		return err
	}
	if err := validateInputs(spec.Inputs); err != nil {
		return err
	}
	return validateOutput(spec.Kind, spec.Output)
}

func validateExecution(execution *cliservice.CommandExecution, output OutputSpec) error {
	if execution == nil {
		return nil
	}
	if execution.Mode != cliservice.CommandExecutionModeWait {
		return fmt.Errorf("%w: invalid execution mode %q", cliservice.ErrInvalidCommand, execution.Mode)
	}
	if output.DefaultMode != cliservice.OutputModeJSON || output.Continuation == nil {
		return fmt.Errorf("%w: wait execution requires json default output and a continuation formatter", cliservice.ErrInvalidCommand)
	}
	return nil
}

func validateInputs(input InputSpec) error {
	seen := map[string]struct{}{}
	for _, field := range input.Fields {
		if !kebabNamePattern.MatchString(field.Name) {
			return fmt.Errorf("%w: invalid input name %q", cliservice.ErrInvalidCommand, field.Name)
		}
		if _, ok := seen[field.Name]; ok {
			return fmt.Errorf("%w: duplicate input name %q", cliservice.ErrInvalidCommand, field.Name)
		}
		seen[field.Name] = struct{}{}
		if field.Required && strings.Contains(field.Name, "topic-id") && strings.TrimSpace(field.Hint) == "" {
			return fmt.Errorf("%w: required input %q needs a recovery hint", cliservice.ErrInvalidCommand, field.Name)
		}
	}
	return nil
}

func validateOutput(kind CommandKind, output OutputSpec) error {
	switch output.DefaultMode {
	case cliservice.OutputModeJSON:
		if !hasJSONFormatter(output) {
			return fmt.Errorf("%w: default json output has no formatter", cliservice.ErrInvalidCommand)
		}
	case cliservice.OutputModeTable:
		if output.Table == nil || output.Table.Rows == nil {
			return fmt.Errorf("%w: default table output has no formatter", cliservice.ErrInvalidCommand)
		}
	case cliservice.OutputModePlain:
		if output.PlainText == nil {
			return fmt.Errorf("%w: default plain output has no formatter", cliservice.ErrInvalidCommand)
		}
	case cliservice.OutputModeMarkdown:
		if output.Markdown == nil {
			return fmt.Errorf("%w: default markdown output has no formatter", cliservice.ErrInvalidCommand)
		}
	default:
		return fmt.Errorf("%w: invalid default output mode %q", cliservice.ErrInvalidCommand, output.DefaultMode)
	}
	if output.JSON || output.DefaultMode == cliservice.OutputModeJSON || output.JSONValue != nil || len(output.JSONViews) > 0 {
		if err := validateJSONOutput(kind, output); err != nil {
			return err
		}
	}
	if kind == KindList && !output.ListCompact {
		return fmt.Errorf("%w: list command must declare compact output or opt out", cliservice.ErrInvalidCommand)
	}
	return nil
}

func validateJSONOutput(kind CommandKind, output OutputSpec) error {
	expectedView := defaultViewForKind(kind)
	if output.DefaultView == "" {
		return fmt.Errorf("%w: json output default view is required", cliservice.ErrInvalidCommand)
	}
	if output.DefaultView != expectedView {
		return fmt.Errorf("%w: %s command json default view must be %q", cliservice.ErrInvalidCommand, kind, expectedView)
	}
	if len(output.JSONViews) > 0 {
		if output.JSONViews[output.DefaultView] == nil {
			return fmt.Errorf("%w: json output has no formatter for default view %q", cliservice.ErrInvalidCommand, output.DefaultView)
		}
		if output.JSONValue != nil && !output.RawJSON {
			return fmt.Errorf("%w: json output cannot mix views with bare JSONValue", cliservice.ErrInvalidCommand)
		}
	}
	if output.JSONValue != nil {
		if !output.RawJSON {
			return fmt.Errorf("%w: bare JSONValue requires RawJSON", cliservice.ErrInvalidCommand)
		}
		if strings.TrimSpace(output.RawJSONReason) == "" {
			return fmt.Errorf("%w: RawJSON requires a reason", cliservice.ErrInvalidCommand)
		}
	}
	return nil
}

func defaultViewForKind(kind CommandKind) OutputView {
	if kind == KindGet {
		return ViewDetail
	}
	return ViewSummary
}

func hasJSONFormatter(output OutputSpec) bool {
	if output.DefaultView != "" && output.JSONViews[output.DefaultView] != nil {
		return true
	}
	return output.JSONValue != nil
}
