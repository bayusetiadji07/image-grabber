@echo off
setlocal enabledelayedexpansion
title Image Grabber

rem Pindah ke folder tempat berkas ini berada, apa pun lokasinya di komputer mana pun.
cd /d "%~dp0"

echo.
echo   ============================================
echo     Image Grabber
echo   ============================================
echo.
echo   Folder : %CD%
echo.

if not exist "server.js" (
  echo   [GAGAL] Berkas server.js tidak ada di folder ini.
  echo   Pastikan seluruh isi folder image-grabber ikut disalin,
  echo   bukan hanya jalankan.cmd saja.
  echo.
  pause
  exit /b 1
)

rem ---- Cari Node.js: PATH dulu, lalu lokasi pemasangan yang umum, lalu node portabel di folder ini.
set "NODE_EXE="
for /f "delims=" %%N in ('where node 2^>nul') do (
  if not defined NODE_EXE set "NODE_EXE=%%N"
)
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\nodejs\node.exe"
if not defined NODE_EXE if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"
if not defined NODE_EXE if exist "%~dp0node.exe" set "NODE_EXE=%~dp0node.exe"

if not defined NODE_EXE (
  echo   [GAGAL] Node.js belum terpasang di komputer ini.
  echo.
  echo   Aplikasi ini butuh Node.js versi 18 atau lebih baru.
  echo   Unduh yang berlabel LTS di:  https://nodejs.org
  echo   Saat memasang, biarkan pilihan "Add to PATH" tetap tercentang,
  echo   lalu TUTUP jendela ini dan jalankan lagi jalankan.cmd.
  echo.
  echo   Alternatif tanpa memasang: salin node.exe portabel ke folder ini.
  echo.
  pause
  exit /b 1
)

echo   Node   : %NODE_EXE%
for /f "delims=" %%V in ('"%NODE_EXE%" -v 2^>nul') do echo   Versi  : %%V
echo.
echo   Menyalakan server... browser akan terbuka sendiri.
echo   Biarkan jendela ini terbuka selama aplikasi dipakai.
echo   Tekan Ctrl+C untuk menghentikan.
echo.

set "IG_OPEN=1"
"%NODE_EXE%" server.js
set "KODE=%ERRORLEVEL%"

echo.
if not "%KODE%"=="0" (
  echo   [GAGAL] Server berhenti dengan kode %KODE%. Pesan galatnya ada di atas.
) else (
  echo   Server dihentikan.
)
echo.
pause
