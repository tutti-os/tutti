# @tutti-os/workbench-electron

Electron main-process helpers for Workbench Dock previews.

The package owns two product-neutral mechanics:

- serial `webContents.capturePage()` capture, renderer-rectangle cropping,
  bounded resizing, timeout handling, and empty-image handling
- validated, bounded, atomic filesystem storage for Dock preview data URLs

The consuming desktop host still owns IPC authorization, BrowserWindow
ownership, the cache directory (for example, a path below Electron
`app.getPath("userData")`), and product logging.

```ts
import {
  captureWorkbenchDockPreview,
  createWorkbenchDockPreviewCacheStore
} from "@tutti-os/workbench-electron";

const previewImageUrl = await captureWorkbenchDockPreview({
  contentSize: ownerWindow.getContentBounds(),
  maxHeight: 170,
  maxWidth: 260,
  rect: rendererRect,
  webContents: ownerWindow.webContents
});

const cache = createWorkbenchDockPreviewCacheStore({
  directory: dockPreviewCacheDirectory
});

if (previewImageUrl) {
  await cache.write({ dataUrl: previewImageUrl, key });
}
```
