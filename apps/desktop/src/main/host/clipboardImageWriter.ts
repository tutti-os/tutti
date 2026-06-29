export interface ClipboardWritableImage {
  isEmpty(): boolean;
}

export interface ClipboardImageWriter<TImage extends ClipboardWritableImage> {
  clear(): void;
  writeImage(image: TImage): void;
}

export interface ClipboardImageFactory<TImage extends ClipboardWritableImage> {
  createFromBuffer(buffer: Buffer): TImage;
}

export function writeImageToClipboardWriter<
  TImage extends ClipboardWritableImage
>(
  input: {
    data: string;
    mimeType: "image/png";
  },
  deps: {
    clipboard: ClipboardImageWriter<TImage>;
    nativeImage: ClipboardImageFactory<TImage>;
  }
): void {
  if (input.mimeType !== "image/png") {
    throw new Error(`unsupported clipboard image type: ${input.mimeType}`);
  }

  const image = deps.nativeImage.createFromBuffer(
    Buffer.from(input.data, "base64")
  );
  if (image.isEmpty()) {
    throw new Error("clipboard image is empty");
  }

  deps.clipboard.clear();
  deps.clipboard.writeImage(image);
}
