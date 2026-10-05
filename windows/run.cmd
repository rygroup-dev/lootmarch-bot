@echo off
rem Keeps the bot running; restarts it 10 s after a crash. Exit code 3 = already running.
cd /d "%~dp0.."
:loop
node src\index.js >> bot.log 2>&1
if %errorlevel%==3 goto :eof
ping -n 11 127.0.0.1 >nul
goto loop
