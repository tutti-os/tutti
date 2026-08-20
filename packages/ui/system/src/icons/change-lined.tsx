import type { IconProps } from "./types";

export function ChangeLined({
  className,
  size = 24,
  title,
  ...props
}: IconProps) {
  const dimension = typeof size === "number" ? `${size}` : size;

  return (
    <svg
      aria-hidden={title ? undefined : true}
      className={className}
      fill="none"
      height={dimension}
      viewBox="0 0 24 24"
      width={dimension}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <path
        d="M19 14.5008C19.4044 14.5008 19.769 14.7444 19.9238 15.118C20.0785 15.4916 19.993 15.9219 19.707 16.2079L16.207 19.7079C15.8165 20.098 15.1834 20.0981 14.793 19.7079C14.4027 19.3175 14.4028 18.6843 14.793 18.2938L16.5859 16.5008H5C4.44813 16.5006 4.00027 16.0527 4 15.5008C4 14.9487 4.44796 14.5011 5 14.5008H19ZM7.79297 4.2928C8.18344 3.90236 8.8165 3.90244 9.20703 4.2928C9.59751 4.68331 9.59751 5.31634 9.20703 5.70686L7.41406 7.49984H19C19.5521 7.49999 19.9999 7.9477 20 8.49984C19.9999 9.05197 19.5521 9.4997 19 9.49985H5C4.59573 9.49967 4.23091 9.25617 4.07617 8.88266C3.92146 8.50912 4.00722 8.0788 4.29297 7.79281L7.79297 4.2928Z"
        fill="currentColor"
      />
    </svg>
  );
}
