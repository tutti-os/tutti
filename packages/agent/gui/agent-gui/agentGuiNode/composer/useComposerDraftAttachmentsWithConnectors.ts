import {
  useComposerDraftAttachments,
  type UseComposerDraftAttachmentsInput
} from "./useComposerDraftAttachments";
import { useDraftConnectorSelection } from "./useComposerDraftConnectorSelection";

export function useComposerDraftAttachmentsWithConnectors(
  input: UseComposerDraftAttachmentsInput
) {
  const attachments = useComposerDraftAttachments(input);
  const { _updateScopedDraft, ...publicAttachments } = attachments;
  const connectorSelection = useDraftConnectorSelection(
    input.draftScopeKey,
    _updateScopedDraft
  );
  return { ...publicAttachments, ...connectorSelection };
}
