import { CheckIcon } from "@tutti-os/ui-system/icons";

export function MentionPaletteSelectIndicator(props: { selected: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="rich-text-at-mention-select-indicator"
      data-selected={props.selected ? "true" : "false"}
    >
      <CheckIcon size={13} />
    </span>
  );
}

export function MentionPaletteMultiSelectFooter(props: {
  count: number;
  countLabel: string;
  cancelLabel: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="rich-text-at-mention-multiselect-footer">
      <span className="rich-text-at-mention-multiselect-footer__count">
        {props.countLabel}
      </span>
      <div className="rich-text-at-mention-multiselect-footer__actions">
        <button
          type="button"
          className="rich-text-at-mention-multiselect-footer__button rich-text-at-mention-multiselect-footer__button--secondary"
          onMouseDown={(event) => event.preventDefault()}
          onClick={props.onCancel}
        >
          {props.cancelLabel}
        </button>
        <button
          type="button"
          disabled={props.count === 0}
          className="rich-text-at-mention-multiselect-footer__button rich-text-at-mention-multiselect-footer__button--primary"
          onMouseDown={(event) => event.preventDefault()}
          onClick={props.onConfirm}
        >
          {props.confirmLabel}
        </button>
      </div>
    </div>
  );
}
