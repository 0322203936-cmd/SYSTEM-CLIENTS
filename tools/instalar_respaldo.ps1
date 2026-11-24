# Tarea programada "Facturacion Respaldo": corre tools/respaldo_bd.ps1 todos los dias a las 2:30 a.m. y 2:30 p.m.
# (media hora despues del respaldo de Reunion 123; si la PC estaba apagada, corre en cuanto prende).
# Se corre una vez, como administrador:
#   powershell -ExecutionPolicy Bypass -File C:\Users\CFBC\Desktop\SYSTEM-CLIENTS\tools\instalar_respaldo.ps1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$name = 'Facturacion Respaldo'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Root\tools\respaldo_bd.ps1`"" -WorkingDirectory $Root
$triggers = @((New-ScheduledTaskTrigger -Daily -At '02:30'), (New-ScheduledTaskTrigger -Daily -At '14:30'))
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $name
Write-Host " Listo: '$name' instalada (2:30 y 14:30, usuario $user); primer respaldo en respaldos\." -ForegroundColor Green
