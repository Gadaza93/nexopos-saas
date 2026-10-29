@echo off
chcp 65001 >nul
title Probar NexoPos
where node >nul 2>nul
if errorlevel 1 ( echo Instala Node.js LTS desde https://nodejs.org & pause & exit /b 1 )
if not exist node_modules ( call npm install )
call npm start
