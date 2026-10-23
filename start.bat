@echo off
setlocal
chcp 65001 >nul 2>nul
title Aurora Music - Local Music Player
cd /d "%~dp0"

echo.
echo   ============================================
echo    Aurora Music ^| Local Music Player
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 goto NO_NODE

if exist "node_modules\vite\bin\vite.js" goto RUN

:INSTALL
echo   First run: installing dependencies, this may take a minute...
echo.
call npm install
if errorlevel 1 goto INSTALL_FAIL

:RUN
if not exist "node_modules\vite\bin\vite.js" goto INSTALL_FAIL
echo   Starting local server at http://127.0.0.1:5273
echo   Keep this window open. Close it to stop the server.
echo.
if /i "%~1"=="nobrowser" goto RUN_NOOPEN
call node "node_modules\vite\bin\vite.js" --host 127.0.0.1 --port 5273 --strictPort --open
goto END

:RUN_NOOPEN
call node "node_modules\vite\bin\vite.js" --host 127.0.0.1 --port 5273 --strictPort
goto END

:NO_NODE
echo   [ERROR] Node.js not found.
echo   Install Node.js 18 or newer from https://nodejs.org/ then run this file again.
echo.
pause
exit /b 1

:INSTALL_FAIL
echo.
echo   [ERROR] Dependencies are not installed or installation failed.
echo   Try running this in the project folder:  npm install
echo.
pause
exit /b 1

:END
echo.
echo   Server stopped.
echo.
echo   If you saw "Port 5273 is already in use", the player is most likely
echo   already running - just open this in your browser:
echo       http://127.0.0.1:5273
echo.
pause
