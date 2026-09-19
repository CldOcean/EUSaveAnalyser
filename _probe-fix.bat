@echo off
echo   START
start /wait "" node -e "1" > nul 2>&1
echo   MARKER > tmp\probe-marker.txt
echo   TAIL