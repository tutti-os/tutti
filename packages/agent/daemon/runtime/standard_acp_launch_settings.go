package agentruntime

import (
	"errors"
	"regexp"
	"strings"
)

const standardACPPermissionLaunchPlaceholder = "${permissionMode}"

var standardACPLaunchSettingValuePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
var standardACPLaunchPlaceholderPattern = regexp.MustCompile(`\$\{[^}]+\}`)

// StandardACPLaunchPermissionSetting is the closed declaration used by Agent
// Extensions whose permission tier is fixed when the ACP process is spawned.
// The placeholder replaces one complete argv element; it is never evaluated by
// a shell and cannot be combined with arbitrary template text.
type StandardACPLaunchPermissionSetting struct {
	Placeholder     string
	DefaultSemantic string
	Values          map[string]string
}

func validateStandardACPLaunchPermissionSetting(
	command []string,
	input *StandardACPLaunchPermissionSetting,
) (*StandardACPLaunchPermissionSetting, error) {
	placeholderCount := 0
	for _, argument := range command {
		for _, placeholder := range standardACPLaunchPlaceholderPattern.FindAllString(argument, -1) {
			if input == nil || placeholder != standardACPPermissionLaunchPlaceholder || argument != placeholder {
				return nil, errors.New("standard ACP command contains unsupported launch placeholder")
			}
			placeholderCount++
		}
	}
	if input == nil {
		return nil, nil
	}
	if strings.TrimSpace(input.Placeholder) != standardACPPermissionLaunchPlaceholder || placeholderCount != 1 {
		return nil, errors.New("standard ACP launch permission placeholder is invalid")
	}
	defaultSemantic := strings.TrimSpace(input.DefaultSemantic)
	if defaultSemantic == "" {
		defaultSemantic = "ask-before-write"
	}
	if defaultSemantic != "ask-before-write" {
		return nil, errors.New("standard ACP launch permission default semantic is invalid")
	}
	wanted := map[string]struct{}{
		"ask-before-write": {},
		"auto":             {},
		"full-access":      {},
	}
	values := make(map[string]string, len(input.Values))
	seenRuntime := map[string]struct{}{}
	for semantic, runtimeValue := range input.Values {
		semantic = strings.TrimSpace(semantic)
		runtimeValue = strings.TrimSpace(runtimeValue)
		if _, ok := wanted[semantic]; !ok || !standardACPLaunchSettingValuePattern.MatchString(runtimeValue) {
			return nil, errors.New("standard ACP launch permission mapping is invalid")
		}
		if _, exists := seenRuntime[runtimeValue]; exists {
			return nil, errors.New("standard ACP launch permission mapping is ambiguous")
		}
		values[semantic] = runtimeValue
		seenRuntime[runtimeValue] = struct{}{}
		delete(wanted, semantic)
	}
	if len(wanted) != 0 {
		return nil, errors.New("standard ACP launch permission mapping is incomplete")
	}
	return &StandardACPLaunchPermissionSetting{
		Placeholder:     standardACPPermissionLaunchPlaceholder,
		DefaultSemantic: defaultSemantic,
		Values:          values,
	}, nil
}

func applyStandardACPLaunchPermission(
	command []string,
	setting *StandardACPLaunchPermissionSetting,
	semantic string,
) ([]string, error) {
	if setting == nil {
		return command, nil
	}
	semantic = strings.TrimSpace(semantic)
	if semantic == "" {
		semantic = setting.DefaultSemantic
	}
	runtimeValue, ok := setting.Values[semantic]
	if !ok || runtimeValue == "" {
		return nil, errors.New("standard ACP launch permission semantic is not declared")
	}
	result := append([]string(nil), command...)
	for index, argument := range result {
		if argument == setting.Placeholder {
			result[index] = runtimeValue
			return result, nil
		}
	}
	return nil, errors.New("validated standard ACP launch permission placeholder is missing")
}

func applyStandardACPLaunchPermissionValue(
	command []string,
	setting *StandardACPLaunchPermissionSetting,
	runtimeValue string,
) ([]string, error) {
	if setting == nil {
		return nil, errors.New("standard ACP launch permission setting is missing")
	}
	runtimeValue = strings.TrimSpace(runtimeValue)
	if !standardACPLaunchSettingValuePattern.MatchString(runtimeValue) {
		return nil, errors.New("standard ACP launch permission runtime value is invalid")
	}
	result := append([]string(nil), command...)
	for index, argument := range result {
		if argument == setting.Placeholder {
			result[index] = runtimeValue
			return result, nil
		}
	}
	return nil, errors.New("validated standard ACP launch permission placeholder is missing")
}

func (a *standardACPAdapter) startupModeID(session Session) string {
	if a == nil {
		return ""
	}
	if a.config.launchPermission != nil && (a.config.planModeUsesLaunchPermission || !session.SettingsValue().PlanMode) {
		return ""
	}
	return a.effectiveModeID(session)
}
