# Runtime Image Assets

Raster UI assets should be sized for their largest rendered CSS dimensions,
not their design-source dimensions.

## Resolution budget

Keep two physical image pixels for each CSS pixel at the largest supported
display size:

```text
runtime long edge >= largest rendered CSS long edge × 2
```

Include hover magnification, transforms, WebGL pixel ratio, and other
presentation scaling in the CSS size. Round up to a practical bucket such as
64, 128, 192, or 256 pixels. Do not upscale a smaller source merely to fill a
bucket.

Examples from the current desktop:

| Surface                                           | Largest CSS size | Runtime budget |
| ------------------------------------------------- | ---------------: | -------------: |
| Workbench Dock icon, including 1.7× magnification |          73.4 px |         192 px |
| AgentGUI hero and provider artwork                |      under 96 px |         192 px |
| AgentGUI vinyl carousel texture                   |      under 64 px |         128 px |
| App update icon                                   |            20 px |          64 px |
| Membership tier icon                              |            14 px |          64 px |
| Registration credits background                   |      280 px wide |    560 px wide |
| Onboarding section icon                           |            20 px |          64 px |

## Source and runtime ownership

Original-resolution masters for resized runtime assets live under
`design-assets/runtime-images/originals/`, mirroring their former runtime
paths. That directory is design input and must not be imported or packaged.

The optimized image at the normal `apps/`, `packages/`, or `services/` path is
the runtime asset. Preserve alpha, color profile, aspect ratio, and the
existing file path when practical. If the runtime format changes, update every
reference and package-asset check in the same change.

## Images that should not be reduced by this rule

Do not apply the icon budget to images whose rendered size follows the window
or document width:

- desktop wallpapers;
- product and onboarding screenshots;
- recordings and animated walkthroughs;
- README and documentation media;
- platform packaging icons.

Audit those assets against their own maximum presentation width instead.

## Enforcement

Run `pnpm check:runtime-image-budgets` after changing a bounded runtime image.
The check rejects images above the committed pixel or file-size budget while
leaving mirrored design masters and unbounded screenshots alone.

The staged form runs in `pre-commit`. The full form is selected by
`check:changed` and pull-request CI when a governed asset or the policy itself
changes. New Dock, AgentGUI agent, and AgentGUI vinyl images inherit their
directory budget automatically.
