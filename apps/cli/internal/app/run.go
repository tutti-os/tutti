package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/tutti-os/tutti/apps/cli/internal/daemon"
	"github.com/tutti-os/tutti/apps/cli/internal/defaults"
)

type options struct {
	json bool
}

func Run(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) int {
	return RunWithProgram(ctx, "tutti", args, stdout, stderr)
}

func RunWithProgram(ctx context.Context, program string, args []string, stdout io.Writer, stderr io.Writer) int {
	commandName := displayCommandName(program)
	opts, rest, err := parseOptions(args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if len(rest) == 0 || rest[0] == "help" || rest[0] == "--help" || rest[0] == "-h" {
		return runHelp(ctx, commandName, stdout)
	}

	switch rest[0] {
	case "status":
		if len(rest) != 1 {
			fmt.Fprintf(stderr, "usage: %s status [--json]\n", commandName)
			return 2
		}
		return runStatus(ctx, commandName, opts, stdout, stderr)
	default:
		return runDynamic(ctx, commandName, opts, rest, stdout, stderr)
	}
}

func displayCommandName(program string) string {
	name := filepath.Base(strings.TrimSpace(program))
	if name == "." || name == "" {
		name = "tutti"
	}
	if strings.EqualFold(name, "tutti") && isDevelopmentCLI(program) {
		return "tutti-dev"
	}
	return name
}

func isDevelopmentCLI(program string) bool {
	cleanProgram := filepath.Clean(program)
	devBuildSegment := "build" + string(filepath.Separator) + "dev" + string(filepath.Separator)
	if strings.HasPrefix(cleanProgram, devBuildSegment) ||
		strings.Contains(cleanProgram, string(filepath.Separator)+devBuildSegment) {
		return true
	}
	return defaults.ResolveDefaultsFromEnv().Runtime.Env == "development"
}

func parseOptions(args []string) (options, []string, error) {
	var opts options
	rest := make([]string, 0, len(args))
	for _, arg := range args {
		switch arg {
		case "--json":
			opts.json = true
		default:
			rest = append(rest, arg)
		}
	}
	return opts, rest, nil
}

func runStatus(ctx context.Context, commandName string, opts options, stdout io.Writer, stderr io.Writer) int {
	client, err := discoverClient()
	if err != nil {
		fmt.Fprintf(stderr, "%s status: %v\n", commandName, err)
		return 1
	}
	health, err := client.GetHealth(ctx)
	if err != nil {
		fmt.Fprintf(stderr, "%s status: %v\n", commandName, err)
		return 1
	}

	if opts.json {
		return writeJSON(stdout, stderr, health)
	}

	fmt.Fprintf(stdout, "service: %s\nstatus: %s\n", health.Service, health.Status)
	return 0
}

func runDynamic(ctx context.Context, commandName string, opts options, args []string, stdout io.Writer, stderr io.Writer) int {
	client, err := discoverClient()
	if err != nil {
		fmt.Fprintf(stderr, "%s %s: %v\n", commandName, strings.Join(args, " "), err)
		return 1
	}
	invokeContext := cliInvokeContextFromEnv()
	capabilities, err := client.ListCapabilitiesForWorkspace(ctx, invokeContext.WorkspaceID)
	if err != nil {
		fmt.Fprintf(stderr, "%s %s: %v\n", commandName, strings.Join(args, " "), err)
		return 1
	}
	command, commandArgs, ok := matchCapability(capabilities.Commands, args)
	if !ok {
		if prefix, help := commandHelpPrefix(args); help {
			if printCommandPrefixHelp(stdout, commandName, prefix, capabilities.Commands) {
				return 0
			}
		}
		fmt.Fprintf(stderr, "unknown command: %s\n", strings.Join(args, " "))
		return 2
	}
	if isCommandHelpRequest(commandArgs) {
		printDynamicCommandHelp(stdout, commandName, command)
		return 0
	}
	input, err := parseCommandInput(command, commandArgs)
	if err != nil {
		fmt.Fprintf(stderr, "%s %s: %v\n", commandName, strings.Join(command.Path, " "), err)
		return 2
	}
	outputMode := command.Output.DefaultMode
	if opts.json {
		outputMode = "json"
	}
	response, err := client.Invoke(ctx, command.ID, daemon.InvokeRequest{
		Input:      input,
		OutputMode: outputMode,
		Context:    invokeContext,
	})
	if err != nil {
		fmt.Fprintf(stderr, "%s %s: %v\n", commandName, strings.Join(command.Path, " "), err)
		return 1
	}
	if response.Output == nil {
		return 0
	}
	if opts.json {
		return writeDynamicJSON(stdout, stderr, *response.Output)
	}
	return writeCommandOutput(stdout, stderr, *response.Output)
}

func runHelp(ctx context.Context, commandName string, stdout io.Writer) int {
	var commands []daemon.Capability
	client, err := discoverClient()
	if err == nil {
		invokeContext := cliInvokeContextFromEnv()
		capabilities, listErr := client.ListCapabilitiesForWorkspace(ctx, invokeContext.WorkspaceID)
		if listErr == nil {
			commands = capabilities.Commands
		}
	}
	printHelp(stdout, commandName, commands)
	return 0
}

func cliInvokeContextFromEnv() daemon.InvokeContext {
	return daemon.InvokeContext{
		Source:          "cli",
		WorkspaceID:     strings.TrimSpace(os.Getenv("TUTTI_WORKSPACE_ID")),
		ParentCommandID: strings.TrimSpace(os.Getenv("TUTTI_APP_CLI_PARENT_COMMAND_ID")),
		AgentSessionID:  strings.TrimSpace(os.Getenv("TUTTI_AGENT_SESSION_ID")),
	}
}

func discoverClient() (*daemon.Client, error) {
	endpoint, err := daemon.DiscoverEndpoint()
	if err != nil {
		return nil, err
	}
	client, err := daemon.NewClient(endpoint)
	if err != nil {
		return nil, err
	}
	return client, nil
}

func matchCapability(commands []daemon.Capability, args []string) (daemon.Capability, []string, bool) {
	var matchedCommand daemon.Capability
	var matchedArgs []string
	matchedLength := -1
	for _, command := range commands {
		if len(args) < len(command.Path) {
			continue
		}
		matched := true
		for index, segment := range command.Path {
			if args[index] != segment {
				matched = false
				break
			}
		}
		if matched && len(command.Path) > matchedLength {
			matchedCommand = command
			matchedArgs = args[len(command.Path):]
			matchedLength = len(command.Path)
		}
	}
	if matchedLength >= 0 {
		return matchedCommand, matchedArgs, true
	}
	return daemon.Capability{}, nil, false
}

func parseCommandInput(command daemon.Capability, args []string) (map[string]any, error) {
	if input, ok, err := parsePositionalCommandInput(command, args); ok || err != nil {
		return input, err
	}
	booleanFlags := commandBooleanFlags(command.InputSchema)
	input := map[string]any{}
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if !strings.HasPrefix(arg, "--") {
			return nil, fmt.Errorf("unexpected argument %q", arg)
		}
		nameValue := strings.TrimPrefix(arg, "--")
		name, value, found := strings.Cut(nameValue, "=")
		if !found {
			if index+1 >= len(args) || strings.HasPrefix(args[index+1], "--") {
				if !booleanFlags[name] {
					return nil, fmt.Errorf("missing value for --%s", name)
				}
				input[name] = true
				continue
			} else {
				index++
				value = args[index]
			}
		}
		if strings.TrimSpace(name) == "" {
			return nil, fmt.Errorf("invalid flag %q", arg)
		}
		input[name] = value
	}
	return input, nil
}

func commandBooleanFlags(schema map[string]any) map[string]bool {
	flags := map[string]bool{}
	properties, ok := schema["properties"].(map[string]any)
	if !ok {
		return flags
	}
	for name, property := range properties {
		if schemaPropertyType(property) == "boolean" {
			flags[name] = true
		}
	}
	return flags
}

func parsePositionalCommandInput(command daemon.Capability, args []string) (map[string]any, bool, error) {
	switch command.ID {
	case "agent-context.agent.open":
		if len(args) != 1 || strings.HasPrefix(args[0], "--") {
			return nil, false, nil
		}
		return map[string]any{"session-id": args[0]}, true, nil
	case "agent-context.agent.send":
		if len(args) < 2 || strings.HasPrefix(args[0], "--") {
			return nil, false, nil
		}
		return map[string]any{
			"session-id": args[0],
			"prompt":     strings.Join(args[1:], " "),
		}, true, nil
	default:
		return nil, false, nil
	}
}

func isCommandHelpRequest(args []string) bool {
	return len(args) == 1 && (args[0] == "--help" || args[0] == "-h")
}

func commandHelpPrefix(args []string) ([]string, bool) {
	if len(args) == 0 {
		return nil, false
	}
	last := args[len(args)-1]
	if last != "--help" && last != "-h" {
		return nil, false
	}
	prefix := args[:len(args)-1]
	if len(prefix) == 0 {
		return nil, false
	}
	return prefix, true
}

func writeCommandOutput(stdout io.Writer, stderr io.Writer, output daemon.CommandOutput) int {
	switch output.Kind {
	case "plain", "markdown":
		fmt.Fprintln(stdout, output.Text)
		return 0
	case "table":
		writeTable(stdout, output.Columns, output.Rows)
		return 0
	case "json":
		return writeDynamicJSON(stdout, stderr, output)
	default:
		return writeJSON(stdout, stderr, output)
	}
}

func writeDynamicJSON(stdout io.Writer, stderr io.Writer, output daemon.CommandOutput) int {
	if len(output.Value) > 0 {
		return writeJSON(stdout, stderr, output.Value)
	}
	if output.Rows != nil {
		return writeJSON(stdout, stderr, output.Rows)
	}
	return writeJSON(stdout, stderr, output)
}

func writeJSON(stdout io.Writer, stderr io.Writer, value any) int {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		fmt.Fprintf(stderr, "encode output: %v\n", err)
		return 1
	}
	fmt.Fprintln(stdout, string(encoded))
	return 0
}

func writeTable(stdout io.Writer, columns []daemon.TableColumn, rows []map[string]any) {
	if len(columns) == 0 {
		for _, row := range rows {
			fmt.Fprintln(stdout, row)
		}
		return
	}
	widths := make([]int, len(columns))
	for index, column := range columns {
		widths[index] = len(column.Label)
		for _, row := range rows {
			width := len(fmt.Sprint(row[column.Key]))
			if width > widths[index] {
				widths[index] = width
			}
		}
	}
	for index, column := range columns {
		if index > 0 {
			fmt.Fprint(stdout, "  ")
		}
		fmt.Fprintf(stdout, "%-*s", widths[index], column.Label)
	}
	fmt.Fprintln(stdout)
	for index := range columns {
		if index > 0 {
			fmt.Fprint(stdout, "  ")
		}
		fmt.Fprint(stdout, strings.Repeat("-", widths[index]))
	}
	fmt.Fprintln(stdout)
	for _, row := range rows {
		for index, column := range columns {
			if index > 0 {
				fmt.Fprint(stdout, "  ")
			}
			fmt.Fprintf(stdout, "%-*s", widths[index], fmt.Sprint(row[column.Key]))
		}
		fmt.Fprintln(stdout)
	}
}

func printHelp(stdout io.Writer, commandName string, commands []daemon.Capability) {
	fmt.Fprintf(stdout, "Usage: %s [--json] <command>\n", commandName)
	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "Commands:")
	rows := []helpCommandRow{{Name: "status", Summary: "Show local tuttid status"}}
	rows = append(rows, rootHelpRows(commands)...)
	printHelpRows(stdout, rows)
}

func printCommandPrefixHelp(stdout io.Writer, commandName string, prefix []string, commands []daemon.Capability) bool {
	matches := matchingPrefixCommands(commands, prefix)
	if len(matches) == 0 {
		return false
	}
	fmt.Fprintf(stdout, "Usage: %s %s <command> [--json]\n", commandName, strings.Join(prefix, " "))
	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "Commands:")
	printHelpRows(stdout, prefixHelpRows(prefix, matches))
	fmt.Fprintln(stdout)
	fmt.Fprintf(stdout, "Use \"%s %s <command> --help\" for command details.\n", commandName, strings.Join(prefix, " "))
	printDocumentationHints(stdout, matches)
	return true
}

func printDynamicCommandHelp(stdout io.Writer, commandName string, command daemon.Capability) {
	flags := commandFlags(command.InputSchema)
	fmt.Fprintf(stdout, "Usage: %s %s [--json]", commandName, strings.Join(command.Path, " "))
	for _, flag := range flags {
		if flag.Required {
			fmt.Fprintf(stdout, " --%s <value>", flag.Name)
			continue
		}
		fmt.Fprintf(stdout, " [--%s <value>]", flag.Name)
	}
	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout)
	if strings.TrimSpace(command.Summary) != "" {
		fmt.Fprintln(stdout, command.Summary)
	}
	if strings.TrimSpace(command.Description) != "" && command.Description != command.Summary {
		if strings.TrimSpace(command.Summary) != "" {
			fmt.Fprintln(stdout)
		}
		fmt.Fprintln(stdout, command.Description)
	}
	if len(flags) == 0 {
		printDocumentationHints(stdout, []daemon.Capability{command})
		return
	}
	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "Flags:")
	width := 0
	for _, flag := range flags {
		if len(flag.Name) > width {
			width = len(flag.Name)
		}
	}
	for _, flag := range flags {
		required := ""
		if flag.Required {
			required = "  required"
		}
		description := ""
		if flag.Description != "" {
			description = "  " + flag.Description
		}
		fmt.Fprintf(stdout, "  --%-*s  %s%s%s\n", width, flag.Name, flag.Type, required, description)
	}
	printDocumentationHints(stdout, []daemon.Capability{command})
}

type helpCommandRow struct {
	Name    string
	Summary string
}

func rootHelpRows(commands []daemon.Capability) []helpCommandRow {
	type group struct {
		count       int
		summary     string
		description string
	}
	groups := map[string]group{}
	for _, command := range commands {
		if len(command.Path) == 0 {
			continue
		}
		name := command.Path[0]
		if name == "status" {
			continue
		}
		current := groups[name]
		current.count++
		if len(command.Path) == 1 && current.summary == "" {
			current.summary = command.Summary
		}
		if current.description == "" {
			current.description = commandScopeDescription(command)
		}
		groups[name] = current
	}
	names := make([]string, 0, len(groups))
	for name := range groups {
		names = append(names, name)
	}
	sort.Strings(names)
	rows := make([]helpCommandRow, 0, len(names))
	for _, name := range names {
		item := groups[name]
		summary := item.summary
		if summary == "" {
			summary = fmt.Sprintf("%d commands", item.count)
		}
		if item.description != "" && item.count > 0 {
			summary = fmt.Sprintf("%s  %d commands", item.description, item.count)
		}
		rows = append(rows, helpCommandRow{Name: name, Summary: summary})
	}
	return rows
}

func commandScopeDescription(command daemon.Capability) string {
	description := strings.TrimSpace(command.Source.CLIDescription)
	if description != "" {
		return description
	}
	return strings.TrimSpace(command.Source.AppDescription)
}

func matchingPrefixCommands(commands []daemon.Capability, prefix []string) []daemon.Capability {
	result := make([]daemon.Capability, 0)
	for _, command := range commands {
		if len(command.Path) <= len(prefix) {
			continue
		}
		matched := true
		for index, segment := range prefix {
			if command.Path[index] != segment {
				matched = false
				break
			}
		}
		if matched {
			result = append(result, command)
		}
	}
	sort.SliceStable(result, func(left, right int) bool {
		return strings.Join(result[left].Path, " ") < strings.Join(result[right].Path, " ")
	})
	return result
}

func prefixHelpRows(prefix []string, commands []daemon.Capability) []helpCommandRow {
	type group struct {
		count   int
		summary string
	}
	groups := map[string]group{}
	for _, command := range commands {
		if len(command.Path) <= len(prefix) {
			continue
		}
		remaining := command.Path[len(prefix):]
		name := remaining[0]
		current := groups[name]
		current.count++
		if len(remaining) == 1 && current.summary == "" {
			current.summary = command.Summary
		}
		groups[name] = current
	}
	names := make([]string, 0, len(groups))
	for name := range groups {
		names = append(names, name)
	}
	sort.Strings(names)
	rows := make([]helpCommandRow, 0, len(names))
	for _, name := range names {
		item := groups[name]
		summary := item.summary
		if summary == "" {
			summary = fmt.Sprintf("%d commands", item.count)
		}
		rows = append(rows, helpCommandRow{Name: name, Summary: summary})
	}
	return rows
}

func printHelpRows(stdout io.Writer, rows []helpCommandRow) {
	width := 0
	for _, row := range rows {
		if len(row.Name) > width {
			width = len(row.Name)
		}
	}
	for _, row := range rows {
		fmt.Fprintf(stdout, "  %-*s  %s\n", width, row.Name, row.Summary)
	}
}

func printDocumentationHints(stdout io.Writer, commands []daemon.Capability) {
	hints := documentationHints(commands)
	if len(hints) == 0 {
		return
	}
	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "More documentation:")
	for _, hint := range hints {
		fmt.Fprintf(stdout, "  %s\n", hint.File)
	}
}

type documentationHint struct {
	File string
}

func documentationHints(commands []daemon.Capability) []documentationHint {
	seen := map[string]struct{}{}
	hints := make([]documentationHint, 0)
	for _, command := range commands {
		file := strings.TrimSpace(command.Source.DocumentationPath)
		if file == "" {
			file = strings.TrimSpace(command.Source.DocumentationFile)
		}
		if file == "" {
			continue
		}
		if _, ok := seen[file]; ok {
			continue
		}
		seen[file] = struct{}{}
		hints = append(hints, documentationHint{File: file})
	}
	sort.SliceStable(hints, func(left, right int) bool {
		return hints[left].File < hints[right].File
	})
	return hints
}

type commandFlag struct {
	Name        string
	Type        string
	Description string
	Required    bool
}

func commandFlags(schema map[string]any) []commandFlag {
	properties, ok := schema["properties"].(map[string]any)
	if !ok || len(properties) == 0 {
		return nil
	}
	requiredNames := schemaRequiredNames(schema)
	required := map[string]bool{}
	for _, name := range requiredNames {
		required[name] = true
	}

	flags := make([]commandFlag, 0, len(properties))
	for _, name := range requiredNames {
		property, ok := properties[name]
		if !ok {
			continue
		}
		flags = append(flags, commandFlag{
			Name:        name,
			Type:        schemaPropertyType(property),
			Description: schemaPropertyDescription(property),
			Required:    true,
		})
	}

	optionalNames := make([]string, 0, len(properties))
	for name := range properties {
		if !required[name] {
			optionalNames = append(optionalNames, name)
		}
	}
	sort.Strings(optionalNames)
	for _, name := range optionalNames {
		flags = append(flags, commandFlag{
			Name:        name,
			Type:        schemaPropertyType(properties[name]),
			Description: schemaPropertyDescription(properties[name]),
		})
	}
	return flags
}

func schemaRequiredNames(schema map[string]any) []string {
	value, ok := schema["required"]
	if !ok {
		return nil
	}
	switch typed := value.(type) {
	case []string:
		return typed
	case []any:
		names := make([]string, 0, len(typed))
		for _, entry := range typed {
			name, ok := entry.(string)
			if ok {
				names = append(names, name)
			}
		}
		return names
	default:
		return nil
	}
}

func schemaPropertyType(property any) string {
	propertyMap, ok := property.(map[string]any)
	if !ok {
		return "value"
	}
	typeName, ok := propertyMap["type"].(string)
	if !ok || strings.TrimSpace(typeName) == "" {
		return "value"
	}
	return typeName
}

func schemaPropertyDescription(property any) string {
	propertyMap, ok := property.(map[string]any)
	if !ok {
		return ""
	}
	description, ok := propertyMap["description"].(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(description)
}
