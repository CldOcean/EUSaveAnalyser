@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo [1/4] Staging changes...
git add -A
if errorlevel 1 goto fail

echo [2/4] Committing...
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "update site"
  if errorlevel 1 goto fail
) else (
  echo        nothing new to commit
)

echo [3/4] Checking the remote...
git remote get-url origin >nul 2>&1
if errorlevel 1 (
  echo        no remote yet.
  set /p REPO_URL=Paste your GitHub repo URL ^(https://github.com/USER/REPO.git^): 
  git remote add origin "!REPO_URL!"
  if errorlevel 1 goto fail
)

echo [4/4] Pushing to GitHub...
git push -u origin main
if errorlevel 1 (
  echo.
  echo        Push was rejected. The remote may already contain files.
  echo        If that repo is brand new and only holds a few folders you
  echo        uploaded by hand, run this once instead:
  echo            git push -u --force origin main
  goto fail
)

echo.
echo DONE - your files are on GitHub.
pause
exit /b 0

:fail
echo.
echo Something went wrong - read the messages above.
pause
exit /b 1
