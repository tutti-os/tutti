package agentextension

import (
	"context"
	"errors"
	"fmt"

	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

// Refresh reconciles sources one at a time so preference-driven activation
// changes do not wait behind the complete remote release-index batch.
func (m *Manager) Refresh(ctx context.Context) []error {
	var errs []error
	for _, source := range m.Sources {
		m.reconcileMu.Lock()
		featureFlags := map[string]bool{}
		if m.Preferences != nil {
			preferences, err := m.Preferences.GetDesktopPreferences(ctx)
			if err != nil {
				m.reconcileMu.Unlock()
				return append(errs, fmt.Errorf("read agent extension feature flags: %w", err))
			}
			featureFlags = preferences.FeatureFlags
		}
		errs = append(errs, m.reconcileConfiguredSource(ctx, source, featureFlags)...)
		m.reconcileMu.Unlock()
	}
	return errs
}

func (m *Manager) reconcileConfiguredSource(
	ctx context.Context,
	source tuttitypes.AgentExtensionSource,
	featureFlags map[string]bool,
) []error {
	if !sourceEnabled(source, featureFlags) {
		if m.Store == nil {
			return nil
		}
		if err := m.Store.DeleteAgentTarget(ctx, targetID(source.Key)); err != nil {
			return []error{fmt.Errorf("disable extension %s target: %w", source.Key, err)}
		}
		return nil
	}

	installation, reconcileErr := m.reconcileSource(ctx, source)
	if reconcileErr != nil {
		var fallbackErr error
		installation, fallbackErr = m.loadActive(source.Key)
		if fallbackErr != nil {
			return []error{fmt.Errorf(
				"reconcile agent extension %s: %w",
				source.Key,
				errors.Join(reconcileErr, fmt.Errorf("load active installation fallback: %w", fallbackErr)),
			)}
		}
	}
	if err := m.registerTarget(ctx, installation); err != nil {
		return []error{fmt.Errorf("register agent extension %s: %w", source.Key, err)}
	}
	return nil
}
