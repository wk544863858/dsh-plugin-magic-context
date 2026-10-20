@echo off
rem Magic Context plugin installer, shipped next to dsh-plugin-magic-context-<version>.tgz.
rem
rem Why this file exists: `dsh plugin add <file>.tgz` records the tarball's
rem ABSOLUTE PATH in the profile manifest, so deleting that file breaks every
rem later plugin operation ([ERR_PNPM ... ENOENT], measured 2026-10-13). This
rem script copies the tarball into a stable archive directory first and installs
rem from there, which makes the copy the recipient received disposable and makes
rem the next version a plain overwrite.
rem
rem Usage:  install-magic-context.bat [profile] [tarball]
rem         default profile: desktop
rem         default tarball: newest dsh-plugin-magic-context-*.tgz next to this script
rem
rem Messages are ASCII on purpose: a .bat with non-ASCII text renders as mojibake
rem under the default console code page.
setlocal EnableExtensions
title Magic Context plugin installer

set "PKG=dsh-plugin-magic-context"
set "PROFILE=%~1"
if "%PROFILE%"=="" set "PROFILE=desktop"
set "ARCHIVE=%MC_ARCHIVE_DIR%"
if "%ARCHIVE%"=="" set "ARCHIVE=%USERPROFILE%\dsh-plugins"
rem Test seam: point the running-app guard at a process name that never exists
rem to exercise this script from automation.
set "DSH_PROCESS=%MC_DSH_PROCESS%"
if "%DSH_PROCESS%"=="" set "DSH_PROCESS=DeepSeek Harness"
set "DSH_IMAGE=%DSH_PROCESS%.exe"

rem ---- 1) find the tarball -------------------------------------------------
set "TGZ=%~2"
if not defined TGZ for /f "delims=" %%F in ('dir /b /o-n "%~dp0%PKG%-*.tgz" 2^>nul') do if not defined TGZ set "TGZ=%~dp0%%F"
if not defined TGZ (
  echo [X] No %PKG%-*.tgz next to this script.
  pause
  exit /b 1
)
if not exist "%TGZ%" (
  echo [X] Tarball not found: %TGZ%
  pause
  exit /b 1
)
for %%A in ("%TGZ%") do set "NAME=%%~nxA"

rem ---- 2) the app must be closed -------------------------------------------
rem Windows keeps the profile's files busy while the app runs, and a replace
rem with the app open either fails or leaves a half-written profile behind.
rem `tasklist` answers "access denied" under some tokens, so ask PowerShell
rem (the same process list Get-Process shows) and keep tasklist only as the
rem fallback for a host without PowerShell. Labels instead of nested blocks:
rem quoted parentheses inside a parenthesized block are a parser hazard.
set "RUNNING="
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" goto guard_tasklist
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command "if (Get-Process -Name '%DSH_PROCESS%' -ErrorAction SilentlyContinue) { exit 1 } exit 0" >nul 2>nul
if errorlevel 1 set "RUNNING=yes"
goto guard_done
:guard_tasklist
tasklist /FI "IMAGENAME eq %DSH_IMAGE%" 2>nul | find /i "%DSH_IMAGE%" >nul
if not errorlevel 1 set "RUNNING=yes"
:guard_done
if defined RUNNING (
  echo [X] %DSH_PROCESS% is running. Quit it completely, then run this file again.
  pause
  exit /b 2
)

rem ---- 3) copy into the archive: this is the path pnpm will record ---------
if not exist "%ARCHIVE%" mkdir "%ARCHIVE%" >nul 2>nul
copy /y "%TGZ%" "%ARCHIVE%\%NAME%" >nul
if errorlevel 1 (
  echo [X] Could not copy to %ARCHIVE%
  pause
  exit /b 3
)

rem ---- 4) locate the dsh CLI -----------------------------------------------
rem The absolute path matters: dsh.cmd derives the application path from its own
rem %~dp0, which a bare `call "dsh"` does not provide - it then looks for
rem ..\..\..\..\DeepSeek Harness.exe relative to the current directory.
set "DSH="
if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" set "DSH=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
if not defined DSH if exist "%ProgramFiles%\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" set "DSH=%ProgramFiles%\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
if not defined DSH for /f "delims=" %%P in ('where dsh.cmd 2^>nul') do if not defined DSH set "DSH=%%P"
if not defined DSH (
  echo [X] The dsh CLI was not found. Is DeepSeek Harness installed?
  pause
  exit /b 4
)

rem ---- 5) replace whatever is installed, then install from the archive -----
rem The remove also clears a manifest entry whose source file is already gone,
rem which would otherwise block the install with ENOENT.
call "%DSH%" plugin --profile %PROFILE% remove %PKG% >nul 2>nul
echo -- installing %NAME% into profile "%PROFILE%" --
call "%DSH%" plugin --profile %PROFILE% add "%ARCHIVE%\%NAME%"
if errorlevel 1 (
  echo [X] Install failed. See the output above.
  echo     Retry by hand:  "%DSH%" plugin --profile %PROFILE% add "%ARCHIVE%\%NAME%"
  pause
  exit /b 5
)

echo.
echo [OK] Installed. The profile now records:
echo     %PKG%  -^>  %ARCHIVE%\%NAME%
echo.
echo Keep %ARCHIVE%\%NAME% where it is: the profile records this path.
echo Start DeepSeek Harness again to load the new version.
pause
