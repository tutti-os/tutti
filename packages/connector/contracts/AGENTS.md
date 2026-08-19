# AGENTS.md

## Scope

This directory owns Connector wire contracts and published contract resources.

## Contract-first sequence

1. Change the source schema or OpenAPI fragment before consumers or generated
   output.
2. Preserve protocol names, field meanings, enums, errors, authentication, and
   call ordering unless the requested contract explicitly changes them.
3. Update every language consumer and generation relevance selector.
4. Run package tests/typecheck plus `pnpm check:api-generated` when OpenAPI is
   affected.

Completion requires the contract package to build without Renderer, React,
Electron, Desktop, AgentGUI, or tuttid dependencies, and generated output to be
clean.

Expose versioned, narrow subpaths. The package intentionally has no root
barrel. Untrusted payloads cross exported validators before domain use.
