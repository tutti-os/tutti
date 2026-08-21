package agentextension

import (
	"context"
	"errors"
	"fmt"
	"os"
)

// RestoreActive registers verified local installations without contacting
// extension release indexes. The boolean result reports whether an enabled
// source has no usable local installation and therefore still needs a
// synchronous reconcile before the daemon starts serving requests.
func (m *Manager) RestoreActive(ctx context.Context) (bool, []error) {
	m.reconcileMu.Lock()
	defer m.reconcileMu.Unlock()

	featureFlags := map[string]bool{}
	if m.Preferences != nil {
		preferences, err := m.Preferences.GetDesktopPreferences(ctx)
		if err != nil {
			return true, []error{fmt.Errorf("read agent extension feature flags: %w", err)}
		}
		featureFlags = preferences.FeatureFlags
	}

	requiresSynchronousReconcile := false
	var errs []error
	for _, source := range m.Sources {
		if !sourceEnabled(source, featureFlags) {
			if m.Store != nil {
				if err := m.Store.DeleteAgentTarget(ctx, targetID(source.Key)); err != nil {
					errs = append(errs, fmt.Errorf("disable extension %s target: %w", source.Key, err))
				}
			}
			continue
		}
		if sourceUsesLocalPackage(source) {
			// Development overrides are mutable inputs. Always snapshot the
			// configured directory before serving requests so a missing,
			// changed, or newly selected package cannot be hidden by an older
			// local installation. Keep the persisted target until reconcile so
			// registerTarget can preserve the user's enabled preference; a
			// failed local reconcile removes the stale target.
			requiresSynchronousReconcile = true
			continue
		}

		installation, err := m.loadActive(source.Key)
		if err != nil {
			requiresSynchronousReconcile = true
			if !errors.Is(err, os.ErrNotExist) {
				errs = append(errs, fmt.Errorf("restore active agent extension %s: %w", source.Key, err))
			}
			continue
		}
		if !installationMatchesConfiguredSource(source, installation) {
			requiresSynchronousReconcile = true
			if m.Store != nil {
				if err := m.Store.DeleteAgentTarget(ctx, targetID(source.Key)); err != nil {
					errs = append(errs, fmt.Errorf("remove stale agent extension %s target: %w", source.Key, err))
				}
			}
			continue
		}
		if err := m.registerTarget(ctx, installation); err != nil {
			errs = append(errs, fmt.Errorf("register active agent extension %s: %w", source.Key, err))
		}
	}
	return requiresSynchronousReconcile, errs
}
