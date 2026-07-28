# Documentation

Use this directory for durable repository knowledge and dated engineering
records. Choose the document type by the question you are trying to answer.

## Where To Start

| Question                                         | Source                                           | Authority                                           |
| ------------------------------------------------ | ------------------------------------------------ | --------------------------------------------------- |
| How is the system built now?                     | [Architecture](./architecture/README.md)         | Current implemented structure and data flow         |
| What rule must a change follow?                  | [Conventions](./conventions/README.md)           | Stable repository requirements                      |
| Why was a consequential choice made?             | [Architecture Decision Records](./adr/README.md) | Accepted decisions and tradeoffs                    |
| What is proposed or currently being implemented? | [Specs and Plans](./specs/README.md)             | Dated working records; not current truth by default |
| How do I build and debug the Android mobile app? | [Mobile Development](./mobile/README.md)         | Practical Android and React Native onboarding       |
| What should I do in this directory?              | The nearest `AGENTS.md`                          | Scoped routing, action rules, and required checks   |

Package READMEs remain the source for a package's public usage and exports.
When documents disagree, prefer current code and generated contracts, then the
narrowest current architecture or convention document. Use dated records or
Git history to recover intent, not to override current behavior.

## Document Lifecycle

- `current`: describes implemented behavior and is maintained with the code
- `accepted`: records a decision that remains in force
- `proposed`: design work that has not been accepted or implemented
- `active`: accepted work that is still being implemented
- `superseded`: retained only for history and linked to its replacement

New specs and plans should include a visible status near the title. If a dated
record has no status, treat its implementation state as unverified.

## Source-Of-Truth Rules

- Keep `AGENTS.md` files short: routing, required checks, and high-priority
  local instructions only.
- Put stable requirements in `docs/conventions`.
- Put the implemented subsystem model in `docs/architecture`.
- Put active PRDs, proposals, designs, and implementation plans in
  `docs/specs`; remove them after their durable result is documented.
- Put accepted cross-cutting decisions in `docs/adr`.
- Put reusable failure symptoms, causes, and verification steps in
  [Troubleshooting](./conventions/troubleshooting/README.md). Git history is sufficient
  for one-off defect journals.

When a plan lands, update the architecture or convention document that now
owns the durable result. Do not make future readers reconstruct current
behavior from the implementation plan.
