@echo off
title EU4 Save Archive - repair stored data
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found.
  echo   Install Node 22 or newer from https://nodejs.org , then run this again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Rebuilding all stored saves: data plane, self-contained page, thumbnails.
echo.
echo   Every save in the catalogue is rebuilt from its original.eu4, so a data
echo   plane written by older code is refreshed too, not only the broken ones.
echo   One save takes about 10 to 15 seconds, so a full run takes a few minutes.
echo   Nothing is ever deleted; each save is replaced in place.
echo.
echo   The Chinese report is written into the tmp folder and opens in Notepad
echo   when the run finishes. This window is ASCII-only on purpose.
echo.

node scripts\rebuild-stored-data.ts --all
set "RESULT=%ERRORLEVEL%"

echo.
if "%RESULT%"=="0" (
  echo   PASS - every save now stores a payload data.json.
) else (
  echo   FAIL - see the report for the saves that could not be repaired.
)
echo.

rem The report file has a Chinese name, and a batch file cannot spell it: cmd opens a
rem double-clicked window at the system code page (936 here), where the UTF-8 bytes of
rem that name decode as mojibake, so "notepad <name>" would open nothing. Take the
rem newest .txt in tmp instead - the driver writes its report last, so it is that one.
set "REPORT="
for /f "delims=" %%F in ('dir /b /o-d "tmp\*.txt" 2^>nul') do if not defined REPORT set "REPORT=%%F"
if defined REPORT start "" notepad "%~dp0tmp\%REPORT%"

pause
