@echo off
setlocal

echo ===================================================
echo   Cibola2 Backend App - PM2 Start Manager
echo ===================================================
echo.

:: 1. Verify PM2 is installed
call pm2 -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] PM2 is not installed or not in system PATH.
    echo Please run setup.bat first to install the dependencies and PM2.
    echo.
    pause
    exit /b 1
)

:: 2. Verify .env configuration exists
if not exist .env (
    echo [ERROR] No .env file detected in the current directory.
    echo Please run setup.bat first or configure your .env file.
    echo.
    pause
    exit /b 1
)

:: 3. Start the application via PM2
echo [*] Starting Cibola2 backend app under PM2...
call pm2 start src/index.js --name "cibola-backend"
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Failed to start application using PM2.
    echo.
    pause
    exit /b 1
)

:: 4. Save PM2 state so it persists restarts
echo [*] Saving current PM2 process list...
call pm2 save
echo.

echo ===================================================
echo   Application Running!
echo ===================================================
echo.
echo Useful PM2 commands:
echo   To view logs:         pm2 logs cibola-backend
echo   To check status:      pm2 list
echo   To stop the server:   pm2 stop cibola-backend
echo   To restart the server: pm2 restart cibola-backend
echo.
pause
