package agentextension

import (
	"errors"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

type AccountUsageProfile struct {
	SchemaVersion string `json:"schemaVersion"`
	Runtime       struct {
		Package   string   `json:"package"`
		Kind      string   `json:"kind"`
		Script    string   `json:"script"`
		Args      []string `json:"args"`
		TimeoutMS int      `json:"timeoutMs"`
		// Install optionally declares an installer for the companion package
		// that is independent of the agent runtime installer. It lets an
		// extension whose runtime itself is not npm/pnpm (e.g. a uv-managed
		// Python CLI) still ship a node-script account-usage companion.
		Install *AccountUsageInstallProfile `json:"install,omitempty"`
	} `json:"runtime"`
}

// AccountUsageInstallProfile declares how the account usage companion package
// is installed when the agent runtime's own installer cannot install it.
type AccountUsageInstallProfile struct {
	Runner string   `json:"runner"`
	Args   []string `json:"args"`
}

func loadAccountUsageProfile(installation Installation) (*AccountUsageProfile, error) {
	if installation.Manifest.Profiles.AccountUsage == "" {
		return nil, nil
	}
	var profile AccountUsageProfile
	path := filepath.Join(installation.PackageDir, filepath.FromSlash(installation.Manifest.Profiles.AccountUsage))
	if err := readJSON(path, &profile); err != nil {
		return nil, err
	}
	if err := validateAccountUsageProfile(profile); err != nil {
		return nil, err
	}
	return &profile, nil
}

var accountUsagePackage = regexp.MustCompile(`^@[a-z0-9._-]+/[a-z0-9._-]+@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`)

func validateAccountUsageProfile(profile AccountUsageProfile) error {
	if profile.SchemaVersion != "tutti.agent.account-usage-probe.v1" {
		return errors.New("unsupported account usage profile schema")
	}
	if !accountUsagePackage.MatchString(strings.TrimSpace(profile.Runtime.Package)) {
		return errors.New("account usage companion package must use an exact scoped version")
	}
	if profile.Runtime.Kind != "node-script" {
		return errors.New("account usage companion runtime kind must be node-script")
	}
	script := strings.TrimSpace(profile.Runtime.Script)
	if !strings.HasPrefix(script, "${installRoot}/") || strings.ContainsAny(script, "|;&`\n\r<>") || strings.Contains(script, "$(") {
		return errors.New("account usage companion script must stay under installRoot")
	}
	if matches := runtimeArgumentPlaceholderPattern.FindAllString(script, -1); len(matches) != 1 || matches[0] != "${installRoot}" {
		return errors.New("account usage companion script contains unsupported placeholders")
	}
	if len(profile.Runtime.Args) == 0 || len(profile.Runtime.Args) > 8 {
		return errors.New("account usage companion must declare 1..8 arguments")
	}
	for _, argument := range profile.Runtime.Args {
		if strings.TrimSpace(argument) == "" || utf8.RuneCountInString(argument) > 128 || strings.ContainsAny(argument, "|;&`\n\r<>") || strings.Contains(argument, "$(") || strings.Contains(argument, "$") || strings.ContainsFunc(argument, unicode.IsControl) {
			return errors.New("account usage companion argument is invalid")
		}
	}
	if profile.Runtime.TimeoutMS < 100 || profile.Runtime.TimeoutMS > 30_000 {
		return errors.New("account usage companion timeout must be 100..30000")
	}
	if profile.Runtime.Install != nil {
		if err := validateAccountUsageInstallProfile(profile); err != nil {
			return err
		}
	}
	return nil
}

func validateAccountUsageInstallProfile(profile AccountUsageProfile) error {
	install := profile.Runtime.Install
	runner := strings.TrimSpace(install.Runner)
	if runner != "npm" && runner != "pnpm" {
		return errors.New("account usage companion installer runner must be npm or pnpm")
	}
	if len(install.Args) == 0 || len(install.Args) > 8 {
		return errors.New("account usage companion installer must declare 1..8 arguments")
	}
	declaredPackage := strings.TrimSpace(profile.Runtime.Package)
	packageNamed := false
	for _, argument := range install.Args {
		if argument != strings.TrimSpace(argument) || utf8.RuneCountInString(argument) > 128 ||
			strings.ContainsAny(argument, "|;&`\n\r<>") || strings.Contains(argument, "$(") ||
			strings.ContainsFunc(argument, unicode.IsControl) {
			return errors.New("account usage companion installer argument is invalid")
		}
		if strings.TrimSpace(argument) == declaredPackage {
			packageNamed = true
		}
	}
	if !packageNamed {
		return errors.New("account usage companion installer must name the companion package")
	}
	for _, argument := range install.Args {
		placeholderFree := strings.NewReplacer("${installRoot}", "", "${platform}", "").Replace(argument)
		if strings.Contains(placeholderFree, "$") {
			return errors.New("account usage companion installer argument contains unsupported placeholders")
		}
	}
	return nil
}

// accountUsageEffectiveRunner resolves the installer used for the account
// usage companion: the profile-declared installer when present, otherwise the
// agent runtime's own installer.
func accountUsageEffectiveRunner(runtimeRunner string, profile *AccountUsageProfile) string {
	if profile != nil && profile.Runtime.Install != nil && strings.TrimSpace(profile.Runtime.Install.Runner) != "" {
		return strings.TrimSpace(profile.Runtime.Install.Runner)
	}
	return runtimeRunner
}
