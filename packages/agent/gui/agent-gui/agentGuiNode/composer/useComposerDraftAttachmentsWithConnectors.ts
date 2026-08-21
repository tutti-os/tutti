import {
  useComposerDraftAttachments,
  type UseComposerDraftAttachmentsInput
} from "./useComposerDraftAttachments";
import { useDraftConnectorSelection } from "./useComposerDraftConnectorSelection";
import { useComposerDraftQuoteActions } from "./useComposerDraftQuoteActions";

export function useComposerDraftAttachmentsWithConnectors(
  input: UseComposerDraftAttachmentsInput
) {
  const attachments = useComposerDraftAttachments(input);
  const { _updateScopedDraft, ...publicAttachments } = attachments;
  const quoteActions = useComposerDraftQuoteActions(
    input.draftScopeKey,
    _updateScopedDraft
  );
  const connectorSelection = useDraftConnectorSelection(
    input.draftScopeKey,
    _updateScopedDraft
  );
  return { ...publicAttachments, ...quoteActions, ...connectorSelection };
}
