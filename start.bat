@echo off
cd /d "%~dp0"
echo.
echo Starting FrameMe - Image and Animation Workspace...
echo Open: http://127.0.0.1:7860
echo.
start "" "http://127.0.0.1:7860"
python app.py
pause
