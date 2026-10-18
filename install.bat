@echo off
cd /d "%~dp0"
echo.
echo ====================================
echo   FrameMe - Install
echo ====================================
echo.
echo Checking Python...
python --version
if errorlevel 1 (
    echo ERROR: Python not found!
    echo Download: https://www.python.org/downloads/
    pause
    exit /b 1
)
echo.
echo Installing dependencies...
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
echo.
echo ====================================
echo Install complete!
echo Run start.bat to launch the tool.
echo ====================================
pause
