# Step 9 — Desktop optimistic/reconcile rewrite (plan)

Phase 2 of the codex app-server refactor finish. Closes the Cluster A
desktop-half: _"user sends a message, their own message disappears, only the
agent reply shows"_ (historical sessions `7633ebb9` / `2d73bad7` / `08920807`;
related #608, #585). The daemon-half contract is already live (ADR 0004:
`Version` is a per-session monotonic counter assigned by the store,
`service.go:2083-2084`, preserved on merge; paging by version, display order by
`occurredAt`).

## Root cause: two version domains share one number line

Optimistic user echoes are minted as full `WorkspaceAgentActivityMessage` rows
with `version = id = Math.floor(occurredAtUnixMs)` (~10^12,
`useAgentGUINodeController.ts:2045,2049`), while durable rows carry the
daemon's small counter versions (1, 2, 3…). Every place the two domains meet is
a disappear/desync vector:

- **V1 — durable twin swallowed.** `mergeAgentActivityMessages` keyed by
  `messageId` (shared: `client-submit:user:<clientSubmitId>` on both the echo
  and the daemon row) replaces only when `incoming.version > existing.version`
  (`activity-core/src/merge.ts:117-125`). A durable twin (version 7) can never
  replace its echo (version 1.7×10^12): the true user row is dropped wherever a
  mixed array is merged; the echo is then suppressed by overlay dedupe → both
  gone.
- **V2 — cursor contamination.** `minFiniteMessageVersion` /
  `maxFiniteMessageVersion` / `latestAgentActivityMessageVersion` and the
  detail-window filters (`useAgentGUINodeController.ts:1484-1538`) compare
  versions numerically across arrays that can contain echoes (optimistic rows
  provably reach `detailMessages`: `retargetOptimisticPromptTurn` /
  `removeOptimisticPrompt` handle them there,
  `useAgentGUINodeController.ts:6026-6034,6062-6070`). One echo in the wrong
  array poisons `oldestLoadedVersion` / `beforeVersion` / `afterVersion`
  paging — the "unpainted optimistic row desyncs `after_version`" case from
  the design doc.
- **V3 — untargeted backfill.** The initial-load missing-user backfill stops as
  soon as _any_ user text message is in the window
  (`hasUserTextMessage`, `useAgentGUINodeController.ts:5285`), not the specific
  row the pending submit is waiting for.
- **V4 — silent drop on failure.** Submit failure removes the echo
  (`removeOptimisticPrompt`, `:7430`) without restoring the prompt text — the
  user's message is simply gone.
- **V5 — duplicated factory.** `createOptimisticPromptMessage` exists twice
  (`agentGuiController.promptHelpers.ts:28` and inline
  `useAgentGUINodeController.ts:2029`); fixes to one silently miss the other.

## Reference patterns

- **traycer chat-queue-reconciler**: pending sends tracked in id-keyed slices
  with a pure reconcile core; server log authoritative, echoes are a
  render-time overlay pruned only on confirmed identity; on reconnect snapshot
  a pending send is _promoted if present, else converted to a composer
  restore_ — never silently dropped; failure → restore slot.
- **t3code sequence contract**: client-minted message id echoed verbatim by
  the server so optimistic rows reconcile by pure id equality; monotonic
  server sequence is the only cursor; idempotent id-keyed reducer makes
  snapshot/live overlap harmless.

tutti already has the identity half (clientSubmitId → derived
`client-submit:user:<id>` MessageID on both sides, `prompt_content.go:150`) and
the daemon sequence half (ADR 0004). Step 9 is about making the desktop obey
them.

## Design

- **D1 — version-domain hygiene.** Optimistic echoes carry **no daemon-domain
  version**: `version: 0`, `id: 0`. Ordering: durable rows sort by version as
  today; echoes are appended _after_ durable rows, ordered among themselves by
  `occurredAtUnixMs` (`mergeWorkspaceAgentActivityDurableAndOverlayMessages`
  stops version-sorting across the domain boundary). This preserves today's
  rendered order (fake ms versions also always sorted echoes last). With
  `version: 0`, V1 inverts safely by construction: a durable twin (version ≥ 1)
  always replaces its echo in any id-keyed merge.
- **D2 — single-home invariant.** `detailMessages` is durable-only, enforced at
  the `agentSessionViewStore` setters (optimistic rows are filtered out with a
  diagnostic, not trusted at call sites). Echoes live only in
  `overlayMessages`. Version-cursor helpers (`minFiniteMessageVersion`,
  `maxFiniteMessageVersion`) skip optimistic rows so a stray echo can never
  poison a cursor even if one slips through.
- **D3 — reconcile keyed by identity.** Overlay suppression keeps the existing
  priority — durable `messageId` identity, then `clientSubmitId`, then the
  legacy text-signature fallback (needed for historical rows that predate
  clientSubmitId) — unchanged in semantics, now provably reachable because V1
  no longer swallows the durable twin first.
- **D4 — targeted backfill.** The initial-load backfill and the post-submit
  refresh target the _expected_ pending messageIds (derived from live submit
  traces) rather than "any user text message". If backfill exhausts without
  finding the twin, the echo stays visible — non-confirmation never deletes
  the user's message.
- **D5 — failure restores the composer.** On submit failure the echo is
  removed _and_ the prompt content is offered back to the composer
  (traycer's restore slot, one per session). The user's text is never
  destroyed.
- **D6 — one factory.** The duplicate `createOptimisticPromptMessage` is
  consolidated into `agentGuiController.promptHelpers.ts` and imported by the
  controller.

Out of scope: moving overlay state out of the controller into a new store
module (the reconcile stays where the state already lives), server-side
changes (ADR 0004 already landed), and the queued-prompt drain path (#585 has
its own pinning tests, which must stay green).

## Test plan (red first)

The three historical sessions have no per-session forensics (they are cited in
the corpus as the empirical basis of the class, not individually analyzed);
they are reproduced as the three failure _shapes_ of the class, each pinned by
an integration test in `useAgentGUINodeController.spec.tsx`:

- **T1 (shape of `7633ebb9` — page misses the user row).** Initial hydration
  returns a newest-page containing only the assistant reply (user row on an
  older page, as happened under same-ms versions). With a pending submit
  trace, targeted backfill (D4) recovers the exact user row; the transcript
  shows the user message.
- **T2 (shape of `2d73bad7` — echo swallows the durable twin).** Submit paints
  the echo; a live `message_update` delivers the durable twin with a small
  counter version. Exactly one user row renders — the durable one — ordered
  before the reply (D1/V1).
- **T3 (shape of `08920807` — cursor desync).** With an echo painted (and one
  forced into `detailMessages` via the retarget path), older-page loading must
  send `beforeVersion` equal to the durable minimum — not 0, not the echo's
  value (D1/D2/V2).
- **T4** — submit failure removes the echo and restores the composer (D5).
- **T5** — rapid-fire: two submits in flight reconcile independently; both
  user rows survive confirmation in order (traycer multi-pending).
- **T6** — reconnect: stream drops and resubscribes; a snapshot that does not
  contain the pending twin leaves the echo visible (never silently dropped).

Unit tests accompany D1/D2 in `workspaceAgentActivityTypes.spec.ts`,
`workspaceAgentSessionMessages.test.ts`, and a new spec for the version-domain
helpers.

## Execution order

1. Red integration tests T1–T3 (the three session shapes) + failing unit pins.
2. D1 + D2 (version domain + single home) — turns T2/T3 green.
3. D4 (targeted backfill) — turns T1 green.
4. D5 + T4, T5/T6 pins, D6 consolidation.
5. Full GUI suite + typecheck + daemon corpus (unchanged) + manual pass:
   send / reconnect / rapid-fire on a live desktop build.

## Risks

| Risk                                                        | Mitigation                                                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Ordering regression from the durable++overlay concatenation | D1 mirrors today's effective order (echoes last); projection specs + T2 pin it.                                           |
| Legacy sessions without clientSubmitId                      | Signature fallback retained (D3); corpus tests for #585/#608 stay green.                                                  |
| `version: 0` leaking into a daemon call                     | Helpers skip optimistic rows (D2); T3 pins the cursor value.                                                              |
| 15k-line controller churn                                   | Changes concentrate in pure helpers + the two factories; store setters enforce the invariant so call sites need no sweep. |
