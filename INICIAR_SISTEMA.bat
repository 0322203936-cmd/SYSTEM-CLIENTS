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
echo Verificando que los puertos 3000 y 4200 esten disponibles...
powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 3000,4200 -State Listen -ErrorAction SilentlyContinue) { exit 1 }"
if errorlevel 1 (
  echo.
  echo Ya hay otra instancia usando el puerto 3000 o 4200.
  echo Cierra la ventana anterior del sistema y vuelve a ejecutar este archivo.
  pause
  exit /b 1
)
echo Iniciando la fuente local actual, sincronizada con Oracle.
echo Sitio: http://localhost:4200
echo API:   http://localhost:3000
start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command "$ProgressPreference='SilentlyContinue'; $healthUrl='http://localhost:4200/'; for ($attempt=0; $attempt -lt 120; $attempt++) { try { $response=Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2; if ($response.StatusCode -eq 200) { $previewUrl=$healthUrl + '?local_preview=' + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); Start-Process $previewUrl; exit 0 } } catch {}; Start-Sleep -Seconds 1 }"
echo El navegador se abrira automaticamente cuando el sistema este listo.
echo Presiona Ctrl+C para detener el sistema.
call npm.cmd start
pause
