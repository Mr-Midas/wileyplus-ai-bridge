@echo off
echo ============================================
echo  WileyPLUS AI Bridge - Starting
echo ============================================
echo.

:: Kill any existing Chrome with remote debugging
tasklist /FI "IMAGENAME eq chrome.exe" /FI "WINDOWTITLE eq *remote-debugging*" 2>nul | find /I "chrome.exe" >nul
if %ERRORLEVEL%==0 (
    echo [1] Closing existing Chrome debug instance...
    taskkill /F /IM chrome.exe /T >nul 2>&1
    timeout /t 2 /nobreak >nul
)

:: Check if Chrome is already running (without debugging)
tasklist /FI "IMAGENAME eq chrome.exe" 2>nul | find /I "chrome.exe" >nul
if %ERRORLEVEL%==0 (
    echo [!] Chrome is already running.
    echo     Close Chrome completely, or the server will launch a separate browser.
    echo.
)

:: Launch Chrome with remote debugging
set CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
set USER_DATA="C:\Users\thome\AppData\Local\Google\Chrome\User Data"

echo [2] Launching Chrome with remote debugging...
start "" %CHROME_PATH% --remote-debugging-port=9222 --user-data-dir=%USER_DATA%
echo     Chrome started. Waiting for it to load...
timeout /t 5 /nobreak >nul

:: Start the Python server
echo [3] Starting Wiley Bridge server on port 5000...
echo.
cd /d "%~dp0"
python bridge_server.py
pause
