package agenthost

import (
	"os"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestModuleHasNoApplicationOrTransportDependency(t *testing.T) {
	t.Parallel()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve host package path")
	}
	moduleFile := strings.TrimSuffix(filename, "contracts_test.go") + "go.mod"
	content, err := os.ReadFile(moduleFile)
	if err != nil {
		t.Fatalf("read host go.mod: %v", err)
	}
	for _, forbidden := range []string{
		"/services/",
		"/apps/",
		"controlplane",
	} {
		if strings.Contains(string(content), forbidden) {
			t.Fatalf("host go.mod contains forbidden dependency %q", forbidden)
		}
	}
}

func TestPublicCommandTypesContainNoAdapterIdentityOrTransportFields(t *testing.T) {
	t.Parallel()
	types := []reflect.Type{
		reflect.TypeOf(SessionRef{}),
		reflect.TypeOf(CreateSessionInput{}),
		reflect.TypeOf(SendInput{}),
		reflect.TypeOf(SubmitInteractiveInput{}),
		reflect.TypeOf(SubmitPlanDecisionInput{}),
		reflect.TypeOf(CancelTurnInput{}),
		reflect.TypeOf(UpdateTitleInput{}),
		reflect.TypeOf(UpdateSettingsInput{}),
		reflect.TypeOf(UpdatePinInput{}),
		reflect.TypeOf(GoalControlInput{}),
		reflect.TypeOf(GoalReconcileRequiredInput{}),
		reflect.TypeOf(RuntimeGoalControlInput{}),
		reflect.TypeOf(RuntimePreparationInput{}),
	}
	forbidden := []string{
		"RoomID",
		"DeviceID",
		"SessionCookie",
		"VM",
		"E2B",
		"HTTP",
		"Electron",
		"Controlplane",
	}
	for _, typ := range types {
		for fieldIndex := 0; fieldIndex < typ.NumField(); fieldIndex++ {
			fieldName := typ.Field(fieldIndex).Name
			for _, term := range forbidden {
				if strings.Contains(fieldName, term) {
					t.Fatalf("%s.%s contains adapter concern %q", typ.Name(), fieldName, term)
				}
			}
		}
	}
}
