package tuttiagent

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
)

type ProviderCommandResolver interface {
	ResolveProviderCommand(context.Context, string) (agentstatusservice.ProviderCommandResolution, error)
}

// AuthBootstrapper keeps every Tutti Agent auth entrypoint on the same
// provider command and managed-runtime environment used by sessions, status
// probes, and model discovery.
type AuthBootstrapper struct {
	ProviderCommands ProviderCommandResolver
	ResolveEnv       func([]string) []string
	ResolveCommand   func(string, []string) string
}

func NewAuthBootstrapper(providerCommands ProviderCommandResolver) *AuthBootstrapper {
	resolver := runtimecmd.Resolver{}
	return &AuthBootstrapper{
		ProviderCommands: providerCommands,
		ResolveEnv:       resolver.Env,
		ResolveCommand:   resolver.Resolve,
	}
}

func (b *AuthBootstrapper) Bootstrap(ctx context.Context, input runtimeprep.PrepareInput) {
	command, err := b.resolveLoginCommand(ctx)
	if err != nil {
		slog.Warn("tutti-agent auth command resolution failed",
			"event", "tutti_agent.auth_command.resolve_failed",
			"error", err,
		)
		return
	}
	slog.Info("tutti-agent auth command resolved",
		"event", "tutti_agent.auth_command.resolved",
		"binary", command.BinaryPath,
		"managed_node_configured", tuttiAgentEnvironmentValue(command.Env, "TUTTI_APP_NODE") != "",
		"managed_node_on_path", environmentPathContainsFileDir(command.Env, tuttiAgentEnvironmentValue(command.Env, "TUTTI_APP_NODE")),
	)
	bootstrapTuttiAgentUserAuth(ctx, input, command)
}

func (b *AuthBootstrapper) resolveLoginCommand(ctx context.Context) (tuttiAgentLoginCommand, error) {
	if b == nil || b.ProviderCommands == nil {
		return tuttiAgentLoginCommand{}, errors.New("provider command resolver is unavailable")
	}
	resolution, err := b.ProviderCommands.ResolveProviderCommand(ctx, tuttiAgentProvider)
	if err != nil {
		return tuttiAgentLoginCommand{}, err
	}
	if len(resolution.Command) == 0 || strings.TrimSpace(resolution.Command[0]) == "" {
		return tuttiAgentLoginCommand{}, errors.New("resolved provider command is empty")
	}
	resolveEnv := b.ResolveEnv
	if resolveEnv == nil {
		resolver := runtimecmd.Resolver{}
		resolveEnv = resolver.Env
	}
	env := resolveEnv(resolution.Env)
	resolveCommand := b.ResolveCommand
	if resolveCommand == nil {
		resolver := runtimecmd.Resolver{}
		resolveCommand = resolver.Resolve
	}
	return tuttiAgentLoginCommand{
		BinaryPath: resolveCommand(resolution.Command[0], env),
		Env:        env,
	}, nil
}

func (b *AuthBootstrapper) BootstrapUserAuth(ctx context.Context) {
	b.Bootstrap(ctx, runtimeprep.PrepareInput{})
}
