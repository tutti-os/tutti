import { Input } from "@tutti-os/ui-system";
import { workspaceSettingsInputClass } from "./workspaceSettingsFieldStyles";

const workspaceModelPlanInputClass = `${workspaceSettingsInputClass} focus-visible:!border-[var(--border-1)]`;

export function WorkspaceModelPlanPriceField({
  inputMode,
  label,
  value,
  onChange
}: {
  inputMode?: "decimal";
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-[10px] text-[var(--text-tertiary)]">
      <span>{label}</span>
      <Input
        aria-label={label}
        className={workspaceModelPlanInputClass}
        inputMode={inputMode}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}
