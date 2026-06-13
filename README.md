<div align="center">

<img src="docs/assets/tutti-logo.png" alt="Tutti logo" width="120" />

# Tutti

**Where people and agents build in tune.**

[Website](https://tutti.sh) · [Documentation](docs/README.md) · [Contributing](CONTRIBUTING.md)

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-tutti.sh-black.svg)](https://tutti.sh)

<!-- TODO: banner image / product screenshot -->

</div>

---

## What is Tutti?

Agents work in isolation by default. Tutti puts them in one live workspace: shared context, files, apps, and running tasks.

Your Codex sees what Claude built. Your agent calls an app and the output is ready for the next. No re-briefing.

No terminal required. Easy to use.

## Features

### The Live Workspace

Agents don't hand off summaries. They share the same live workspace. Your Codex sees what Claude changed, what is running, and what state the project is in.

Shared: Context · Files & outputs · Running state · Apps

<!-- TODO: workspace screenshot -->

### The Apps

Apps run on Tutti, for you and your agents. Use them yourself, or let any agent call them. Create images, videos, and more with official, community-built, or custom apps.

<!-- TODO: apps screenshot -->

### Goal to Tasks

Stop assigning every step by hand. Describe the goal. Tutti breaks it into clear tasks. Review each task, then assign it to the agent you want.

<!-- TODO: tasks screenshot -->

### Your Control

One place, not twenty tabs. See every agent conversation, pending approval, and running task in one view. Approve what needs your input with one click.

<!-- TODO: control center screenshot -->

## What You Can Do With Tutti

- Ask Codex to continue Claude's work without re-briefing it
- Let Claude write a PRD, then call a design app in the same workspace
- Open a teammate's local website through a cloud workspace without deploying it first
- Reference a teammate's agent thread without asking them to summarize it again
- Assign tasks to a teammate's agent when the work should move beyond one person

## Tutti · Local vs Tutti · Cloud

|                   | Tutti · Local                                                     | Tutti · Cloud                                                      |
| ----------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Best for**      | One person, many agents                                           | Two or more people and their agents                                |
| **Runs on**       | Local machine                                                     | Cloud workspace                                                    |
| **Shares**        | Context, files, outputs, tasks, running state, across your agents | Everything in Local, plus teammates, devices, shared cloud outputs |
| **Subscriptions** | Your own Claude, Codex, Gemini, and so on                         | Your own Claude, Codex, Gemini, and so on                          |
| **Pricing**       | Free                                                              | Free during Early Access; seat-based plans coming soon             |

Tutti works with the agent subscriptions you already have. No extra model plan is required for Local or Cloud.

This repository contains **Tutti · Local**: the desktop app and the local daemon. It is free and open source under Apache-2.0. Tutti · Cloud is a separate hosted service and its code is not part of this repository.

## FAQ

### Do I need to buy another agent subscription?

No. Tutti works with the Claude, Codex, Gemini, and other subscriptions or API access you already use.

### What if I do not have an agent subscription?

You will be able to start with Tutti Agent inside Tutti. Tutti Agent is free during Early Access; usage-based billing may apply later.

### What is the difference between Tutti · Local and Tutti · Cloud?

Use Local if you work alone with multiple agents. Join Cloud if you want teammates, multiple devices, or shared cloud outputs in the same workspace.

### Can my teammates see my private work?

Only what you share into a cloud workspace is available to teammates. Local work stays on your machine.

### Does Tutti replace my coding agent?

No. Tutti is the workspace around your agents. You can keep using Claude Code, Codex, Gemini, and other agents you already trust.

### Is Tutti only for coding?

No. Tutti is useful for coding, design, content, app workflows, and any work where multiple agents or teammates need the same context and outputs.

## Getting Started

### Download

<!-- TODO: download link for Tutti · Local -->

Download Tutti · Local — coming soon.

<!-- TODO: waitlist link for Tutti · Cloud -->

Join the waitlist for Tutti · Cloud — coming soon.

### Build from source

Prerequisites:

- Node.js `24` or newer (`.node-version` pins the baseline)
- pnpm `10.11.0`
- Go `1.24`

```sh
pnpm install
pnpm setup:dev
make dev-gui
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development guide.

## Community & Contributing

Contributions are welcome — read the [Contributing Guide](CONTRIBUTING.md) to get started, and our [Code of Conduct](CODE_OF_CONDUCT.md) for community standards.

To report a security vulnerability, see [SECURITY.md](SECURITY.md).

<!-- TODO: community channels (Discord / X / WeChat) -->

## License

Tutti is licensed under the [Apache License 2.0](LICENSE).

> Note: this codebase uses the internal codename `tutti` — you will see it in directory and binary names such as `services/tuttid`.
