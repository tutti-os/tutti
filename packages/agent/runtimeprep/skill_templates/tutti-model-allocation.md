---
name: tutti-model-allocation
description: Allocate Tutti plan tasks to current Agent targets and models using independent effect and speed preferences, C0-C3 capability tiers, a 1-4 parallel target, hard capability constraints, and effect-scaled verification. Use when creating or revising a Tutti Mode task graph, choosing each task's agentTargetId/model/reasoningEffort, or auditing whether assignments satisfy the requested effect and speed.
---

# Tutti Model Allocation

Choose from current runtime evidence, not from memory. This skill supplies the
selection policy; `agent list` and `agent composer-options` supply the exact
launch ids and current model catalog.

## Workflow

### 1. Read preferences

- Let `effect` set the minimum outcome-quality tier and verification breadth.
- Let `speed` choose among models that satisfy that tier and set the parallel
  target.
- Keep them independent. Never average them.

### 2. Derive the parallel target

| Speed  | Parallel target |
| ------ | --------------- |
| 0-24   | 1               |
| 25-49  | 2               |
| 50-74  | 3               |
| 75-100 | 4               |

Treat this as an upper planning target, not a promise. Shape real independent
workstreams so up to that many tasks can be ready together, but never invent
tasks to fill the target. Dependencies, ownership boundaries, safe isolation,
budget, ready work, and workspace capacity always win. Schedule no more than
the target at one checkpoint.

### 3. Build the joint candidate matrix

Run `agent list` once. Shortlist every launchable target whose description and
advertised capabilities could plausibly fit any plan task, including
non-current targets. Run `agent composer-options` for every shortlisted target.

Compare joint `(agentTargetId, model, reasoningEffort, permissionModeId)`
candidates. Do not select an Agent first and then limit model choice to that
Agent. Do not skip a plausible non-current target merely to avoid another
composer-options call.

### 4. Apply hard constraints

- Honor an explicit user model, model plan, or target.
- Require advertised image/tool/context capabilities needed by the task.
- Use only exact `agentTargetId`, `model`, and `permissionModeId` values returned
  by the current commands.
- Ignore a requested-origin model entry as proof of provider support.

### 5. Remove affinity bias

- The planning/source Agent, its provider, its current model, and provider
  defaults receive no suitability bonus.
- Require both Agent fit and model fit. A strong model cannot compensate for a
  target whose description, instructions, or call conditions conflict with the
  task; a familiar Agent cannot compensate for a model below the required tier.
- Rank the joint candidates from task evidence even when another Agent exposes
  a better model than the planner's own target.
- The planning Agent may still win when its candidate is objectively the best
  fit or the user selected it explicitly. Record the task-fit reason; familiarity
  with the current Agent is not a reason.
- When candidates are equivalently qualified for safely independent work,
  prefer a non-planning target so the planning Agent remains available for
  coordination and final integration. Never apply this tie-breaker against a
  stronger or safer model.

### 6. Classify the task

| Tier | Task shape                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------- |
| C0   | Bounded extraction, formatting, short rewrite, simple lookup, or low-risk mechanical edit                      |
| C1   | Normal single-area implementation, routine debugging, ordinary analysis, or focused test work                  |
| C2   | Multi-step implementation, cross-module change, difficult debugging, integration, or substantial review        |
| C3   | Architecture, high-stakes or ambiguous work, hard recovery, deep review, or final synthesis across workstreams |

### 7. Derive the effect floor

| Effect | Model floor | Verification floor                                                     |
| ------ | ----------- | ---------------------------------------------------------------------- |
| 0-19   | C0          | One focused check or explicit inspection                               |
| 20-59  | C1          | Relevant targeted tests/checks                                         |
| 60-84  | C2          | Relevant tests plus integration and edge coverage when applicable      |
| 85-100 | C3          | Broad relevant tests, edge/variant coverage, and explicit final review |

The required tier is `max(task tier, effect floor)`. A low effect never makes an
intrinsically difficult or high-risk task safe for a weak model.

### 8. Rank eligible models

| Speed  | Choice within the eligible set                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------- |
| 0-24   | Prefer the strongest stable model and useful capability headroom                                              |
| 25-59  | Prefer the balanced/default suitable model                                                                    |
| 60-84  | Prefer the lowest-latency model that clearly satisfies the tier                                               |
| 85-100 | Prefer the fastest qualified model or fast service variant; never reduce the tier or effect-derived reasoning |

Rank only models at or above the required tier. Apply task-shape fit before
speed: a specialist C3 route is not automatically suitable for every C3 task.

### 9. Encode the assignment

Write the exact assignment and concrete effect-scaled validation in every task
brief. Use per-task `reasoningEffort` only when the task needs to differ from
the plan's effect-derived reasoning intensity.

## Model Evidence

Read `references/model-tiers.md` when exact model families must be classified.
Treat that file as a routing prior, not an availability catalog:

- exact current `composer-options` output always wins for availability and ids;
- provider descriptions and advertised capabilities win over family-name
  inference;
- a `-fast` or service-speed variant keeps its base model's capability tier
  unless current provider evidence says otherwise;
- when one model spans several tiers, reasoning effort distinguishes the tiers;
- if classification confidence is low, fall back to the provider default only
  for C0/C1 work. For C2/C3, choose a clearly stronger described model or a
  different target with a known ladder, and record the assumption.

## Review

Before proposing the plan, verify:

- every plausible target was considered jointly with its models, and at least
  one non-current target was compared when one was available;
- no assignment received a bonus for matching the planning Agent, current
  provider, current model, or a provider default;
- every task clears its inherent tier and the effect floor;
- speed changed the choice only within the qualified set;
- the graph exposes real safe concurrency toward the parallel target without
  fabricating work, and no scheduled set exceeds it;
- all launch values came from current command output;
- image and other hard capability requirements are satisfied;
- verification text is observable and proportional to effect;
- final integration/review tasks are not assigned below the strongest work
  they must judge.
