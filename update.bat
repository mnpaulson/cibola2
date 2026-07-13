@echo off
setlocal

echo ============================================
echo  Cibola2 Backend - Update from GitHub
echo ============================================
echo.

:: --- Backup .env ---
if exist .env (
    copy /Y .env .env.bak >nul
    echo [OK] Backed up .env to .env.bak
) else (
    echo [WARN] No .env file found - skipping backup
)

:: --- Check this is a git repo ---
if not exist .git (
    echo.
    echo [ERROR] This folder is not a git repository.
    echo.
    echo To fix this, run the following commands once on this machine:
    echo   git init
    echo   git remote add origin https://github.com/YOUR_ORG/cibola2.git
    echo   git fetch origin
    echo   git checkout -b main --track origin/main
    echo.
    pause
    exit /b 1
)

:: --- Pull latest from GitHub ---
echo.
echo [INFO] Pulling latest changes from GitHub...
git pull

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] git pull failed. Restoring .env from backup...
    if exist .env.bak copy /Y .env.bak .env >nul
    echo [INFO] .env restored. Please resolve any git issues and try again.
    pause
    exit /b 1
)

:: --- Restore .env (in case git somehow touched it) ---
if exist .env.bak (
    copy /Y .env.bak .env >nul
    echo [OK] .env restored from backup
)

:: --- Install/update dependencies ---
echo.
echo [INFO] Updating node_modules...
call npm install

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] npm install failed. Check the output above for details.
    pause
    exit /b 1
)

:: --- Restart via PM2 ---
echo.
echo [INFO] Restarting server via PM2...
call pm2 restart cibola-backend >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [INFO] Process not found in PM2, starting fresh...
    call pm2 start src/index.js --name "cibola-backend"
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Failed to start via PM2. Start the server manually.
        pause
        exit /b 1
    )
    call pm2 save
)

echo.
echo ============================================
echo  Update complete! Server is running.
echo ============================================
echo.
echo  pm2 logs cibola-backend   - view logs
echo  pm2 list                  - check status
echo.
pause
