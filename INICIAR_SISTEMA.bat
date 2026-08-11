@echo off
title Factura Clara
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando dependencias por primera vez...
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo No fue posible instalar las dependencias. Verifica tu conexion a Internet.
    pause
    exit /b 1
  )
)
echo.
if not exist .env copy .env.example .env >nul
echo Iniciando frontend y backend de Factura Clara
echo Sitio: http://localhost:4200  API: http://localhost:3000
echo Presiona Ctrl+C para detener el sistema.
call npm.cmd start
pause
