@echo off
rem Windows launcher for the e2e fake agent (scripts/fake-agent.sh), which is
rem bash. Runs it with Git for Windows' own bash, not a bare `bash`, which on
rem Windows is System32's WSL launcher. Registered by scripts/e2e-seed.mjs.
setlocal
set "GITBASH=%ProgramFiles%\Git\bin\bash.exe"
if not exist "%GITBASH%" for /f "delims=" %%G in ('where git.exe') do if not exist "%GITBASH%" set "GITBASH=%%~dpG..\bin\bash.exe"
"%GITBASH%" "%~dp0fake-agent.sh" %*
