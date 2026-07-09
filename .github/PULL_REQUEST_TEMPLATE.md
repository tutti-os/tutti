## Summary

<!-- What changed and why? -->

## Verification

<!-- Commands run, manual checks, or why verification is not applicable. -->

## Fix Scope Justification

<!--
Required when a fix-titled PR changes more than 300 lines; delete otherwise.

- Root cause: which event or state is the actual source of the bug?
- Why can this not be fixed at a lower layer?
-->

## Fallback Three Questions

<!--
Required when this change adds a timer, retry, cache, or defensive branch;
delete otherwise.

- Source: which event or state does this fallback compensate for?
- Why can it not be fixed at that source?
- Removal condition: when can this fallback be deleted?
-->

## Checklist

- [ ] I kept the change focused on one concern.
- [ ] I updated documentation when behavior, setup, or contributor workflow changed.
- [ ] I updated all README/CONTRIBUTING language variants when changing their English source.
- [ ] I ran the lowest meaningful local checks for the changed surface.
- [ ] My commits are signed off with DCO when required: `git commit -s`.
