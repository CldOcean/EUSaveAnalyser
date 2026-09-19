@echo off
title EU4 Save Archive - build viewer
cd /d "%~dp0"

set "SAVE=%~1"
if "%SAVE%"=="" (
  echo.
  echo   Add one save and build its timeline viewer.
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
echo   Save   : %SAVE%
echo   Output : the local catalogue (.dev-storage), viewer files included
echo.
echo   Rendering the timeline - this needs the game's map files and takes ~30s.
echo.

node apps\site\src\build-viewer.ts --save "%SAVE%" --root .dev-storage

echo.
echo   Done. Open http://127.0.0.1:8788 to see it in the catalogue.
echo.

:end
pause
