# Runtime Image Sources

This directory keeps the original-resolution source images for raster assets
that are intentionally smaller at runtime. Its tree mirrors the original
runtime path so a source and its generated output can be matched directly.

Applications and packages must not import files from this directory. Runtime
code imports the optimized copy under `apps/`, `packages/`, or `services/`.

When replacing an optimized image:

1. update the mirrored source image here;
2. determine the largest rendered CSS size, including hover or animation
   magnification;
3. generate a runtime image at twice that size for Retina displays;
4. keep the existing runtime path and format when practical;
5. compare the source and runtime image at the actual UI size.

Full-window wallpapers, documentation screenshots, onboarding screenshots,
recordings, and platform packaging icons remain at their original runtime
resolution because their display size is not bounded like an interface icon.
