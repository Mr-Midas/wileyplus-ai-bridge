@echo off
title Launch School Chrome (Debug Mode)

echo ============================================================
echo  WARNING: This will CLOSE ALL OPEN CHROME WINDOWS.
echo  Please save your work before continuing.
echo ============================================================
echo.
set /p "choice=Do you want to continue? (Y/N): "
if /I "%choice%" NEQ "Y" exit

echo.
echo Closing all existing Chrome processes...
taskkill /F /IM chrome.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul

echo Launching Chrome on Port 9222...
:: Chrome uses your default logged-in profile automatically
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222

echo.
echo Chrome is now open on Port 9222.
echo 1. Log in and go to WileyPLUS.
echo 2. Run run_agent.bat.
pause
