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

!macro customHeader
  # FileFunc.nsh is already included by multiUser.nsh, but it defines nothing until its
  # macros are inserted and electron-builder inserts neither of these. Function definitions
  # belong at file scope, which is where installer.nsi inserts customHeader.
  !insertmacro GetParent
  !insertmacro GetFileName
!macroend

!macro customInit
  Push $0
  Push $1

  # An install already recorded here wins. electron-updater runs this installer over an
  # existing install, and relocating mid-update would drop a second copy beside the running
  # one. installer.nsh:104 writes this key, so it is set for anything already installed --
  # including a pre-fix Edge sitting in the shared directory, which therefore stays put.
  # Moving one of those takes an uninstall and a reinstall.
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 == ""
    ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${EndIf}

  ${If} $0 == ""
    # Otherwise this is initMultiUser's default, "<parent>\${APP_FILENAME}". Swap the last
    # component and keep the parent it resolved: that is not always %LOCALAPPDATA%\Programs,
    # because multiUser.nsh:33 prefers the FOLDERID_UserProgramFiles known folder when
    # Windows reports one, and that redirection has to survive.
    #
    # An explicit /D= is not checked for. It lands in $INSTDIR ahead of us and only collides
    # with this when it names a directory whose last component is exactly "${APP_FILENAME}".
    # Reading it back needs GetDParameter, whose StdUtils plugin call crashed the installer
    # here with 0xC0000005 -- and a /D= that specific is not worth a second plugin call in
    # .onInit.
    ${GetFileName} $INSTDIR $0
    ${If} $0 == "${APP_FILENAME}"
      ${GetParent} $INSTDIR $1
      StrCpy $INSTDIR "$1\${PRODUCT_NAME}"
    ${EndIf}
  ${EndIf}

  Pop $1
  Pop $0
!macroend
