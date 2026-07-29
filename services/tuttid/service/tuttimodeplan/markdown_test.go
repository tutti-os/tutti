package tuttimodeplan

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

const validPlanMarkdown = `---
schema: tutti-mode-plan/v1
phase: task_graph
title: Ship Tutti Mode Plan
topicId: default
execution:
  mode: sequential
  effect: 85
  speed: 65
  reasoningIntensity: 80
  orchestrationIntensity: 70
budget:
  mode: fixed
  tokenLimit: 64000
  quotaWaterlinePercent: 20
tasks:
  - id: design
    title: Confirm the workflow seam
    content: Keep Tutti workflow state outside AgentInteraction.
    priority: high
  - id: implement
    title: Implement the workflow
    content: Persist the accepted proposal as an Issue.
    priority: medium
    dependsOn: [design]
---
# Proposal

Tutti owns this proposal and the agent only triggered it through the CLI.
`

func TestParsePlanMarkdownReturnsStrictVersionedDocument(t *testing.T) {
	document, err := ParsePlanMarkdown([]byte(validPlanMarkdown))
	if err != nil {
		t.Fatalf("ParsePlanMarkdown() error = %v", err)
	}
	if document.Schema != SchemaV1 {
		t.Fatalf("Schema = %q, want %q", document.Schema, SchemaV1)
	}
	if document.Phase != PhaseTaskGraph {
		t.Fatalf("Phase = %q, want %q", document.Phase, PhaseTaskGraph)
	}
	if document.Title != "Ship Tutti Mode Plan" || document.TopicID != "default" {
		t.Fatalf("document identity = %#v", document)
	}
	if document.Body != "# Proposal\n\nTutti owns this proposal and the agent only triggered it through the CLI.\n" {
		t.Fatalf("Body = %q", document.Body)
	}
	if len(document.Tasks) != 2 || document.Tasks[1].DependsOn[0] != "design" {
		t.Fatalf("Tasks = %#v", document.Tasks)
	}
	if document.Execution.Mode != "sequential" || document.Budget.TokenLimit != 64_000 {
		t.Fatalf("execution/budget = %#v / %#v", document.Execution, document.Budget)
	}
	if document.Execution.Effect == nil || *document.Execution.Effect != 85 ||
		document.Execution.Speed == nil || *document.Execution.Speed != 65 {
		t.Fatalf("execution preferences = %#v", document.Execution)
	}
}

func TestParsePlanMarkdownAllowsConfigurationRevisionWithoutTasks(t *testing.T) {
	document, err := ParsePlanMarkdown([]byte(`---
schema: tutti-mode-plan/v1
phase: configuration
title: Configure the workflow
topicId: default
execution:
  mode: parallel
budget:
  mode: auto
---
# Proposal

Confirm the execution and budget configuration before task decomposition.
`))
	if err != nil {
		t.Fatalf("ParsePlanMarkdown() error = %v", err)
	}
	if document.Phase != PhaseConfiguration || len(document.Tasks) != 0 {
		t.Fatalf("configuration document = %#v", document)
	}
}

func TestParsePlanMarkdownRejectsUnknownFields(t *testing.T) {
	_, err := ParsePlanMarkdown([]byte(`---
schema: tutti-mode-plan/v1
phase: task_graph
title: Invalid
topicId: default
unexpected: true
tasks:
  - id: task
    title: Task
---
Body
`))
	if !errors.Is(err, ErrInvalidPlanMarkdown) {
		t.Fatalf("error = %v, want ErrInvalidPlanMarkdown", err)
	}
}

func TestParsePlanMarkdownRejectsUnknownSchema(t *testing.T) {
	_, err := ParsePlanMarkdown([]byte(`---
schema: tutti-mode-plan/v2
phase: task_graph
title: Invalid
topicId: default
tasks:
  - id: task
    title: Task
---
Body
`))
	if !errors.Is(err, ErrUnsupportedPlanSchema) {
		t.Fatalf("error = %v, want ErrUnsupportedPlanSchema", err)
	}
}

func TestParsePlanMarkdownRejectsCyclicTaskGraph(t *testing.T) {
	_, err := ParsePlanMarkdown([]byte(`---
schema: tutti-mode-plan/v1
phase: task_graph
title: Invalid
topicId: default
tasks:
  - id: first
    title: First
    dependsOn: [second]
  - id: second
    title: Second
    dependsOn: [first]
---
Body
`))
	if !errors.Is(err, ErrInvalidTaskGraph) {
		t.Fatalf("error = %v, want ErrInvalidTaskGraph", err)
	}
}

func TestParsePlanMarkdownRejectsNonFiniteQuotaWaterline(t *testing.T) {
	t.Parallel()

	for _, value := range []string{".nan", ".inf", "-.inf"} {
		value := value
		t.Run(value, func(t *testing.T) {
			t.Parallel()
			raw := strings.Replace(validPlanMarkdown, "quotaWaterlinePercent: 20", "quotaWaterlinePercent: "+value, 1)
			if _, err := ParsePlanMarkdown([]byte(raw)); !errors.Is(err, ErrInvalidPlanMarkdown) {
				t.Fatalf("ParsePlanMarkdown(%q) error = %v, want ErrInvalidPlanMarkdown", value, err)
			}
		})
	}
}

func TestParsePlanMarkdownDefaultsOmittedPhaseToTaskGraph(t *testing.T) {
	document, err := ParsePlanMarkdown([]byte(`---
schema: tutti-mode-plan/v1
title: Single review plan
topicId: default
tasks:
  - id: only
    title: Do the work
---
Narrative body.
`))
	if err != nil {
		t.Fatalf("ParsePlanMarkdown() error = %v", err)
	}
	if document.Phase != PhaseTaskGraph {
		t.Fatalf("Phase = %q, want %q", document.Phase, PhaseTaskGraph)
	}
}

func TestParsePlanMarkdownRequiresTasksWhenPhaseOmitted(t *testing.T) {
	_, err := ParsePlanMarkdown([]byte(`---
schema: tutti-mode-plan/v1
title: Single review plan
topicId: default
---
Narrative body without tasks.
`))
	if !errors.Is(err, ErrInvalidTaskGraph) {
		t.Fatalf("ParsePlanMarkdown() error = %v, want ErrInvalidTaskGraph", err)
	}
}

func TestParsePlanMarkdownParsesTaskLaunchOverrides(t *testing.T) {
	document, err := ParsePlanMarkdown([]byte(`---
schema: tutti-mode-plan/v1
title: Launch override plan
topicId: default
tasks:
  - id: only
    title: Do the work
    permissionModeId: " acceptEdits "
    reasoningEffort: " high "
---
Narrative body.
`))
	if err != nil {
		t.Fatalf("ParsePlanMarkdown() error = %v", err)
	}
	if document.Tasks[0].PermissionModeID != "acceptEdits" || document.Tasks[0].ReasoningEffort != "high" {
		t.Fatalf("task overrides = %#v", document.Tasks[0])
	}
}

func TestParsePlanMarkdownDefaultsGoalReviewToSelf(t *testing.T) {
	document, err := ParsePlanMarkdown([]byte(`---
schema: tutti-mode-plan/v1
title: Self review plan
topicId: default
tasks:
  - id: only
    title: Do the work
---
Narrative body.
`))
	if err != nil {
		t.Fatalf("ParsePlanMarkdown() error = %v", err)
	}
	review := reflect.ValueOf(document).FieldByName("Review")
	if !review.IsValid() {
		t.Fatal("PlanDocument.Review is missing")
	}
	if mode := review.FieldByName("Mode"); !mode.IsValid() || mode.String() != "self" {
		t.Fatalf("Review.Mode = %#v, want self", mode)
	}
	if target := review.FieldByName("AgentTargetID"); !target.IsValid() || target.String() != "" {
		t.Fatalf("Review.AgentTargetID = %#v, want empty", target)
	}
}

func TestParsePlanMarkdownValidatesIndependentGoalReviewTarget(t *testing.T) {
	valid := `---
schema: tutti-mode-plan/v1
title: Independent review plan
topicId: default
review:
  mode: " independent "
  agentTargetId: " reviewer-agent "
tasks:
  - id: only
    title: Do the work
---
Narrative body.
`
	document, err := ParsePlanMarkdown([]byte(valid))
	if err != nil {
		t.Fatalf("ParsePlanMarkdown(independent) error = %v", err)
	}
	review := reflect.ValueOf(document).FieldByName("Review")
	if !review.IsValid() ||
		review.FieldByName("Mode").String() != "independent" ||
		review.FieldByName("AgentTargetID").String() != "reviewer-agent" {
		t.Fatalf("independent Review = %#v", review)
	}

	_, err = ParsePlanMarkdown([]byte(strings.Replace(
		valid,
		"  agentTargetId: \" reviewer-agent \"\n",
		"",
		1,
	)))
	if !errors.Is(err, ErrInvalidPlanMarkdown) {
		t.Fatalf("independent review without target error = %v, want ErrInvalidPlanMarkdown", err)
	}

	for name, replacement := range map[string]string{
		"blank independent target": "  mode: independent\n  agentTargetId: \"   \"\n",
		"invalid mode":             "  mode: committee\n  agentTargetId: reviewer-agent\n",
	} {
		t.Run(name, func(t *testing.T) {
			candidate := strings.Replace(
				valid,
				"  mode: \" independent \"\n  agentTargetId: \" reviewer-agent \"\n",
				replacement,
				1,
			)
			if _, err := ParsePlanMarkdown([]byte(candidate)); !errors.Is(err, ErrInvalidPlanMarkdown) {
				t.Fatalf("ParsePlanMarkdown() error = %v, want ErrInvalidPlanMarkdown", err)
			}
		})
	}

	selfWithTarget := strings.Replace(
		valid,
		"  mode: \" independent \"\n  agentTargetId: \" reviewer-agent \"\n",
		"  mode: self\n  agentTargetId: reviewer-agent\n",
		1,
	)
	if _, err := ParsePlanMarkdown([]byte(selfWithTarget)); !errors.Is(err, ErrInvalidPlanMarkdown) {
		t.Fatalf("self review with target error = %v, want ErrInvalidPlanMarkdown", err)
	}
}
