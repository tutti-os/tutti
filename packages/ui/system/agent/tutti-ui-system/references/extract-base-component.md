# Extract Base Component

Use this reference when the target is a low-level visual primitive.

## Base Criteria

Proceed only if the public API has no domain noun and props describe generic UI
concerns:

- presentation and variants
- interaction and accessibility
- refs, slots, class names, and children
- controlled or uncontrolled primitive state

If the component represents a workspace, file, task, agent, run, project,
account, or other business concept, use `promote-business-component.md`
instead.

## Workflow

1. Check metadata and existing exports first.
2. Read the bundled `ui-system.md` before implementation and
   treat it as a hard gate for the extraction. The component must follow the
   shared token, theme variable, spacing, radius, typography, surface,
   interactive-state, accessibility, and reduced-motion rules from
   `@tutti-os/ui-system`; do not preserve or introduce caller-local styling
   when it conflicts with those guidelines.
3. If the primitive exists in the shadcn registry, acquire it through shadcn CLI
   targeted at `packages/ui/system`.
4. Decide the primitive API before editing:
   - use finite variants or discriminated unions for mutually exclusive visual
     modes
   - keep standard UI booleans such as `disabled`, `loading`, `selected`,
     `open`, `required`, and `invalid` only when they represent real states
   - prefer `children`, slots, refs, and class names for composition instead
     of broad render props
   - use compound components or context only when consumers need to assemble
     reusable subparts that share primitive state
   - follow the React 19 baseline for new hand-authored components, but do not
     rewrite shadcn or Radix internals only for API-style churn
5. Adapt only package aliases, icon routing, tokens, stable exports, metadata,
   storyboard examples, and boundary-check issues.
6. Keep helper exports minimal and directly tied to primitive support.
7. Add metadata with `layer: "base"`.
8. Add preview coverage for the public states and variants exposed by the
   primitive.
   - This is mandatory for base-component promotion.
   - Do not treat metadata as sufficient by itself.
   - DOM primitives need an example in `apps/ui-storyboard`; React Native
     primitives need an example in the Mobile development gallery. Do not
     pretend that a DOM wrapper is evidence for a Native surface.
9. Replace duplicated local UI only after the shared primitive exists.
10. Run the promotion review gate from
    `ui-system.md`: verify Frictionless task
    preservation, Quality Craft visual/token/state parity, and Trustworthy
    status/error/accessibility behavior for the migrated consumer.
11. Start an independent design-foundation review subagent after promotion. The
    review must check the promoted files against
    `ui-system.md`, existing tokens, primitives,
    API shape, storyboard coverage, and metadata. Resolve any reported design
    drift before completion.

## Validation

Run the relevant checks:

```bash
node tools/scripts/check-ui-metadata.mjs
pnpm check:ui-boundaries
pnpm --filter @tutti-os/ui-storyboard typecheck
pnpm --filter @tutti-os/ui-system typecheck
```

If a consumer was migrated, also run that consumer's typecheck or build.

Before reporting completion, confirm preview delivery at two levels:

- inventory: the component is discoverable from the appropriate DOM storyboard
  or Native development gallery
- rendering: the component has a concrete example that renders its public
  states or variants on its target renderer

Do not report full design-foundation compliance unless the subagent review ran
and found no unresolved drift. If subagents are unavailable, report the
verification as blocked.

Report the promotion review result with the component id, selected states,
Frictionless / Quality Craft / Trustworthy pillar status, blocking/major/minor
issues, validation commands, and remaining risks or approved visual deltas.
