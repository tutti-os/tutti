// ClipboardItem reliably supports only image/png, so non-png sources are
// rasterised to png via an offscreen canvas before writing.
export interface CopyImageClipboardHost {
  writeImage?: (input: {
    data: string;
    mimeType: "image/png";
  }) => Promise<void>;
}

async function imageSrcToPngBlob(src: string): Promise<Blob | null> {
  const response = await fetch(src);
  const blob = await response.blob();
  if (blob.type === "image/png") {
    return blob;
  }
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.drawImage(bitmap, 0, 0);
  return await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((result) => resolve(result), "image/png")
  );
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.includes(",") ? (result.split(",").pop() ?? "") : result);
    };
    reader.readAsDataURL(blob);
  });
}

async function copyImageWithWebClipboard(blob: Blob): Promise<boolean> {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.clipboard?.write !== "function" ||
    typeof ClipboardItem === "undefined"
  ) {
    return false;
  }
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

export async function copyImageToClipboard(
  src: string,
  hostClipboard?: CopyImageClipboardHost | null
): Promise<boolean> {
  try {
    const blob = await imageSrcToPngBlob(src);
    if (!blob) {
      return false;
    }

    if (hostClipboard?.writeImage) {
      try {
        await hostClipboard.writeImage({
          data: await blobToBase64(blob),
          mimeType: "image/png"
        });
        return true;
      } catch {
        // Fall through to the browser clipboard path when a host exists but the
        // native clipboard write is denied or unavailable.
      }
    }

    return copyImageWithWebClipboard(blob);
  } catch {
    return false;
  }
}
