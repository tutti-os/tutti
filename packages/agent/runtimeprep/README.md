# Agent Runtime Preparation

`packages/agent/runtimeprep` is the reusable, provider-local preparation layer
for Tutti agent sessions. A host calls it on the same machine where the agent
provider will run. That machine is the desktop host for tutti and the managed
Linux VM for VM-backed products such as tsh.

The module owns the canonical system-prompt and skill content, capability-pack
resolution, provider home/plugin materialization, per-session environment
overlays, manifests, and cleanup. Hosts keep transport, workspace path
projection, environment trust filtering, account bootstrap, and deployment
capability selection.

## Host Wiring

```go
preparer := runtimeprep.NewDefaultPreparer(stateDir)
preparer.Profile = runtimeprep.StandardProfile()
preparer.CommandCatalog = commandCatalogAdapter
preparer.ComputerUseAvailable = computerReadinessCheck
preparer.SkillSources = []runtimeprep.SkillSource{pluginSkillSource}

prepared, err := preparer.Prepare(ctx, runtimeprep.PrepareInput{
    WorkspaceID:    workspaceID,
    AgentSessionID: sessionID,
    Provider:       "claude-code",
    Cwd:            cwd,
    BrowserUse:     true,
    ExtraSkills:    sessionSkills,
})
```

`PreparedRuntime.Env` is an overlay for the provider launch, not a complete
process environment. `Cleanup` removes only paths recorded in the session
manifest or the session-scoped runtime root.

Codex preparation keeps session state isolated under the run-scoped
`CODEX_HOME`, while linking its writable `models_cache.json` to the provider
user's process-default `~/.codex/models_cache.json`. The link may initially be
dangling: the first Codex refresh creates the shared VM- or host-local cache,
and later sessions reuse it. Hosts must therefore run preparation with `HOME`
set to the provider user's stable local Home, never a session runtime directory
or a remote filesystem projection.

## Capability Packs

A deployment capability resolves once into its policy, skills, and environment
contribution:

```go
runtimeprep.CapabilityPack{
    Name: "example",
    Resolve: func(ctx context.Context, input runtimeprep.PrepareInput) (
        runtimeprep.CapabilityContribution,
        error,
    ) {
        return runtimeprep.CapabilityContribution{
            Enabled: true,
            Skills: []runtimeprep.SkillSpec{{
                ID: "example/tool",
                Name: "example-tool",
                Files: map[string]string{"SKILL.md": "# Example\n"},
            }},
            PolicySections: []runtimeprep.PolicySection{{
                Anchor: runtimeprep.PolicyAnchorTools,
                Key: "usage",
                Body: "Use `$example-tool` for example work.",
            }},
            EnvOverlay: []string{"EXAMPLE_ENABLED=1"},
        }, nil
    },
}
```

Policy sections sort by anchor, order, and pack-qualified key. Duplicate pack
names, unknown anchors, duplicate skill IDs, and unsafe skill file paths fail
resolution rather than silently overriding content. Sections apply to both
provider runtime policy and dynamic skill bundles by default; set
`PolicySection.Delivery` when a section is valid for only one delivery path.

`StandardProfile` includes `CoreSkillsPack`, `TuttiDesktopHostPack`, browser
use, and computer use. A non-desktop deployment should compose its own profile
from `CoreSkillsPack` and deployment-owned packs instead of copying the
desktop-host policy:

```go
profile := runtimeprep.DeploymentProfile{
    Name:  "managed-vm",
    Title: "Managed VM Runtime",
    Intro: "This session runs inside the managed VM.",
    Packs: []runtimeprep.CapabilityPack{
        runtimeprep.CoreSkillsPack(),
        vmEnvironmentPack,
    },
}
```

## Skill Injection

Skills resolve in this order:

1. skills from the deployment profile's enabled capability packs;
2. host `SkillSource` results;
3. per-session `PrepareInput.ExtraSkills`.

Skill IDs are stable logical identities. Materialized directory slugs may gain
a suffix to avoid overwriting an existing user skill. If an injected ability
also needs policy or environment changes, inject a capability pack instead of
an isolated extra skill.

`Prepare` and `RenderSkillBundle` use the same resolver, so provider files and
the skill-bundle API cannot drift.

## Product Boundaries

The module must not import `services/tuttid/*`. Product adapters translate
their command catalog and readiness types into the narrow interfaces here.
Tutti account token issue/revoke remains in `services/tuttid/service/tuttiagent`;
only the provider home/config preparation is shared.

Provider-specific runtime protocol and session control belong to
`packages/agent/daemon`, not this module.
