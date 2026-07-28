---
"@tutti-os/commerce": minor
"@tutti-os/agent-gui": major
---

Publish the host-neutral Commerce contracts, policies, React Commerce menu
content, tier assets, and registration-credit toast. Keep the Account shell
(avatar, popover, login, settings, logout, and UID copy) in each Host. Move product-specific
insufficient-credit presentation behind AgentGUI's generic Host override and
stop rendering Account/Commerce UI inside AgentGUI. Remove the former
`accountMenuState`, `commercePresentation`, `AgentGUIAccountMenu*`, and
`AgentGUIAccountRewardToast` APIs; hosts must import account and Commerce
presentation from `@tutti-os/commerce` and `@tutti-os/commerce/react`.
