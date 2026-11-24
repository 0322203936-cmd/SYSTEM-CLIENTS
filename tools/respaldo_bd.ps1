# Respaldo de la base del portal de facturacion (PostgreSQL de este servidor, base "facturacion", la que usa
# produccion por Hyperdrive desde el 24/11/2026). Lo corre la tarea programada "Facturacion Respaldo"
# (tools/instalar_respaldo.ps1): respaldos\facturacion_AAAAMMDD_HHmm.dump, se guardan los ultimos 14.
# Restaurar uno (con cuidado: reemplaza las tablas de la base facturacion):
#   & 'C:\Program Files\PostgreSQL\18\bin\pg_restore.exe' --clean --if-exists --no-owner --no-privileges --dbname=<LOCAL_DATABASE_URL> <archivo.dump>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Backups = Join-Path $Root 'respaldos'
$Log = Join-Path $Backups 'respaldo.log'
New-Item -ItemType Directory -Force $Backups | Out-Null
function Log($msg) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Add-Content -Path $Log -Encoding utf8 }

$line = Get-Content (Join-Path $Root '.env') | Where-Object { $_ -match '^LOCAL_DATABASE_URL=' } | Select-Object -First 1
if (-not $line) { Log 'No hay LOCAL_DATABASE_URL en .env: sin respaldo'; exit 1 }
$url = $line.Substring('LOCAL_DATABASE_URL='.Length).Trim().Trim('"')
if ($url -notmatch '@(localhost|127\.0\.0\.1)[:/]') { Log 'LOCAL_DATABASE_URL no es la base local: sin respaldo'; exit 0 }

$file = Join-Path $Backups ("facturacion_{0}.dump" -f (Get-Date -Format 'yyyyMMdd_HHmm'))
& 'C:\Program Files\PostgreSQL\18\bin\pg_dump.exe' --format=custom --no-owner --no-privileges --file=$file --dbname=$url
if ($LASTEXITCODE -ne 0) { Log "pg_dump fallo ($LASTEXITCODE)"; Remove-Item $file -ErrorAction SilentlyContinue; exit 1 }
Log ("Respaldo {0} ({1:N1} MB)" -f (Split-Path $file -Leaf), ((Get-Item $file).Length / 1MB))

Get-ChildItem $Backups -Filter 'facturacion_*.dump' | Sort-Object Name -Descending | Select-Object -Skip 14 | Remove-Item
