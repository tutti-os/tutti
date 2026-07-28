# @tutti-os/workbench-electron

Electron main-process helpers for Workbench previews.

The package owns two product-neutral mechanics:

- serial `webContents.capturePage()` capture, renderer-rectangle cropping,
  full-size Genie output, bounded Dock resizing, timeout handling, and
  empty-image handling
- validated, bounded, atomic filesystem storage for Dock preview data URLs

The consuming desktop host still owns IPC authorization, BrowserWindow
ownership, the cache directory (for example, a path below Electron
`app.getPath("userData")`), and product logging.

```ts
import {
  captureWorkbenchPreviewImages,
  createWorkbenchDockPreviewCacheStore
} from "@tutti-os/workbench-electron";

const previewImages = await captureWorkbenchPreviewImages({
  contentSize: ownerWindow.getContentBounds(),
  maxHeight: 170,
  maxWidth: 260,
  rect: rendererRect,
  webContents: ownerWindow.webContents
});

const cache = createWorkbenchDockPreviewCacheStore({
  directory: dockPreviewCacheDirectory
});

if (previewImages) {
  await cache.write({ dataUrl: previewImages.dockPreviewImageUrl, key });
}
```

`captureWorkbenchPreviewImages` calls `capturePage()` once. The cropped native
image becomes the Genie image; a resized copy becomes the Dock preview.
`captureWorkbenchDockPreview` remains available for consumers that only need
the bounded Dock image.
