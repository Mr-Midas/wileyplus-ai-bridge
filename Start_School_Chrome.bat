@echo off
title Launch School Chrome (Debug Mode)
set "CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"
set "USER_DATA=%LOCALAPPDATA%\Google\Chrome\User Data"

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

echo Launching Chrome on Port 9229...
start "" "%CHROME_PATH%" --remote-debugging-port=9229 --user-data-dir="%USER_DATA%"
echo.
echo Chrome is now open on Port 9229. 
echo 1. Log in and go to WileyPLUS.
echo 2. Run run_agent.bat.
pause
