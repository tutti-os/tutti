package tuttimodeplan

import (
	"errors"
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
