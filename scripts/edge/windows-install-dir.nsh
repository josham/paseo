# Paseo Edge installs into a directory of its own.
#
# electron-builder takes the NSIS install directory from `productFilename`, which is
# `executableName` whenever that is set and only falls back to `productName`:
#
#   app-builder-lib/out/appInfo.js:57
#     productFilename = sanitizeFileName(executableName ?? productName)
#   app-builder-lib/out/targets/targetUtil.js:41
#     getWindowsInstallationDirName() returns productFilename
#   app-builder-lib/templates/nsis/multiUser.nsh:40
#     StrCpy $INSTDIR "$0\${APP_FILENAME}"
#
# packages/desktop/electron-builder.yml pins `executableName: Paseo`, and the Edge build
# overrides `productName` only. So Edge and a stock Paseo both default to
# %LOCALAPPDATA%\Programs\Paseo: one directory holding one Paseo.exe and one
# "Uninstall Paseo.exe", with two uninstall records pointing at it. Installing either over
# the other overwrites it in place, and uninstalling either strands what is left of the
# other. Only the Start Menu shortcut ever said "Paseo Edge".
#
# Overriding `executableName` would fix the directory by renaming the binary to
# "Paseo Edge.exe" — which packages/desktop/e2e/packaged-app-smoke.js:10 and
# packages/desktop/scripts/after-pack.js:8 both hardcode as "Paseo", so the packaged smoke
# test would stop finding the app. Teaching them the new name is a packages/ edit, and this
# fork does not make those. The binary therefore keeps upstream's name and only the
# directory moves.
#
# installer.nsi:80 inserts customInit *after* initMultiUser has already set $INSTDIR, which
# is what makes this safe: the two cases initMultiUser resolves ahead of us are left exactly
# as it left them, and we only rewrite the default it would otherwise have handed to the
# directory page.

!macro customInit
  Push $0
  Push $1
  Push $2

  # An install already recorded here wins, in either hive — the assisted installer offers
  # both modes. Relocating on upgrade would install beside the running copy rather than
  # over it, and electron-updater drives exactly this path with /S.
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 == ""
    ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${EndIf}

  ${If} $0 == ""
    # An explicit /D= wins too. initMultiUser applied it last, so it is already in $INSTDIR.
    !insertmacro GetDParameter $1
    ${If} $1 == ""
      # What is left is initMultiUser's own default, "<parent>\${APP_FILENAME}". Swap that
      # last component rather than rebuilding the path: the parent is not always
      # %LOCALAPPDATA%\Programs — multiUser.nsh:33 prefers the FOLDERID_UserProgramFiles
      # known folder when Windows reports one, and that redirection has to survive.
      StrLen $2 "${APP_FILENAME}"
      StrCpy $0 $INSTDIR "" -$2
      ${If} $0 == "${APP_FILENAME}"
        StrCpy $INSTDIR $INSTDIR -$2
        StrCpy $INSTDIR "$INSTDIR${PRODUCT_NAME}"
      ${EndIf}
    ${EndIf}
  ${EndIf}

  Pop $2
  Pop $1
  Pop $0
!macroend
