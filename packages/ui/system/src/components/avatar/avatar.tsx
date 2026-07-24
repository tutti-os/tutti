import { Avatar as AvatarPrimitive } from "radix-ui";
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ComponentPropsWithoutRef,
  type ReactNode
} from "react";

import { cn } from "#lib/utils";

type AvatarFallback = "initial" | "empty";
type AvatarDeliveryMode = "auto" | "original";
type AvatarSize = "xs" | "sm" | "md" | "lg" | number;
type AvatarImageStatus = Parameters<
  NonNullable<
    ComponentPropsWithoutRef<
      typeof AvatarPrimitive.Image
    >["onLoadingStatusChange"]
  >
>[0];
type DataAttributes = {
  [key: `data-${string}`]: boolean | number | string | undefined;
};

interface AvatarProps extends Omit<
  ComponentProps<typeof AvatarPrimitive.Root>,
  "asChild" | "children"
> {
  children?: ReactNode;
  delivery?: AvatarDeliveryMode;
  fallback?: AvatarFallback;
  fallbackColor?: string;
  imageClassName?: string;
  imageProps?: Omit<
    ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>,
    "alt" | "className" | "src"
  > &
    DataAttributes;
  initial?: string;
  label: string;
  loading?: boolean;
  size?: AvatarSize;
  src?: string | null;
  surfaceClassName?: string;
}

const sizeClassNames: Record<Exclude<AvatarSize, number>, string> = {
  xs: "size-4",
  sm: "size-6",
  md: "size-8",
  lg: "size-10"
};

const sizePixels: Record<Exclude<AvatarSize, number>, number> = {
  xs: 16,
  sm: 24,
  md: 32,
  lg: 40
};

const avatarDeliveryBuckets = [32, 48, 64, 96, 128, 192, 256, 384, 512];

function avatarInitial(label: string, initial?: string): string {
  const value = initial?.trim() || label.trim();
  return Array.from(value)[0]?.toLocaleUpperCase() || "?";
}

function avatarSizePixels(size: AvatarSize): number {
  return typeof size === "number" && Number.isFinite(size) && size > 0
    ? size
    : typeof size === "number"
      ? sizePixels.md
      : sizePixels[size];
}

function avatarDeliveryDimension(value: number): number {
  const desiredSize = Math.ceil(value * 2);
  return (
    avatarDeliveryBuckets.find((bucket) => bucket >= desiredSize) ??
    avatarDeliveryBuckets.at(-1) ??
    desiredSize
  );
}

function avatarDeliveryUrl(
  src: string,
  dimensions: { height: number; width: number }
): string {
  let url: URL;

  try {
    url = new URL(src);
  } catch {
    return src;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return src;
  }

  url.searchParams.set(
    "width",
    String(avatarDeliveryDimension(dimensions.width))
  );
  url.searchParams.set(
    "height",
    String(avatarDeliveryDimension(dimensions.height))
  );
  url.searchParams.set("format", "webp");
  url.searchParams.set("fit", "inside");
  return url.toString();
}

function Avatar({
  children,
  className,
  delivery = "auto",
  fallback = "initial",
  fallbackColor,
  imageClassName,
  imageProps,
  initial,
  label,
  loading = false,
  size = "md",
  src,
  style,
  surfaceClassName,
  ...rootProps
}: AvatarProps): React.JSX.Element {
  const normalizedSrc = src?.trim() ?? "";
  const initialSize = avatarSizePixels(size);
  const surfaceRef = useRef<HTMLSpanElement>(null);
  const [renderedDimensions, setRenderedDimensions] = useState<{
    height: number;
    width: number;
  } | null>(null);
  const [failedDeliveryUrl, setFailedDeliveryUrl] = useState("");
  const deliveryImageSrc =
    delivery === "auto"
      ? avatarDeliveryUrl(
          normalizedSrc,
          renderedDimensions ?? { height: initialSize, width: initialSize }
        )
      : normalizedSrc;
  const shouldRetryOriginal =
    deliveryImageSrc !== normalizedSrc &&
    failedDeliveryUrl === deliveryImageSrc;
  const effectiveImageSrc = loading
    ? ""
    : shouldRetryOriginal
      ? normalizedSrc
      : deliveryImageSrc;
  const [imageState, setImageState] = useState<{
    src: string;
    status: AvatarImageStatus;
  }>({ src: "", status: "idle" });
  const imageStatus =
    imageState.src === effectiveImageSrc
      ? imageState.status
      : effectiveImageSrc
        ? "loading"
        : "error";
  const showImage = imageStatus === "loaded" && effectiveImageSrc.length > 0;
  const imagePending =
    effectiveImageSrc.length > 0 &&
    (imageStatus === "loading" || imageStatus === "idle");
  const imageSrcForPrimitive =
    imageStatus === "error" ? undefined : effectiveImageSrc || undefined;
  const avatarState = loading
    ? "loading"
    : effectiveImageSrc.length === 0
      ? fallback
      : imageStatus === "loading" || imageStatus === "idle"
        ? "loading"
        : showImage
          ? "image"
          : fallback;
  const numericSizeStyle =
    typeof size === "number"
      ? { height: `${size}px`, width: `${size}px`, ...style }
      : style;

  useEffect(() => {
    setFailedDeliveryUrl("");
  }, [normalizedSrc]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) {
      return;
    }

    const updateDimensions = (width: number, height: number): void => {
      if (width <= 0 || height <= 0) {
        return;
      }

      setRenderedDimensions((current) =>
        current?.width === width && current.height === height
          ? current
          : { height, width }
      );
    };
    const rect = surface.getBoundingClientRect();
    updateDimensions(rect.width, rect.height);

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        updateDimensions(entry.contentRect.width, entry.contentRect.height);
      }
    });
    observer.observe(surface);
    return () => {
      observer.disconnect();
    };
  }, []);

  const markImageError = (): void => {
    if (
      effectiveImageSrc === deliveryImageSrc &&
      shouldRetryOriginal === false
    ) {
      if (deliveryImageSrc !== normalizedSrc) {
        setFailedDeliveryUrl(deliveryImageSrc);
      }
    }
    setImageState({ src: effectiveImageSrc, status: "error" });
  };

  return (
    <AvatarPrimitive.Root
      {...rootProps}
      className={cn(
        "relative inline-grid shrink-0 place-items-center rounded-full align-middle",
        typeof size === "number" ? undefined : sizeClassNames[size],
        className
      )}
      data-avatar-state={avatarState}
      data-slot="avatar"
      style={numericSizeStyle}
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-full place-items-center overflow-hidden rounded-[inherit]",
          loading
            ? "animate-pulse bg-[var(--transparency-block)] motion-reduce:animate-none"
            : fallback === "empty" || imagePending
              ? "bg-transparent"
              : "bg-[var(--text-primary)] font-semibold leading-none text-[var(--text-inverted)]",
          surfaceClassName
        )}
        data-slot="avatar-surface"
        ref={surfaceRef}
        style={
          fallback === "initial" &&
          fallbackColor &&
          !showImage &&
          !loading &&
          !imagePending
            ? { backgroundColor: fallbackColor }
            : undefined
        }
      >
        <AvatarPrimitive.Image
          {...imageProps}
          alt=""
          className={cn(
            "block size-full max-w-none object-cover",
            imageClassName
          )}
          src={imageSrcForPrimitive}
          onError={(event) => {
            markImageError();
            imageProps?.onError?.(event);
          }}
          onLoadingStatusChange={(status) => {
            if (status === "error") {
              markImageError();
            } else {
              setImageState({ src: effectiveImageSrc, status });
            }
            imageProps?.onLoadingStatusChange?.(status);
          }}
        />
        <AvatarPrimitive.Fallback>
          {loading || fallback === "empty" || imagePending
            ? null
            : avatarInitial(label, initial)}
        </AvatarPrimitive.Fallback>
      </span>
      {children}
    </AvatarPrimitive.Root>
  );
}

export { Avatar };
export type { AvatarDeliveryMode, AvatarProps };
