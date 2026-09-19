@echo off
title EU4 Save Archive - local server
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

echo   Starting the save catalogue server...
echo.
echo     address : http://127.0.0.1:8788
echo     storage : %~dp0.dev-storage
echo.

rem If something is already listening on the port, just show the site instead of
rem failing with EADDRINUSE and leaving the user with a dead window.
powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient).Connect('127.0.0.1',8788); exit 0 } catch { exit 1 }"
if not errorlevel 1 (
  echo   The server is ALREADY running - opening the browser.
  start "" http://127.0.0.1:8788
  timeout /t 3 >nul
  exit /b 0
)

echo   A second window will open running the server. Close THAT window to stop it.
echo.

start "EU4 Save Archive server" cmd /k "node apps\site\src\dev-server.ts --port 8788"
timeout /t 2 >nul
start "" http://127.0.0.1:8788

echo   Browser opened. This window can be closed.
timeout /t 5 >nul
