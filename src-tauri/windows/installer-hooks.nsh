; Plyloft's NSIS hooks (tauri.conf.json -> bundle.windows.nsis.installerHooks).
;
; Never downgrade (2026-09-30): the old "Ply" app's updater ran a Plyloft
; 1.154.1 installer that wrote over a newer Plyloft 1.154.2. This file makes
; an older Plyloft installer refuse to replace a newer installed Plyloft (the
; DisplayVersion of Uninstall\Plyloft, the key the installer writes):
;
;   interactive  asked before the first page (default No = quit, nothing
;                changed). Yes continues to Tauri's own "Already installed"
;                page, which then uninstalls the newer version first.
;   passive /P   (the in-app updater) refused before any page: exit code 2,
;                no window left open; /R starts the installed Plyloft again.
;   silent /S    refused in NSIS_HOOK_PREINSTALL: exit code 2.
;
; Why here and not Tauri's `bundle.windows.allowDowngrades: false`: in
; Tauri's template (tauri-cli 2.11) that option only (a) disables the
; "Do not uninstall" choice on the interactive "Already installed" page —
; its pre-selected "Uninstall before installing" still removes the newer
; Plyloft, in that page's leave callback, before any install hook — and
; (b) aborts a silent run from `Section EarlyChecks` on `$R0 = -1`, a value
; only that page sets, and pages do not run when silent. So it refuses
; nothing reliably.
;
; Where each check runs: Tauri offers four hooks (PRE/POSTINSTALL,
; PRE/POSTUNINSTALL), none in .onInit. This file is included before MUI's
; first page, so it can also name MUI's GUI-init callback, which runs after
; .onInit (install dir and registry view set) and before the first page, in
; interactive and passive runs. It is parsed before the template's defines,
; variables and plugin directory, so it uses only NSIS built-ins and the
; headers already included (FileFunc, WordFunc, LogicLib): the installer's
; version comes from its own version resource (VIProductVersion, which
; Tauri always sets from tauri.conf.json), not from a hand-written define —
; a define the release bump forgot would compare the wrong version and could
; refuse a real upgrade as a downgrade. The key
; and executable names are spelled out (a Rust test keeps them in step with
; tauri.conf.json). A silent run has no GUI, so PREINSTALL covers it; that
; hook runs before the template's CheckIfAppIsRunning, so a refused
; downgrade never kills the running Plyloft.
;
; Tests: legacy_install.rs checks this file is wired and holds each check.

!define MUI_CUSTOMFUNCTION_GUIINIT PlyloftRefuseDowngrade

Function PlyloftRefuseDowngrade
  Push $0
  Push $1
  Push $2
  Push $R9
  ReadRegStr $R9 SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\Plyloft" "DisplayVersion"
  ClearErrors
  GetDLLVersion "$EXEPATH" $0 $1
  ${If} $R9 != ""
  ${AndIfNot} ${Errors}
    IntOp $2 $0 >> 16
    IntOp $0 $0 & 0xFFFF
    IntOp $1 $1 >> 16
    StrCpy $2 "$2.$0.$1"
    ${VersionCompare} "$2" "$R9" $0
    ; 2: the installed Plyloft is the newer one.
    ${If} $0 = 2
      ClearErrors
      ${GetOptions} $CMDLINE "/P" $1
      ${IfNot} ${Errors}
        ClearErrors
        ${GetOptions} $CMDLINE "/R" $1
        ${IfNot} ${Errors}
        ${AndIf} ${FileExists} "$INSTDIR\atelier.exe"
          Exec '"$INSTDIR\atelier.exe"'
        ${EndIf}
        SetErrorLevel 2
        Quit
      ${EndIf}
      MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "Plyloft $R9 is already installed, and this installer is the older $2. Install the older version? If you choose Yes, the next page removes Plyloft $R9 first; your workspaces and settings stay." /SD IDNO IDYES plyloft_older_confirmed
      SetErrorLevel 2
      Quit
      plyloft_older_confirmed:
    ${EndIf}
  ${EndIf}
  Pop $R9
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  Push $0
  Push $R7
  Push $R8
  Push $R9
  ReadRegStr $R9 SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${If} $R9 != ""
  ${AndIf} ${Silent}
    nsis_tauri_utils::SemverCompare "${VERSION}" $R9
    Pop $R8
    ${If} $R8 = -1
      DetailPrint "Plyloft $R9 is installed; this installer is the older ${VERSION}."
      System::Call 'kernel32::AttachConsole(i -1)i.r0'
      ${If} $0 <> 0
        System::Call 'kernel32::GetStdHandle(i -11)i.r0'
        FileWrite $0 "Plyloft $R9 is installed; refusing to install the older ${VERSION}.$\n"
      ${EndIf}
      ClearErrors
      ${GetOptions} $CMDLINE "/R" $R7
      ${IfNot} ${Errors}
      ${AndIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
        nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
      ${EndIf}
      Pop $R9
      Pop $R8
      Pop $R7
      Pop $0
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $0
!macroend
