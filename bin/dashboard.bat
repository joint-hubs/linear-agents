@echo off
setlocal enabledelayedexpansion

REM ============================================
REM Konfiguracja
REM Single-process: telemetry-server serwuje zbudowane UI z ui/dist na :7331.
REM Tryb deweloperski UI (Vite + HMR): ustaw START_UI=1 i DASHBOARD_URL na :5173.
REM ============================================
set "DASHBOARD_URL=http://localhost:7331"
set "API_PORT=7331"
set "UI_PORT=5173"
set "START_UI=0"
REM ============================================

REM Ustal ROOT repo (jak w _lib.bat)
pushd "%~dp0.." & set "ROOT=!CD!" & popd
cd /d "%ROOT%"

echo ========================================
echo   Fenix Dashboard Launcher
echo ========================================
echo/

REM --- Zbuduj UI jesli brak (ui/dist jest w .gitignore, wiec po swiezym klonie go nie ma) ---
if "%START_UI%"=="0" (
    if not exist "%ROOT%\ui\dist\index.html" (
        echo [INFO] Brak zbudowanego UI - buduje jednorazowo ^(npm --prefix ui run build^)...
        if not exist "%ROOT%\ui\node_modules" (
            echo [INFO] Brak zaleznosci UI - instaluje ^(npm --prefix ui install^)...
            call npm --prefix "%ROOT%\ui" install
        )
        call npm --prefix "%ROOT%\ui" run build
        if not exist "%ROOT%\ui\dist\index.html" (
            echo [BLAD] Build UI nie powiodl sie. Uruchom recznie: npm --prefix ui run build
            exit /b 1
        )
        echo [OK] UI zbudowane.
    )
)

REM --- Sprawdz czy API zyje ---
node -e "fetch('http://localhost:%API_PORT%/api/summary').then(function(){process.exit(0)}).catch(function(){process.exit(1)})" 2>nul
if errorlevel 1 (
    echo [INFO] API na porcie %API_PORT% nie odpowiada - uruchamiam telemetry-server...
    start "" /b node "%ROOT%\scripts\telemetry-server.mjs"
) else (
    echo [OK] API juz dziala na porcie %API_PORT%
)

REM --- Sprawdz czy UI zyje ---
if "%START_UI%"=="1" (
    node -e "fetch('http://localhost:%UI_PORT%').then(function(){process.exit(0)}).catch(function(){process.exit(1)})" 2>nul
    if errorlevel 1 (
        echo [INFO] UI na porcie %UI_PORT% nie odpowiada - uruchamiam Vite...
        start "" /b cmd /c npm --prefix "%ROOT%\ui" run dev
    ) else (
        echo [OK] UI juz dziala na porcie %UI_PORT%
    )
)

REM --- Poll az DASHBOARD_URL odpowie (max ~30s) ---
echo/
echo [INFO] Czekam na gotowosc dashboardu...
set "READY=0"
for /l %%i in (1,1,30) do (
    if "!READY!"=="0" (
        ping -n 2 127.0.0.1 >nul
        node -e "fetch('!DASHBOARD_URL!').then(function(){process.exit(0)}).catch(function(){process.exit(1)})" >nul 2>nul
        if not errorlevel 1 set "READY=1"
    )
)

if "!READY!"=="1" (
    echo [OK] Dashboard gotowy: !DASHBOARD_URL!
    start "" "!DASHBOARD_URL!"
) else (
    echo/
    echo [BLAD] Dashboard nie wystartowal w ciagu 30 sekund.
    echo Sprawdz:
    echo   1. Czy porty %API_PORT% i %UI_PORT% sa wolne?
    echo   2. Czy `npm --prefix ui run dev` dziala recznie?
    echo   3. Logi Vite w oknie konsoli - jesli widoczne.
    exit /b 1
)

endlocal
exit /b 0