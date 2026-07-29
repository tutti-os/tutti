---
"@tutti-os/agent-gui": minor
"@tutti-os/ui-system": minor
"@tutti-os/desktop": patch
---

Add accessible drag-and-keyboard ordering to the Agent quick-prompt library.
The desktop adapter optimistically projects moves through a versioned
`beforePromptId` daemon contract, while hosts that omit the optional ordering
capability remain compatible. The UI System now exports a reusable Sortable
compound component adapted from the Dice UI shadcn registry.
