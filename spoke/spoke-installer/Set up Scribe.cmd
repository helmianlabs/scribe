@echo off
title Scribe setup
cd /d "%~dp0"
echo.
echo  Scribe setup
echo  Type your Scribe passphrase below, then press Enter.
echo  It is used once, inside this setup, and never stored.
echo.
set /p SCRIBE_HANDS_PASSPHRASE= Scribe passphrase: 
set SCRIBE_SPOKE_ROOTS=%USERPROFILE%
"%~dp0node.exe" "%~dp0install-pair.mjs"
set SCRIBE_HANDS_PASSPHRASE=
findstr /c:"\"paired\": true" "%APPDATA%\Scribe\spoke-install-status.json" >nul 2>&1
if %errorlevel%==0 (echo. & echo  Done. This PC is paired with Scribe and starts each time you sign in.) else (echo. & echo  Pairing did not finish. Check the passphrase and run this again.)
echo.
pause
