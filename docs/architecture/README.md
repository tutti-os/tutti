# Architecture

These documents describe the current implemented structure, ownership, and
data flow of the repository. They are the first stop for understanding how a
subsystem works now.

Proposals and implementation plans live in [Specs and Plans](../specs/README.md).
Stable change rules live in [Conventions](../conventions/README.md).

## Repository And Platform

- [Project Structure](./project-structure.md)
- [Business Event Stream](./business-event-stream.md)
- [Analytics Tracking](./analytics-tracking.md)
- [Browser Node Package](./browser-node-package.md)

## Agent System

- [Agent Account And Commerce](./agent-account-and-commerce.md)
- [Agent Activity Packages](./agent-activity-packages.md)
- [Agent Extensions](./agent-extensions.md)
- [Agent Reference Sources](./agent-reference-sources.md)
- [Agent Runtime Preparation](./agent-runtime-preparation.md)
- [Agent GUI Node](./agent-gui-node.md)
- [Agent Reference Mention Resolution](./agent-reference-mention-resolution.md)
- [Tutti Agent Readiness Bootstrap](./tutti-agent-readiness-bootstrap.md)
- [Agent Provider CLI Updates](./agent-provider-cli-updates.md)
- [Model Access Plans](./model-access-plans.md)

## Desktop And Transport

- [Desktop Backend Access](./desktop-backend-access.md)
- [Desktop Transport](./desktop-transport.md)
- [Desktop Windows](./desktop-windows.md)

## Workbench And Workspace

- [Workbench Contributions](./workbench-contributions.md)
- [Workbench Dock Model](./workbench-dock-model.md)
- [Workbench Node Lifecycle](./workbench-node-lifecycle.md)
- [Workspace App Factory](./workspace-app-factory.md)
- [Workspace Issue Manager](./workspace-issue-manager.md)
- [Tutti Mode Activation And Workspace Workflows](./workspace-workflows.md)
- [Workspace Terminal](./workspace-terminal.md)

Keep this directory limited to current ownership, contracts, and data flow.
Move unfinished work to specs, and remove completed rollout history after its
durable decisions are represented here.
