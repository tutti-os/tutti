package framework

import (
	"fmt"
	"strings"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

func FormatOutput(spec OutputSpec, mode cliservice.OutputMode, result any) (cliservice.CommandOutput, error) {
	if mode == "" {
		mode = spec.DefaultMode
	}
	switch mode {
	case cliservice.OutputModeJSON:
		formatter := jsonFormatter(spec)
		if formatter == nil {
			return cliservice.CommandOutput{}, fmt.Errorf("%w: json output is not supported", cliservice.ErrInvalidCommand)
		}
		return cliservice.CommandOutput{Kind: cliservice.OutputModeJSON, Value: formatter(result)}, nil
	case cliservice.OutputModeTable:
		if spec.Table == nil || spec.Table.Rows == nil {
			return cliservice.CommandOutput{}, fmt.Errorf("%w: table output is not supported", cliservice.ErrInvalidCommand)
		}
		return cliservice.CommandOutput{
			Kind:    cliservice.OutputModeTable,
			Columns: spec.Table.Columns,
			Rows:    spec.Table.Rows(result),
		}, nil
	case cliservice.OutputModePlain:
		if spec.PlainText == nil {
			return cliservice.CommandOutput{}, fmt.Errorf("%w: plain output is not supported", cliservice.ErrInvalidCommand)
		}
		return cliservice.CommandOutput{Kind: cliservice.OutputModePlain, Text: spec.PlainText(result)}, nil
	case cliservice.OutputModeMarkdown:
		if spec.Markdown == nil {
			return cliservice.CommandOutput{}, fmt.Errorf("%w: markdown output is not supported", cliservice.ErrInvalidCommand)
		}
		return cliservice.CommandOutput{Kind: cliservice.OutputModeMarkdown, Text: spec.Markdown(result)}, nil
	default:
		return cliservice.CommandOutput{}, fmt.Errorf("%w: unsupported output mode %q", cliservice.ErrInvalidCommand, strings.TrimSpace(string(mode)))
	}
}

func jsonFormatter(spec OutputSpec) func(any) map[string]any {
	if spec.DefaultView != "" {
		return spec.JSONViews[spec.DefaultView]
	}
	return spec.JSONValue
}
