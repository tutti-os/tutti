import * as React from "react";
import { Slider as SliderPrimitive } from "radix-ui";

import { cn } from "#lib/utils";

type SliderProps = React.ComponentProps<typeof SliderPrimitive.Root> & {
  /** Caller-owned accessible names for each thumb in a multi-value slider. */
  thumbAriaLabels?: readonly string[];
};

function Slider({
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  thumbAriaLabels,
  ...props
}: SliderProps) {
  const values = React.useMemo(
    () =>
      Array.isArray(value)
        ? value
        : Array.isArray(defaultValue)
          ? defaultValue
          : [min],
    [defaultValue, min, value]
  );

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn(
        "relative flex w-full touch-none items-center select-none outline-none data-disabled:cursor-not-allowed data-disabled:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-40 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
        className
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="relative grow overflow-hidden rounded-full bg-[var(--transparency-block)] data-[orientation=horizontal]:h-1 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1"
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className="absolute bg-[var(--tutti-purple)] select-none data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
        />
      </SliderPrimitive.Track>
      {Array.from({ length: values.length }, (_, index) => (
        <SliderPrimitive.Thumb
          aria-disabled={props.disabled || undefined}
          aria-label={
            thumbAriaLabels?.[index] ??
            (values.length === 1 ? ariaLabel : undefined)
          }
          aria-labelledby={values.length === 1 ? ariaLabelledBy : undefined}
          data-slot="slider-thumb"
          key={index}
          className="relative block size-3 shrink-0 rounded-full border border-[var(--tutti-purple)] bg-[var(--background-fronted)] shadow-none transition-[box-shadow] outline-none select-none after:absolute after:-inset-2 hover:ring-3 hover:ring-[color-mix(in_srgb,var(--tutti-purple)_20%,transparent)] focus-visible:ring-3 focus-visible:ring-[color-mix(in_srgb,var(--border-focus)_30%,transparent)] data-disabled:pointer-events-none data-disabled:hover:ring-0"
        />
      ))}
    </SliderPrimitive.Root>
  );
}

export { Slider, type SliderProps };
