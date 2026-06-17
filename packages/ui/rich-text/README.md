# @tutti-os/ui-rich-text

Host-agnostic rich text foundations for Tutti frontend packages.

This package is the new home for the repository's rich text work. It is
intended to own:

- document normalization and plain-text extraction
- generic markdown-link helpers and mention-link serialization
- editor and readonly surfaces
- plugin and mention runtime contracts
- rich text extension registration

This package should not own workspace-domain semantics such as `/workspace/...`
path policy, workspace-file markdown meaning, host file lookup, or product
workflow-specific reference rules. Those stay with the owning workspace-domain
package or host adapter.

Current migration status:

- `src/internal/ported-source/*` is a direct snapshot of the old top-level
  `richText/` directory so we can refactor from the current code instead of
  redesigning from memory.
- `src/core/richTextDocument.ts` is the first promoted, host-agnostic surface
  extracted from that snapshot.
- editor wrappers and current node extensions are intentionally not public yet
  because they still depend on app-specific imports and legacy host seams.
- the package root export is intentionally narrow; `core`, `editor`, `plugins`,
  and `types` remain the explicit public subpaths

Known transitional seam:

- current editor and readonly surfaces still embed workspace-reference semantics
  such as `/workspace/...` link handling and workspace reference presentation
- treat that behavior as transitional implementation, not as the intended
  public contract of `@tutti-os/ui-rich-text`
- before adding another host-specific inline reference protocol here, stop and
  re-evaluate the generic rich-text reference seam across real consumers

Current refactor plan:

1. Promote host-agnostic document helpers from `ported-source` into `core`.
2. Define a stable plugin contract for `@`, `#`, and future inline token
   triggers.
3. Rebuild editor wrappers around injected host adapters instead of app-local
   imports.
4. Keep domain-specific reference protocols in their owning packages and only
   promote the generic rich-text seam here when it is truly host-agnostic.

## Mention Protocol

The stable `@` mention storage protocol is provider-agnostic:

```md
[@Label](mention://provider-id/entity-id?workspaceId=ws_1)
```

Boundary split:

- the editor core owns trigger detection, selection state, keyboard handling,
  insertion lifecycle, and storage shape
- the host trigger provider owns query behavior, suggestion copy, insert
  mapping, and reverse resolution

Stable stored attrs:

```ts
interface RichTextMentionAttrs {
  trigger: "@";
  providerId: string;
  entityId: string;
  label: string;
  scope?: Readonly<Record<string, string>>;
  presentation?: RichTextMentionPresentation;
}
```

Why this shape:

- `providerId` identifies which host capability owns the token
- `entityId` is the durable identity and must not depend on visible copy
- `label` is the last rendered fallback text so readonly and indexing can still
  work without a roundtrip
- `scope` holds short identity fields needed to locate the entity
- `presentation` is editor-only display data and is not serialized to Markdown

Trigger provider contract:

```ts
interface RichTextTriggerProvider<TItem = unknown> {
  id: string;
  trigger: RichTextTrigger;
  boundary?: RichTextTriggerBoundary;
  query: (
    input: RichTextTriggerQueryInput
  ) => Promise<readonly TItem[]> | readonly TItem[];
  getItemKey: (item: TItem) => string;
  getItemLabel: (item: TItem) => string;
  getItemSubtitle?: (item: TItem) => string | null | undefined;
  getItemThumbnailUrl?: (
    item: TItem
  ) => string | null | undefined | Promise<string | null | undefined>;
  getItemKeywords?: (item: TItem) => readonly string[] | undefined;
  toInsertResult: (item: TItem) => RichTextTriggerInsertResult;
  resolveMention?: (
    identity: RichTextMentionIdentity
  ) => Promise<RichTextMentionResolved | null> | RichTextMentionResolved | null;
}
```

Interpretation:

- `query` decides what a trigger can mention
- `getItemLabel` and `getItemSubtitle` decide the suggestion copy
- `toInsertResult` maps a chosen item into a mention, markdown-link, or text
  insertion
- `resolveMention` restores editor-only label or presentation data from the
  stored mention identity

Mention data:

```ts
interface RichTextMentionInsert {
  entityId: string;
  label: string;
  scope?: Readonly<Record<string, string>>;
  presentation?: RichTextMentionPresentation;
}

interface RichTextMentionResolved {
  label?: string;
  presentation?: RichTextMentionPresentation;
}
```

Markdown serialization includes only `providerId`, `entityId`, `label`, and
short `scope` fields. It does not serialize `presentation`, `href`, `kind`,
`version`, or arbitrary metadata.

Helpers now exported:

- `createRichTextMentionPlugin`
- `createRichTextMentionAttrs`
- `createRichTextMentionRegistry`
- `createRichTextLinkMarkdown`
- `getRichTextMentionDisplayText`
- `isRichTextMentionAttrs`
- `normalizeRichTextContent`
- `resolveRichTextMentionView`

Runtime surfaces now exported:

- `RichTextTriggerTextarea`
- `RichTextMentionReadonly`

Current runtime behavior:

- the registry aggregates multiple trigger providers in declaration order
- query results are flattened into a shared result shape
- mention hydration uses `resolveMention` when the owning trigger provider is
  available and keeps the label-only fallback when it is not
