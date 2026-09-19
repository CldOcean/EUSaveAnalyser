@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo This pushes ONLY the apps folder, on top of what is already on GitHub.
echo Files already uploaded (docs, packages, scripts) are left untouched.
echo.

echo [1/5] Fetching the remote...
git fetch origin
if errorlevel 1 goto fail

echo [2/5] Moving our local branch onto the remote history (files on disk are kept)...
git reset --mixed origin/main
if errorlevel 1 (
  echo        Could not find origin/main. Is the GitHub repo empty?
  goto fail
)

echo [3/5] Staging ONLY apps (+ ignore rules)...
git add apps .gitignore .gitattributes
if errorlevel 1 goto fail

echo [4/5] Committing...
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "add apps"
  if errorlevel 1 goto fail
) else (
  echo        nothing new to commit
)

echo [5/5] Pushing...
git push -u origin main
if errorlevel 1 goto fail

echo.
echo DONE. Open https://github.com/CldOcean/EUSaveAnalyser to check.
echo NOTE: "git status" now lists docs/packages/scripts as untracked.
echo       That is normal - they are already on GitHub. Do not worry.
pause
exit /b 0

:fail
echo.
echo Something went wrong - read the messages above.
echo If it mentions "rejected", the remote changed again; send me the text.
pause
exit /b 1
