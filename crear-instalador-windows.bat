@echo off
chcp 65001 >nul
title Crear instalador de NexoPos
echo ==========================================
echo   Creando el instalador de NexoPos
echo ==========================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo No se encontro Node.js. Instalalo desde https://nodejs.org ^(version LTS^)
  echo y vuelve a ejecutar este archivo.
  pause
  exit /b 1
)
echo [1/2] Descargando dependencias ^(requiere internet, solo esta vez^)...
call npm install
if errorlevel 1 ( echo Error al instalar dependencias. & pause & exit /b 1 )
echo.
echo [2/2] Generando el instalador...
call npm run dist
if errorlevel 1 ( echo Error al generar el instalador. & pause & exit /b 1 )
echo.
echo Listo. El instalador "NexoPos Setup" esta en la carpeta "dist".
start "" "%~dp0dist"
pause
