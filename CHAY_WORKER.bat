@echo off
chcp 65001 >nul
echo ====================================================
echo   KHOI DONG WORKER CAO PARTSOUQ (AUTO-SETUP)
echo ====================================================

:: 1. Kiem tra thu muc node_modules, neu chua co thi cai playwright
if not exist "node_modules\playwright" (
    echo [1/3] Dang cai dat thu vien Playwright...
    call npm install playwright
) else (
    echo [1/3] Thu vien Playwright da san sang.
)

:: 2. Mo Google Chrome kem cong remote debugging 9222 (neu chua mo)
echo [2/3] Dang khoi dong Google Chrome (debug port 9222)...
set CHROME_PATH=""
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    set CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
) else if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    set CHROME_PATH="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
) else if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" (
    set CHROME_PATH="%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
)

if %CHROME_PATH%=="" (
    echo [LOI] Khong tim thay Google Chrome tren may nay!
    pause
    exit /b
)

:: Mo Chrome voi user-data-dir rieng de khong bi xung dot voi Chrome dang dung
start "" %CHROME_PATH% --remote-debugging-port=9222 --user-data-dir="C:\chrome-worker-profile" https://partsouq.com

echo.
echo =========================================================================
echo   LUU Y: Neu cua so Chrome bat len co CAPTCHA (Cloudflare),
echo   hay bam GIAI CAPTCHA 1 LAN tren trinh duyet do!
echo =========================================================================
echo.
timeout /t 5 >nul

:: 3. Chay Worker (tu bat lai neu chet: Chrome dong, mang rot, server reload)
echo [3/3] Dang ket noi toi May Chu Catalog...
set SERVER_IP=http://161.248.80.33:3001
set WORKER_NAME=%COMPUTERNAME%

echo Bat dau chay worker voi ten: %WORKER_NAME%
echo Xem tien do tai: %SERVER_IP%/tien-do-cao.html
echo Dung han: dong cua so nay (Ctrl+C khong du, no se tu bat lai).
echo.

:VONGLAP
node worker_substitutes.mjs --server %SERVER_IP% --worker-id %WORKER_NAME% --batch 40 --tabs 4
echo.
echo [%TIME%] Worker thoat. Bat lai sau 10 giay...
timeout /t 10 >nul
goto VONGLAP
