package tuttimodeplan

import (
	"errors"
	"fmt"
	"io"
	"strings"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	"gopkg.in/yaml.v3"
)

const (
	SchemaV1            = "tutti-mode-plan/v1"
	maxPlanMarkdownSize = 1 << 20
)

type PlanPhase string

const (
	PhaseConfiguration PlanPhase = "configuration"
	PhaseTaskGraph     PlanPhase = "task_graph"
)

var (
	ErrInvalidPlanMarkdown    = errors.New("invalid Tutti Mode Plan markdown")
	ErrUnsupportedPlanSchema  = errors.New("unsupported Tutti Mode Plan schema")
	ErrInvalidTaskGraph       = errors.New("invalid Tutti Mode Plan task graph")
	ErrRevisionDigestMismatch = errors.New("tutti mode plan revision metadata does not match immutable content")
)

type PlanDocument struct {
	Schema    string        `yaml:"schema"`
	Phase     PlanPhase     `yaml:"phase"`
	Title     string        `yaml:"title"`
	TopicID   string        `yaml:"topicId"`
	Execution PlanExecution `yaml:"execution"`
	Budget    PlanBudget    `yaml:"budget"`
	Tasks     []PlanTask    `yaml:"tasks"`
	Body      string        `yaml:"-"`
}

type PlanExecution struct {
	Mode                   string `yaml:"mode"`
	ReasoningIntensity     int    `yaml:"reasoningIntensity"`
	OrchestrationIntensity int    `yaml:"orchestrationIntensity"`
}

type PlanBudget struct {
	Mode                  string  `yaml:"mode"`
	TokenLimit            int64   `yaml:"tokenLimit"`
	QuotaWaterlinePercent float64 `yaml:"quotaWaterlinePercent"`
}

type PlanTask struct {
	ID                 string   `yaml:"id"`
	Title              string   `yaml:"title"`
	Content            string   `yaml:"content"`
	Priority           string   `yaml:"priority"`
	AgentTargetID      string   `yaml:"agentTargetId"`
	ModelPlanID        string   `yaml:"modelPlanId"`
	Model              string   `yaml:"model"`
	PermissionModeID   string   `yaml:"permissionModeId"`
	ReasoningEffort    string   `yaml:"reasoningEffort"`
	ExecutionDirectory string   `yaml:"executionDirectory"`
	DependsOn          []string `yaml:"dependsOn"`
	// Parallelizable opts one task out of the sequential default: the agent
	// may propose it, the reviewer may override it, and it persists onto the
	// materialized Issue task. Omitted means false (strictly sequential).
	Parallelizable bool `yaml:"parallelizable"`
	// AutoAccept lets the planning agent mark a task whose completed result
	// needs no human review gate: on successful completion the daemon accepts
	// it automatically and dispatch advances. Omitted means false (the user
	// accepts each task by hand).
	AutoAccept bool `yaml:"autoAccept"`
}

func ParsePlanMarkdown(raw []byte) (PlanDocument, error) {
	if len(raw) == 0 || len(raw) > maxPlanMarkdownSize {
		return PlanDocument{}, fmt.Errorf("%w: document size must be between 1 byte and %d bytes", ErrInvalidPlanMarkdown, maxPlanMarkdownSize)
	}

	normalized := strings.ReplaceAll(string(raw), "\r\n", "\n")
	if !strings.HasPrefix(normalized, "---\n") {
		return PlanDocument{}, fmt.Errorf("%w: YAML frontmatter is required", ErrInvalidPlanMarkdown)
	}
	remainder := normalized[len("---\n"):]
	closing := strings.Index(remainder, "\n---\n")
	if closing < 0 {
		return PlanDocument{}, fmt.Errorf("%w: YAML frontmatter is not closed", ErrInvalidPlanMarkdown)
	}

	profile := workspaceissues.DefaultExecutionProfile()
	budget := workspaceissues.DefaultBudget()
	document := PlanDocument{
		Execution: PlanExecution{
			Mode:                   "sequential",
			ReasoningIntensity:     profile.ReasoningIntensity,
			OrchestrationIntensity: profile.OrchestrationIntensity,
		},
		Budget: PlanBudget{
			Mode:                  string(budget.Mode),
			TokenLimit:            budget.TokenLimit,
			QuotaWaterlinePercent: budget.QuotaWaterlinePercent,
		},
	}
	decoder := yaml.NewDecoder(strings.NewReader(remainder[:closing]))
	decoder.KnownFields(true)
	if err := decoder.Decode(&document); err != nil {
		return PlanDocument{}, fmt.Errorf("%w: decode frontmatter: %v", ErrInvalidPlanMarkdown, err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != nil && !errors.Is(err, io.EOF) {
		return PlanDocument{}, fmt.Errorf("%w: decode frontmatter: %v", ErrInvalidPlanMarkdown, err)
	} else if err == nil {
		return PlanDocument{}, fmt.Errorf("%w: frontmatter must contain one document", ErrInvalidPlanMarkdown)
	}
	document.Body = remainder[closing+len("\n---\n"):]
	if err := normalizeAndValidatePlanDocument(&document); err != nil {
		return PlanDocument{}, err
	}
	return document, nil
}

func normalizeAndValidatePlanDocument(document *PlanDocument) error {
	document.Schema = strings.TrimSpace(document.Schema)
	if document.Schema != SchemaV1 {
		return fmt.Errorf("%w: %q", ErrUnsupportedPlanSchema, document.Schema)
	}
	document.Title = strings.TrimSpace(document.Title)
	document.TopicID = strings.TrimSpace(document.TopicID)
	document.Phase = PlanPhase(strings.ToLower(strings.TrimSpace(string(document.Phase))))
	if document.Phase == "" {
		// The single-review flow submits one complete plan-plus-task-graph
		// document; phase is retained for legacy revision files only.
		document.Phase = PhaseTaskGraph
	}
	document.Execution.Mode = strings.ToLower(strings.TrimSpace(document.Execution.Mode))
	document.Budget.Mode = strings.ToLower(strings.TrimSpace(document.Budget.Mode))
	if document.Title == "" || document.TopicID == "" || strings.TrimSpace(document.Body) == "" {
		return fmt.Errorf("%w: title, topicId, and body are required", ErrInvalidPlanMarkdown)
	}
	switch document.Phase {
	case PhaseConfiguration:
		if len(document.Tasks) != 0 {
			return fmt.Errorf("%w: configuration revisions cannot include tasks", ErrInvalidPlanMarkdown)
		}
	case PhaseTaskGraph:
		if len(document.Tasks) == 0 {
			return fmt.Errorf("%w: the plan document requires at least one task in tasks", ErrInvalidTaskGraph)
		}
	default:
		return fmt.Errorf("%w: phase must be configuration or task_graph", ErrInvalidPlanMarkdown)
	}
	if document.Execution.Mode != "sequential" && document.Execution.Mode != "parallel" {
		return fmt.Errorf("%w: execution mode must be sequential or parallel", ErrInvalidPlanMarkdown)
	}
	if _, ok := workspaceissues.NormalizeExecutionProfile(workspaceissues.ExecutionProfile{
		ReasoningIntensity:     document.Execution.ReasoningIntensity,
		OrchestrationIntensity: document.Execution.OrchestrationIntensity,
	}); !ok {
		return fmt.Errorf("%w: execution intensities must be between 0 and 100", ErrInvalidPlanMarkdown)
	}
	if _, ok := workspaceissues.NormalizeBudget(workspaceissues.Budget{
		Mode:                  workspaceissues.BudgetMode(document.Budget.Mode),
		TokenLimit:            document.Budget.TokenLimit,
		QuotaWaterlinePercent: document.Budget.QuotaWaterlinePercent,
	}); !ok {
		return fmt.Errorf("%w: budget is invalid", ErrInvalidPlanMarkdown)
	}

	graph := make([]workspaceissues.Task, 0, len(document.Tasks))
	seen := make(map[string]struct{}, len(document.Tasks))
	for index := range document.Tasks {
		task := &document.Tasks[index]
		task.ID = strings.TrimSpace(task.ID)
		task.Title = strings.TrimSpace(task.Title)
		task.Content = strings.TrimSpace(task.Content)
		task.AgentTargetID = strings.TrimSpace(task.AgentTargetID)
		task.ModelPlanID = strings.TrimSpace(task.ModelPlanID)
		task.Model = strings.TrimSpace(task.Model)
		task.PermissionModeID = strings.TrimSpace(task.PermissionModeID)
		task.ReasoningEffort = strings.TrimSpace(task.ReasoningEffort)
		task.ExecutionDirectory = strings.TrimSpace(task.ExecutionDirectory)
		if task.ID == "" || task.Title == "" {
			return fmt.Errorf("%w: every task requires id and title", ErrInvalidTaskGraph)
		}
		if _, exists := seen[task.ID]; exists {
			return fmt.Errorf("%w: duplicate task id %q", ErrInvalidTaskGraph, task.ID)
		}
		seen[task.ID] = struct{}{}
		if task.Priority == "" {
			task.Priority = string(workspaceissues.PriorityMedium)
		} else {
			normalizedPriority := workspaceissues.NormalizePriority(task.Priority)
			if string(normalizedPriority) != strings.ToLower(strings.TrimSpace(task.Priority)) {
				return fmt.Errorf("%w: task %q has invalid priority", ErrInvalidTaskGraph, task.ID)
			}
			task.Priority = string(normalizedPriority)
		}
		task.DependsOn = workspaceissues.NormalizeDependencyTaskIDs(task.DependsOn)
		graph = append(graph, workspaceissues.Task{TaskID: task.ID, DependencyTaskIDs: task.DependsOn})
	}
	if !workspaceissues.ValidateTaskDependencyGraph(graph) {
		return ErrInvalidTaskGraph
	}
	return nil
}
