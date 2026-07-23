import { Avatar as AvatarPrimitive } from "radix-ui";
import {
  useState,
  type ComponentProps,
  type ComponentPropsWithoutRef,
  type ReactNode
} from "react";

import { cn } from "#lib/utils";

type AvatarFallback = "initial" | "empty";
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

function avatarInitial(label: string, initial?: string): string {
  const value = initial?.trim() || label.trim();
  return Array.from(value)[0]?.toLocaleUpperCase() || "?";
}

function Avatar({
  children,
  className,
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
  const effectiveImageSrc = loading ? "" : normalizedSrc;
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
            setImageState({ src: effectiveImageSrc, status: "error" });
            imageProps?.onError?.(event);
          }}
          onLoadingStatusChange={(status) => {
            setImageState({ src: effectiveImageSrc, status });
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
export type { AvatarProps };
