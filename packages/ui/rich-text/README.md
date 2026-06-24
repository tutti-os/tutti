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
  getItemIconUrl?: (
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

## External At-Panel Integration

External apps should treat `@tutti-os/ui-rich-text` as the generic trigger and
palette shell, not as an app-domain data source. The app still owns what can be
mentioned, how those items are queried, and what gets inserted.

Minimum integration checklist:

1. Install the package and load the panel CSS once from the app entry point:

   ```ts
   import "@tutti-os/ui-rich-text/at-panel/index.css";
   ```

2. Provide one or more `RichTextTriggerProvider`s for the app's mentionable
   domains. A provider owns querying, stable keys, visible labels, optional
   subtitles/icons/keywords, insertion mapping, and optional reverse
   resolution:

   ```ts
   import type { RichTextTriggerProvider } from "@tutti-os/ui-rich-text/types";

   const providers: RichTextTriggerProvider[] = [
     {
       id: "primary-record",
       trigger: "@",
       query: async ({ keyword, context }) => searchRecords(keyword, context),
       getItemKey: (record) => record.id,
       getItemLabel: (record) => record.title,
       getItemSubtitle: (record) => record.subtitle,
       getItemIconUrl: (record) => record.iconUrl,
       toInsertResult: (record) => ({
         kind: "mention",
         mention: {
           entityId: record.id,
           label: record.title,
           scope: { ownerId: record.ownerId }
         }
       })
     }
   ];
   ```

3. Query those providers through the rich-text trigger registry or an
   equivalent host bridge and keep the results as
   `RichTextTriggerQueryMatch[]`. Provider ordering remains host-owned. The
   palette only renders the matches it is given.

4. Define palette categories in the app. A category is the top-level tab/filter;
   optional `sections` become second-level groups inside the active category.
   When sections are present, each match is assigned to the first matching
   section in declaration order. A category without sections renders as a
   single group:

   ```ts
   import type { MentionPaletteCategoryConfig } from "@tutti-os/ui-rich-text/at-panel";

   const categories: MentionPaletteCategoryConfig[] = [
     {
       id: "primary",
       label: t("mentions.primary"),
       providerIds: ["primary-record"],
       sections: [
         {
           id: "recent",
           label: t("mentions.recent"),
           matches: (match) => match.item.bucket === "recent"
         },
         {
           id: "all",
           label: t("mentions.all"),
           matches: (match) => match.item.bucket !== "recent"
         }
       ]
     },
     {
       id: "secondary",
       label: t("mentions.secondary"),
       providerIds: ["secondary-record"]
     }
   ];
   ```

5. Convert matches into palette state and render the shared shell:

   ```tsx
   import {
     MentionPaletteFromState,
     buildMentionPaletteModelFromTriggerMatches,
     renderMentionRow,
     richTextTriggerQueryMatchToMentionRowItem
   } from "@tutti-os/ui-rich-text/at-panel";

   const state = buildMentionPaletteModelFromTriggerMatches({
     activeCategoryId,
     categories,
     matches,
     loading,
     query
   });

   <MentionPaletteFromState
     state={state}
     highlightedKey={highlightedKey}
     getItemKey={(match, groupId) => `${match.providerId}:${match.key}`}
     callbacks={{
       onActiveCategoryIdChange: setActiveCategoryId,
       onHighlightChange: setHighlightedKey,
       onSelectItem: commitMatch
     }}
     labels={{
       empty: t("mentions.empty"),
       loading: t("mentions.loading")
     }}
     hintLabels={{
       cycleFilter: t("mentions.switchCategory"),
       moveSelection: t("mentions.switchSelection")
     }}
     maxHeightPx={360}
     renderItem={(match) =>
       renderMentionRow(
         richTextTriggerQueryMatchToMentionRowItem(match, {
           getDescription: (candidate) => candidate.subtitle,
           renderLeading: (ctx) => renderAppSpecificLeading(ctx)
         })
       )
     }
   />;
   ```

6. Wire keyboard handling to the state adapter or to `makeAtPanelKeyDown`.
   External apps should keep the exact shortcut policy local; the shared shell
   supports moving selection, cycling categories, expanding groups, and
   committing the highlighted item.

7. Keep app-owned behavior outside the package. This includes i18n strings,
   item-specific icons or avatars, domain data fetches, cache refresh policy,
   host bridge calls, and the final insertion side effects. Use
   `renderLeading`, `getDescription`, status helpers, and category/section
   config as customization slots instead of forking the panel shell.
