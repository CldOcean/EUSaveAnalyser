@echo off
title EU4 Save Archive - parse one save
cd /d "%~dp0"

set "SAVE=%~1"
if "%SAVE%"=="" (
  echo.
  echo   Parse one .eu4 save and show what the parser found.
  echo.
  rem No parentheses inside this block: a stray ')' would close the if early.
  set /p SAVE=Paste the .eu4 path here, or drag the file into this window, then press Enter: 
)
if "%SAVE%"=="" goto :end
set "SAVE=%SAVE:"=%"

if not exist "%SAVE%" (
  echo.
  echo   File not found: %SAVE%
  goto :end
)

echo.
echo   ============================================================
echo     save : %SAVE%
echo   ============================================================
echo.
echo   Parsing. A full save takes a few seconds - please wait.
echo.

rem Console output is ASCII only and the batch never changes the code page: piping
rem UTF-8 Chinese through cmd while chcp 65001 is active makes cmd stop running the
rem rest of the batch. All Chinese detail goes into the report file instead.
node scripts\parse-report.ts "%SAVE%" --out "tmp\parse-report.txt"
set "RESULT=%errorlevel%"

echo.
echo   ============================================================
if "%RESULT%"=="0" (
  echo     OK - opening the full report in Notepad...
) else (
  echo     Something failed. See the messages above and the report file.
)
echo   ============================================================
echo.

if exist "tmp\parse-report.txt" start "" notepad "%~dp0tmp\parse-report.txt"

:end
rem Set EU4_NOPAUSE=1 to run this unattended (used by the automated check).
if not "%EU4_NOPAUSE%"=="1" pause
