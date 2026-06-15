# @tutti-os/ui-system

Shared Tutti UI tokens, styles, icons, and low-level React primitives.

This package is published to npm as `@tutti-os/ui-system`.

Import the stylesheet once from the renderer or application shell:

```ts
import "@tutti-os/ui-system/styles.css";
```

Application code should prefer the root package export and the documented stable
subpaths over deep imports from internal files.

## External Development

External consumers should install the package normally:

```bash
pnpm add @tutti-os/ui-system
```

For local source sync from a Tutti checkout, start the UI system dev server:

```bash
pnpm --filter @tutti-os/ui-system dev:server
```

Then add the Vite plugin in the external app:

```ts
import { tuttiUISystemDev } from "@tutti-os/ui-system/dev-vite";

export default defineConfig({
  plugins: [tuttiUISystemDev()]
});
```

When the dev server is reachable, the plugin mirrors the allowed UI-system
source and skill-support files into `.tutti-ui-system-dev/` and aliases the
stable package entrypoints to that cache. When the dev server is unavailable,
resolution falls back to the installed package in `node_modules`.

Add the generated cache to the external app's `.gitignore`:

```text
.tutti-ui-system-dev/
```

If the external app uses the development cache, include only that cache in the
app's Tailwind source scan. The installed package stylesheet is already compiled
by the package build:

```css
@source "../.tutti-ui-system-dev";
```

## Agent Usage

Coding agents should read component metadata before creating or promoting UI:

```ts
import { uiSystemMetadata } from "@tutti-os/ui-system/metadata";
```

When promoting business UI into this package, use the bundled
`agent/tutti-ui-system/SKILL.md` skill when it is available. In the source
checkout, also read `AGENTS.md`, `ui-system.md`, and
`docs/conventions/desktop-visual-language.md`. The durable rules are:

1. prefer existing metadata entries before creating a component
2. classify the component as `base` or `business`
3. keep business components host-agnostic and side-effect-free
4. before promoting a business component, scan source usage and define the
   public props boundary from code evidence
5. compose business components from base primitives
6. add metadata, stable exports, and storyboard examples for public UI
7. run metadata and boundary validation before shipping

External repositories can install the bundled skill into their local Codex
skill directory with one command:

```bash
pnpm exec tutti-ui-system-install-skill
```

This copies the package skill into:

```text
.codex/skills/tutti-ui-system/SKILL.md
```

When `.tutti-ui-system-dev/` is present, the installer prefers the synced
source checkout so the installed skill and bundled UI-system rules stay aligned
with the current local UI-system source. The installer does not overwrite a
locally modified skill unless `--force` is provided.
