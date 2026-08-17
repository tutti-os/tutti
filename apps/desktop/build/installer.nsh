; Keep user state in %USERPROFILE%\.tutti, but remove command shims that
; the packaged app created outside electron-builder's installation directory.
!ifdef BUILD_UNINSTALLER
Function un.RemoveOwnedTuttiShim
  Exch $0
  Push $1
  Push $2

  ClearErrors
  FileOpen $1 "$0" r
  IfErrors done
  FileRead $1 $2
  FileRead $1 $2
  FileClose $1
  StrCmp $2 "rem Tutti CLI shim$\r$\n" 0 done
  Delete "$0"

done:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function un.RemoveTuttiUserState
  SetShellVarContext current
  RMDir /r "$PROFILE\.tutti"
  RMDir /r "$APPDATA\Tutti"
  RMDir /r "$LOCALAPPDATA\@tutti-osdesktop-updater"
  DeleteRegKey HKCU "Software\Classes\tutti"
FunctionEnd
!endif

!macro customUnInstall
  ; electron-builder already accepts this flag for Electron app data. Extend
  ; the same explicit reset request to all Tutti-owned per-user state.
  ClearErrors
  ${GetParameters} $0
  ${GetOptions} $0 "--delete-app-data" $1
  ${IfNot} ${Errors}
    Goto deleteUserState
  ${EndIf}

  ; Normal one-click uninstall is made silent internally after electron-builder's
  ; first confirmation, so a custom Section would be unreachable. Use the actual
  ; command line to distinguish an explicit /S uninstall from an interactive one.
  ClearErrors
  ${GetOptions} $0 "/S" $1
  ${IfNot} ${Errors}
    Goto preserveUserState
  ${EndIf}
  ClearErrors
  ${GetOptions} $0 "--updated" $1
  ${IfNot} ${Errors}
    Goto preserveUserState
  ${EndIf}

  MessageBox MB_YESNOCANCEL|MB_ICONQUESTION "Delete all Tutti user data and settings? Choose No to preserve them for reinstall." IDYES deleteUserState IDNO preserveUserState
  Abort "Uninstall canceled."

deleteUserState:
  StrCpy $3 "1"
  Goto selectionDone

preserveUserState:
  StrCpy $3 "0"

selectionDone:
  Push "$PROFILE\.tutti\bin\tutti.cmd"
  Call un.RemoveOwnedTuttiShim
  Push "$PROFILE\.local\bin\tutti.cmd"
  Call un.RemoveOwnedTuttiShim
  Push "$PROFILE\bin\tutti.cmd"
  Call un.RemoveOwnedTuttiShim

  StrCmp $3 "1" 0 userStateDone
  Call un.RemoveTuttiUserState

userStateDone:
!macroend
