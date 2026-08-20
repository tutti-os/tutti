import type {
  AuthorizationEventEnvelopeV1,
  AuthorizationFieldV1,
  AuthorizationValueV1,
  AuthorizationViewEnvelopeV1
} from "@tutti-os/connector-contracts/authorization/v1";
import {
  Button,
  Checkbox,
  DialogFooter,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner
} from "@tutti-os/ui-system/components";
import qrcode from "qrcode-generator";
import { useMemo, useState, type ComponentType, type FormEvent } from "react";

import { createAuthorizationSubmitEvent } from "../../application/authorization/declarativeAuthorizationAdapter.ts";

export interface AuthorizationRendererLabels {
  activate: string;
  cancel: string;
  refresh: string;
  qrCodeAlt: string;
  retry: string;
  submit: string;
  unsupportedField: string;
}

export interface AuthorizationViewRendererProps {
  busy: boolean;
  labels: AuthorizationRendererLabels;
  view: AuthorizationViewEnvelopeV1;
  onEvent(event: AuthorizationEventEnvelopeV1): void;
}

export type AuthorizationViewRenderer =
  ComponentType<AuthorizationViewRendererProps>;

type AuthorizationActionEventType = Exclude<
  AuthorizationEventEnvelopeV1["event"]["type"],
  "submit"
>;

function createAuthorizationActionEvent(
  viewId: string,
  type: AuthorizationActionEventType
): AuthorizationEventEnvelopeV1 {
  return {
    protocol: "tutti.connector.authorization.event.v1",
    viewId,
    event: { type }
  };
}

function initialFormValues(
  fields: readonly AuthorizationFieldV1[]
): Record<string, AuthorizationValueV1> {
  const values: Record<string, AuthorizationValueV1> = {};
  for (const field of fields) {
    if (field.type === "boolean") {
      values[field.name] = field.defaultValue ?? false;
    } else if ("defaultValue" in field && field.defaultValue !== undefined) {
      values[field.name] = field.defaultValue;
    }
  }
  return values;
}

function requiredFormValuesPresent(
  fields: readonly AuthorizationFieldV1[],
  values: Readonly<Record<string, AuthorizationValueV1>>
): boolean {
  return fields.every((field) => {
    if (field.type === "local_file") return false;
    if (!field.required) return true;
    const value = values[field.name];
    return field.type === "boolean"
      ? value === true
      : typeof value === "string"
        ? value.length > 0
        : value !== undefined;
  });
}

function AuthorizationFormField({
  busy,
  field,
  unsupportedField,
  value,
  onChange
}: {
  busy: boolean;
  field: AuthorizationFieldV1;
  unsupportedField: string;
  value: AuthorizationValueV1 | undefined;
  onChange(value: AuthorizationValueV1): void;
}) {
  const description =
    field.type === "local_file" ? unsupportedField : field.description;

  return (
    <label className="grid gap-2" htmlFor={`authorization-${field.name}`}>
      <span className="text-sm font-medium text-[var(--text-primary)]">
        {field.label}
        {field.required ? " *" : null}
      </span>
      {field.type === "text" || field.type === "secret" ? (
        <Input
          autoComplete="off"
          disabled={busy}
          id={`authorization-${field.name}`}
          placeholder={field.placeholder}
          type={field.type === "secret" ? "password" : "text"}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      ) : field.type === "number" ? (
        <Input
          disabled={busy}
          id={`authorization-${field.name}`}
          max={field.maximum}
          min={field.minimum}
          placeholder={field.placeholder}
          step={field.step}
          type="number"
          value={typeof value === "number" ? value : ""}
          onChange={(event) => {
            if (event.currentTarget.value !== "") {
              onChange(event.currentTarget.valueAsNumber);
            }
          }}
        />
      ) : field.type === "select" ? (
        <Select
          disabled={busy}
          value={typeof value === "string" ? value : undefined}
          onValueChange={onChange}
        >
          <SelectTrigger id={`authorization-${field.name}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent style={{ zIndex: "var(--z-dialog-popover)" }}>
            {field.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : field.type === "boolean" ? (
        <Checkbox
          checked={value === true}
          disabled={busy}
          id={`authorization-${field.name}`}
          onCheckedChange={(checked) => onChange(checked === true)}
        />
      ) : (
        <Input disabled id={`authorization-${field.name}`} type="file" />
      )}
      {description ? (
        <span className="text-xs text-[var(--text-tertiary)]">
          {description}
        </span>
      ) : null}
    </label>
  );
}

function AuthorizationFormRenderer({
  busy,
  labels,
  view,
  onEvent
}: AuthorizationViewRendererProps & {
  view: AuthorizationViewEnvelopeV1 & { view: { type: "form" } };
}) {
  const [values, setValues] = useState<Record<string, AuthorizationValueV1>>(
    () => initialFormValues(view.view.fields)
  );
  const canSubmit =
    !busy && requiredFormValuesPresent(view.view.fields, values);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit) {
      onEvent(createAuthorizationSubmitEvent(view.viewId, values));
    }
  };

  return (
    <form className="grid gap-4" onSubmit={submit}>
      {view.view.title ? (
        <h3 className="m-0 text-base font-semibold text-[var(--text-primary)]">
          {view.view.title}
        </h3>
      ) : null}
      {view.view.description ? (
        <p className="m-0 text-sm text-[var(--text-secondary)]">
          {view.view.description}
        </p>
      ) : null}
      {view.view.fields.map((field) => (
        <AuthorizationFormField
          busy={busy}
          field={field}
          key={field.name}
          unsupportedField={labels.unsupportedField}
          value={values[field.name]}
          onChange={(value) =>
            setValues((current) => ({ ...current, [field.name]: value }))
          }
        />
      ))}
      <DialogFooter className="pt-1 sm:justify-center">
        <Button
          disabled={busy}
          size="dialog"
          type="button"
          variant="secondary"
          onClick={() =>
            onEvent(createAuthorizationActionEvent(view.viewId, "cancel"))
          }
        >
          {labels.cancel}
        </Button>
        <Button disabled={!canSubmit} size="dialog" type="submit">
          {busy ? <Spinner size={14} /> : null}
          {view.view.submitLabel ?? labels.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}

function AuthorizationViewHeading({
  description,
  title
}: {
  description?: string;
  title?: string;
}) {
  return (
    <>
      {title ? (
        <h3 className="m-0 text-base font-semibold text-[var(--text-primary)]">
          {title}
        </h3>
      ) : null}
      {description ? (
        <p className="m-0 text-sm text-[var(--text-secondary)]">
          {description}
        </p>
      ) : null}
    </>
  );
}

function AuthorizationActionFooter({
  actionLabel,
  actionType,
  busy,
  cancelLabel,
  viewId,
  onEvent
}: {
  actionLabel?: string;
  actionType?: AuthorizationActionEventType;
  busy: boolean;
  cancelLabel: string;
  viewId: string;
  onEvent(event: AuthorizationEventEnvelopeV1): void;
}) {
  return (
    <DialogFooter className="sm:justify-center">
      <Button
        disabled={busy}
        size="dialog"
        type="button"
        variant="secondary"
        onClick={() =>
          onEvent(createAuthorizationActionEvent(viewId, "cancel"))
        }
      >
        {cancelLabel}
      </Button>
      {actionType && actionLabel ? (
        <Button
          disabled={busy}
          size="dialog"
          type="button"
          onClick={() =>
            onEvent(createAuthorizationActionEvent(viewId, actionType))
          }
        >
          {busy ? <Spinner size={14} /> : null}
          {actionLabel}
        </Button>
      ) : null}
    </DialogFooter>
  );
}

function AuthorizationQrCodeRenderer({
  busy,
  labels,
  view,
  onEvent
}: AuthorizationViewRendererProps & {
  view: AuthorizationViewEnvelopeV1 & { view: { type: "qr_code" } };
}) {
  const imageSource = useMemo(() => {
    if (view.view.source.type === "png_base64") {
      return `data:image/png;base64,${view.view.source.value}`;
    }
    try {
      const code = qrcode(0, "M");
      code.addData(view.view.source.value);
      code.make();
      return code.createDataURL(6, 12);
    } catch {
      return null;
    }
  }, [view.view.source]);

  return (
    <div className="grid gap-4 text-center">
      <AuthorizationViewHeading
        description={view.view.description}
        title={view.view.title}
      />
      {imageSource ? (
        <img
          alt={view.view.title ?? labels.qrCodeAlt}
          className="mx-auto size-56 max-w-full rounded-lg bg-white p-3"
          src={imageSource}
        />
      ) : null}
      {view.view.fallbackText ? (
        <p className="m-0 break-all text-xs text-[var(--text-tertiary)]">
          {view.view.fallbackText}
        </p>
      ) : null}
      <AuthorizationActionFooter
        actionLabel={view.view.refreshable ? labels.refresh : undefined}
        actionType={view.view.refreshable ? "refresh" : undefined}
        busy={busy}
        cancelLabel={labels.cancel}
        viewId={view.viewId}
        onEvent={onEvent}
      />
    </div>
  );
}

export function DefaultAuthorizationViewRenderer(
  props: AuthorizationViewRendererProps
) {
  if (props.view.view.type === "form") {
    return (
      <AuthorizationFormRenderer
        {...props}
        view={
          props.view as AuthorizationViewEnvelopeV1 & {
            view: { type: "form" };
          }
        }
      />
    );
  }

  if (props.view.view.type === "qr_code") {
    return (
      <AuthorizationQrCodeRenderer
        {...props}
        view={
          props.view as AuthorizationViewEnvelopeV1 & {
            view: { type: "qr_code" };
          }
        }
      />
    );
  }

  const { view } = props.view;
  const action =
    view.type === "external_link" || view.type === "device_code"
      ? {
          label: view.actionLabel ?? props.labels.activate,
          type: "activate" as const
        }
      : view.type === "result" &&
          view.outcome === "failure" &&
          view.retryable === true
        ? { label: props.labels.retry, type: "retry" as const }
        : null;
  return (
    <div className="grid gap-4 text-center">
      {view.type === "progress" ? <Spinner size={20} /> : null}
      <AuthorizationViewHeading
        description={view.description}
        title={view.title}
      />
      {view.type === "device_code" ? (
        <output className="rounded-lg border border-[var(--border-1)] bg-[var(--surface-2)] px-4 py-3 font-mono text-lg font-semibold tracking-widest text-[var(--text-primary)]">
          {view.userCode}
        </output>
      ) : null}
      {"message" in view && view.message ? (
        <p className="m-0 text-sm text-[var(--text-secondary)]">
          {view.message}
        </p>
      ) : null}
      <AuthorizationActionFooter
        actionLabel={action?.label}
        actionType={action?.type}
        busy={props.busy}
        cancelLabel={props.labels.cancel}
        viewId={props.view.viewId}
        onEvent={props.onEvent}
      />
    </div>
  );
}
