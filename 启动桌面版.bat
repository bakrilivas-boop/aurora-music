@echo off
cd /d "%~dp0"
if exist "release\win-unpacked\Aurora Music.exe" (
  start "" "release\win-unpacked\Aurora Music.exe"
  exit /b
)
echo Desktop build missing. Run npm run dist:win first.
pause
