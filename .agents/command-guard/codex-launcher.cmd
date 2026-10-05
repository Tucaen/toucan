@echo off
rem Toucan's CODEX_PATH on Windows: codex-acp runs `"<this file>" app-server` through cmd.exe.
rem ELECTRON_RUN_AS_NODE makes Toucan's own binary run the launcher as Node; the launcher removes
rem it again before it starts Codex (AGENTS.md, #226).
setlocal
set ELECTRON_RUN_AS_NODE=1
"%TOUCAN_CODEX_RUNTIME%" "%~dp0codex-launcher.mjs" %*
exit /b %ERRORLEVEL%
