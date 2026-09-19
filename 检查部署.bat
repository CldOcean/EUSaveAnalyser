@echo off
title EU4 Save Archive - deploy check
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

if not exist "tmp" mkdir "tmp"

echo.
echo   Checking apps\site\public against Cloudflare Pages limits...
echo.
echo     files under 20,000
echo     every file under 25 MiB
echo     site entry points and flag artwork present
echo.
echo   Writes a full report to tmp\deploy-check.txt and opens it.
echo.

node scripts\verify-deploy.ts > "tmp\deploy-check.txt" 2>&1
set "RESULT=%ERRORLEVEL%"

if "%RESULT%"=="0" echo   PASS - the site folder is ready to deploy.
if not "%RESULT%"=="0" echo   FAIL - see the report for which check did not pass.

echo.
start "" notepad "tmp\deploy-check.txt"
pause
