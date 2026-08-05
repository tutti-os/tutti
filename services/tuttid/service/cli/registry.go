package cli

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

var (
	ErrCommandNotFound    = errors.New("cli command not found")
	ErrInvalidCommand     = errors.New("invalid cli command")
	ErrInvalidInput       = errors.New("invalid cli command input")
	ErrServiceUnavailable = errors.New("cli service unavailable")
	ErrWorkspaceOperation = errors.New("cli workspace operation failed")
)

type InvokeError struct {
	Kind       error
	ReasonCode string
	Reason     string
	Err        error
}

func (e *InvokeError) Error() string {
	if e == nil {
		return ""
	}
	message := strings.TrimSpace(e.Reason)
	if e.Err != nil {
		if message != "" {
			message += ": "
		}
		message += e.Err.Error()
	}
	if message == "" && e.Kind != nil {
		message = e.Kind.Error()
	}
	return message
}

func (e *InvokeError) Unwrap() error {
	if e == nil {
		return nil
	}
	if e.Kind == nil {
		return e.Err
	}
	if e.Err == nil {
		return e.Kind
	}
	return errors.Join(e.Kind, e.Err)
}

func ServiceUnavailableError(reason string, err error) error {
	return &InvokeError{Kind: ErrServiceUnavailable, Reason: strings.TrimSpace(reason), Err: err}
}

func WorkspaceOperationError(reason string, err error) error {
	return &InvokeError{Kind: ErrWorkspaceOperation, Reason: strings.TrimSpace(reason), Err: err}
}

func InvalidInputReasonError(reasonCode string, message string, err error) error {
	return &InvokeError{
		Kind:       ErrInvalidInput,
		ReasonCode: strings.TrimSpace(reasonCode),
		Reason:     strings.TrimSpace(message),
		Err:        err,
	}
}

func InvokeErrorReason(err error) string {
	var invokeErr *InvokeError
	if errors.As(err, &invokeErr) {
		if invokeErr.ReasonCode != "" {
			return invokeErr.ReasonCode
		}
		return invokeErr.Reason
	}
	return ""
}

type Registry struct {
	commands                 map[string]Command
	order                    []string
	commandProviderID        map[string]string
	providerFilters          map[string]CapabilityFilterProvider
	AppCommands              DynamicCommandRegistry
	AgentSessionCapabilities AgentSessionCapabilityResolver
}

type Provider interface {
	AppID() string
	Commands() []Command
}

type CapabilityFilterProvider interface {
	FilterCapabilities(context.Context, InvokeContext, []Capability) []Capability
}

type AgentSessionCapabilityProjection struct {
	AllowedIDs            []string
	IncludeIntegrationIDs []string
	ExcludeIDs            []string
}

type AgentSessionCapabilityResolver interface {
	ResolveAgentSessionCapabilityProjection(
		context.Context,
		string,
		string,
	) (AgentSessionCapabilityProjection, error)
}

type DynamicCommandRegistry interface {
	Capabilities(context.Context, InvokeContext) []Capability
	Invoke(context.Context, InvokeRequest) (CommandOutput, error)
}

func NewRegistryFromProviders(providers ...Provider) (*Registry, error) {
	registry := newRegistry()
	for _, provider := range providers {
		if provider == nil {
			return nil, fmt.Errorf("%w: provider is nil", ErrInvalidCommand)
		}
		providerID := strings.TrimSpace(provider.AppID())
		if providerID == "" {
			return nil, fmt.Errorf("%w: provider app id is required", ErrInvalidCommand)
		}
		if filter, ok := provider.(CapabilityFilterProvider); ok {
			registry.providerFilters[providerID] = filter
		}
		for _, command := range provider.Commands() {
			if err := registry.register(command, providerID); err != nil {
				return nil, err
			}
		}
	}
	return registry, nil
}

func newRegistry() *Registry {
	return &Registry{
		commands:          map[string]Command{},
		order:             []string{},
		commandProviderID: map[string]string{},
		providerFilters:   map[string]CapabilityFilterProvider{},
	}
}

func (r *Registry) Register(command Command) error {
	return r.register(command, "")
}

func (r *Registry) register(command Command, providerID string) error {
	if r == nil {
		return fmt.Errorf("%w: registry is nil", ErrInvalidCommand)
	}
	id := strings.TrimSpace(command.Capability.ID)
	if id == "" {
		return fmt.Errorf("%w: id is required", ErrInvalidCommand)
	}
	if len(command.Capability.Path) == 0 {
		return fmt.Errorf("%w: path is required", ErrInvalidCommand)
	}
	if strings.TrimSpace(command.Capability.Summary) == "" {
		return fmt.Errorf("%w: summary is required", ErrInvalidCommand)
	}
	if command.Handler == nil {
		return fmt.Errorf("%w: handler is required", ErrInvalidCommand)
	}
	command.Capability.ID = id
	if command.Capability.Source.Kind == "" {
		command.Capability.Source.Kind = CapabilitySourceBuiltin
	}
	if _, exists := r.commands[id]; exists {
		return fmt.Errorf("%w: duplicate id %q", ErrInvalidCommand, id)
	}
	r.commands[id] = command
	r.order = append(r.order, id)
	if providerID != "" {
		r.commandProviderID[id] = providerID
	}
	return nil
}

func (r *Registry) Capabilities(ctx context.Context, invokeContext InvokeContext) []Capability {
	if r == nil || len(r.commands) == 0 {
		if r != nil && r.AppCommands != nil {
			return r.AppCommands.Capabilities(ctx, invokeContext)
		}
		return []Capability{}
	}
	var allowedByProvider map[string]map[string]struct{}
	if !invokeContext.SkipCapabilityFilters {
		allowedByProvider = r.filteredCapabilityIDsByProvider(ctx, invokeContext)
	}
	projection, projected, err := r.resolveAgentSessionProjection(ctx, invokeContext)
	if err != nil {
		return []Capability{}
	}
	if projected {
		invokeContext.IncludeIntegrationCapabilities = true
	}
	result := make([]Capability, 0, len(r.commands))
	for _, id := range r.order {
		if command, ok := r.commands[id]; ok {
			if !r.capabilityVisible(id, allowedByProvider) {
				continue
			}
			if !capabilityDiscoverable(command.Capability, invokeContext) {
				continue
			}
			if projected && !projection.allows(command.Capability) {
				continue
			}
			result = append(result, command.Capability)
		}
	}
	if r.AppCommands != nil {
		appCapabilities := r.AppCommands.Capabilities(ctx, invokeContext)
		if projected {
			appCapabilities = projection.filter(appCapabilities)
		}
		result = append(result, appCapabilities...)
	}
	return result
}

func (r *Registry) filteredCapabilityIDsByProvider(ctx context.Context, invokeContext InvokeContext) map[string]map[string]struct{} {
	if r == nil || len(r.providerFilters) == 0 {
		return nil
	}
	capabilitiesByProvider := map[string][]Capability{}
	for _, id := range r.order {
		providerID := r.commandProviderID[id]
		if providerID == "" || r.providerFilters[providerID] == nil {
			continue
		}
		command, ok := r.commands[id]
		if !ok {
			continue
		}
		capabilitiesByProvider[providerID] = append(capabilitiesByProvider[providerID], command.Capability)
	}
	if len(capabilitiesByProvider) == 0 {
		return nil
	}
	allowedByProvider := map[string]map[string]struct{}{}
	for providerID, capabilities := range capabilitiesByProvider {
		filter := r.providerFilters[providerID]
		allowed := map[string]struct{}{}
		for _, capability := range filter.FilterCapabilities(ctx, invokeContext, append([]Capability(nil), capabilities...)) {
			id := strings.TrimSpace(capability.ID)
			if id != "" {
				allowed[id] = struct{}{}
			}
		}
		allowedByProvider[providerID] = allowed
	}
	return allowedByProvider
}

func (r *Registry) capabilityVisible(id string, allowedByProvider map[string]map[string]struct{}) bool {
	if len(allowedByProvider) == 0 {
		return true
	}
	providerID := r.commandProviderID[id]
	if providerID == "" {
		return true
	}
	allowed, ok := allowedByProvider[providerID]
	if !ok {
		return true
	}
	_, visible := allowed[id]
	return visible
}

func capabilityDiscoverable(capability Capability, invokeContext InvokeContext) bool {
	if invokeContext.IncludeIntegrationCapabilities {
		return true
	}
	return NormalizeCapabilityVisibility(capability.Visibility) != CapabilityVisibilityIntegration
}

func NormalizeCapabilityVisibility(visibility CapabilityVisibility) CapabilityVisibility {
	switch CapabilityVisibility(strings.TrimSpace(string(visibility))) {
	case "", CapabilityVisibilityPublic:
		return CapabilityVisibilityPublic
	case CapabilityVisibilityIntegration:
		return CapabilityVisibilityIntegration
	default:
		return visibility
	}
}

func (r *Registry) Invoke(ctx context.Context, request InvokeRequest) (CommandOutput, error) {
	if r == nil {
		return CommandOutput{}, ErrCommandNotFound
	}
	commandID := strings.TrimSpace(request.CommandID)
	command, ok := r.commands[commandID]
	if !ok {
		if r.AppCommands != nil {
			capability, err := r.authorizeDynamicCommand(ctx, request.Context, commandID)
			if err != nil {
				return CommandOutput{}, err
			}
			if err := validateCapabilityInput(capability.InputSchema, request.Input); err != nil {
				return CommandOutput{}, err
			}
			return r.AppCommands.Invoke(ctx, request)
		}
		return CommandOutput{}, ErrCommandNotFound
	}
	if err := r.authorizeProviderCapability(ctx, request.Context, commandID, command.Capability); err != nil {
		return CommandOutput{}, err
	}
	if err := r.authorizeAgentSessionCapability(
		ctx, request.Context, command.Capability,
	); err != nil {
		return CommandOutput{}, err
	}
	if err := validateCapabilityInput(command.Capability.InputSchema, request.Input); err != nil {
		return CommandOutput{}, err
	}
	if request.OutputMode == "" {
		request.OutputMode = command.Capability.Output.DefaultMode
	}
	if request.Context.Source == "" {
		request.Context.Source = "cli"
	}
	return command.Handler(ctx, request)
}

func (r *Registry) authorizeProviderCapability(
	ctx context.Context,
	invokeContext InvokeContext,
	commandID string,
	_ Capability,
) error {
	providerID := r.commandProviderID[commandID]
	filter := r.providerFilters[providerID]
	if providerID == "" || filter == nil {
		return nil
	}
	// SkipCapabilityFilters is a discovery-only host escape hatch. Invocation
	// always re-evaluates the provider policy with the escape hatch disabled.
	invokeContext.SkipCapabilityFilters = false
	allowedByProvider := r.filteredCapabilityIDsByProvider(ctx, invokeContext)
	if r.capabilityVisible(commandID, allowedByProvider) {
		return nil
	}
	return ErrCommandNotFound
}

func (r *Registry) resolveAgentSessionProjection(
	ctx context.Context,
	invokeContext InvokeContext,
) (agentSessionCapabilityProjection, bool, error) {
	workspaceID := strings.TrimSpace(invokeContext.WorkspaceID)
	sessionID := strings.TrimSpace(invokeContext.AgentSessionID)
	if sessionID == "" {
		return agentSessionCapabilityProjection{}, false, nil
	}
	if workspaceID == "" || r.AgentSessionCapabilities == nil {
		return agentSessionCapabilityProjection{}, true, ServiceUnavailableError(
			"agent_session_capability_projection_unavailable",
			errors.New("agent session capability resolver is unavailable"),
		)
	}
	projection, err := r.AgentSessionCapabilities.ResolveAgentSessionCapabilityProjection(
		ctx, workspaceID, sessionID,
	)
	if err != nil {
		return agentSessionCapabilityProjection{}, true, ServiceUnavailableError(
			"agent_session_capability_projection_unavailable", err,
		)
	}
	return newAgentSessionCapabilityProjection(projection), true, nil
}

func (r *Registry) authorizeAgentSessionCapability(
	ctx context.Context,
	invokeContext InvokeContext,
	capability Capability,
) error {
	projection, projected, err := r.resolveAgentSessionProjection(ctx, invokeContext)
	if err != nil {
		return err
	}
	if projected && !projection.allows(capability) {
		return ErrCommandNotFound
	}
	return nil
}

func (r *Registry) authorizeDynamicCommand(
	ctx context.Context,
	invokeContext InvokeContext,
	commandID string,
) (Capability, error) {
	projection, projected, err := r.resolveAgentSessionProjection(ctx, invokeContext)
	if err != nil {
		return Capability{}, err
	}
	if projected {
		invokeContext.IncludeIntegrationCapabilities = true
	}
	invokeContext.SkipCapabilityFilters = false
	for _, capability := range r.AppCommands.Capabilities(ctx, invokeContext) {
		if strings.TrimSpace(capability.ID) == commandID {
			if !projected || projection.allows(capability) {
				return capability, nil
			}
			break
		}
	}
	return Capability{}, ErrCommandNotFound
}

type agentSessionCapabilityProjection struct {
	allowedIDs             map[string]struct{}
	includedIntegrationIDs map[string]struct{}
	excludedIDs            map[string]struct{}
}

func newAgentSessionCapabilityProjection(
	projection AgentSessionCapabilityProjection,
) agentSessionCapabilityProjection {
	result := agentSessionCapabilityProjection{
		allowedIDs:             make(map[string]struct{}),
		includedIntegrationIDs: make(map[string]struct{}),
		excludedIDs:            make(map[string]struct{}),
	}
	for _, id := range projection.AllowedIDs {
		if id = strings.TrimSpace(id); id != "" {
			result.allowedIDs[id] = struct{}{}
		}
	}
	for _, id := range projection.IncludeIntegrationIDs {
		if id = strings.TrimSpace(id); id != "" {
			result.includedIntegrationIDs[id] = struct{}{}
		}
	}
	for _, id := range projection.ExcludeIDs {
		if id = strings.TrimSpace(id); id != "" {
			result.excludedIDs[id] = struct{}{}
		}
	}
	return result
}

func (projection agentSessionCapabilityProjection) filter(
	capabilities []Capability,
) []Capability {
	result := make([]Capability, 0, len(capabilities))
	for _, capability := range capabilities {
		if projection.allows(capability) {
			result = append(result, capability)
		}
	}
	return result
}

func (projection agentSessionCapabilityProjection) allows(
	capability Capability,
) bool {
	id := strings.TrimSpace(capability.ID)
	if len(projection.allowedIDs) > 0 {
		if _, allowed := projection.allowedIDs[id]; !allowed {
			return false
		}
	}
	if _, excluded := projection.excludedIDs[id]; excluded {
		return false
	}
	if NormalizeCapabilityVisibility(capability.Visibility) !=
		CapabilityVisibilityIntegration {
		return true
	}
	_, included := projection.includedIntegrationIDs[id]
	return included
}
