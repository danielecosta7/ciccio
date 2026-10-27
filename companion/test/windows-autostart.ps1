# Prova dell'installazione su Windows (CI "Companion Windows" o a mano sul PC):
# setup (doppio clic) -> copie in bin e link ciccio-companion://; install -> copia senza console,
# chiave Run, processo in background, registro; status; stop; avvio come al login; uninstall.
#   powershell -File companion\test\windows-autostart.ps1 dist\companion\ciccio-companion-windows-x64.exe
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path $args[0]).Path
# Cartella con uno spazio, come C:\Users\Nome Cognome: mette alla prova le virgolette.
$env:CICCIO_COMPANION_HOME = Join-Path $env:TEMP 'ciccio companion prova'
Remove-Item -Recurse -Force $env:CICCIO_COMPANION_HOME -ErrorAction SilentlyContinue
$bg = Join-Path $env:CICCIO_COMPANION_HOME 'bin\ciccio-companion-background.exe'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$protoKey = 'HKCU:\Software\Classes\ciccio-companion'
$consoleCopy = Join-Path $env:CICCIO_COMPANION_HOME 'bin\ciccio-companion.exe'
$failed = $false
function Check($cond, $what) {
  if ($cond) { Write-Host "OK  $what" } else { Write-Host "NO  $what"; $script:failed = $true }
}
function Running { @(Get-Process -Name 'ciccio-companion-background' -ErrorAction SilentlyContinue).Count -gt 0 }

# Come il doppio clic sull'.exe scaricato, prima dell'abbinamento.
$out = & $exe setup | Out-String
Write-Host $out
Check ($out -match 'Collega questo PC') 'setup senza token: chiede di collegarlo'
Check (Test-Path $consoleCopy) 'copia con console in bin'
Check (Running) 'setup accende l''icona (anche senza token)'
$open = (Get-ItemProperty "$protoKey\shell\open\command").'(default)'
Write-Host "Link: $open"
Check ($open -eq ('"' + $bg + '" pair "%1"')) 'link ciccio-companion:// verso la copia senza console, virgolette giuste'
& $exe stop | Out-Null
Start-Sleep -Seconds 2
Check ((Get-ItemProperty $protoKey).'URL Protocol' -eq '') 'chiave URL Protocol presente'

# Token finto e Ciccio irraggiungibile: qui conta solo il ciclo di vita del processo.
& $exe init ccp_prova --server http://127.0.0.1:9 | Out-Host
Check ($LASTEXITCODE -eq 0) 'init'

$out = & $exe install | Out-String
Write-Host $out
Check ($out -match 'icona nell''area di notifica \(PID') 'install accende l''icona'
Check (Running) 'processo ciccio-companion-background acceso'

$bytes = [IO.File]::ReadAllBytes($bg)
$pe = [BitConverter]::ToInt32($bytes, 0x3c)
Check ([BitConverter]::ToUInt16($bytes, $pe + 24 + 68) -eq 2) 'copia in background senza console (sottosistema GUI)'

$cmd = (Get-ItemProperty $runKey).CiccioCompanion
Write-Host "Run: $cmd"
Check ($cmd -eq ('"' + $bg + '" tray --config "' + (Join-Path $env:CICCIO_COMPANION_HOME 'config.json') + '"')) 'chiave Run: icona, con le virgolette giuste'

Start-Sleep -Seconds 3
$log = Get-Content (Join-Path $env:CICCIO_COMPANION_HOME 'companion.log') -Raw
Write-Host $log
Check ($log -match 'in background') 'registro scritto'

$status = & $exe status | Out-String
Write-Host $status
Check ($status -match 'Stato: acceso') 'status: acceso'
Check ($status -match 'Avvio automatico: attivo') 'status: avvio automatico attivo'

$out = & $exe stop | Out-String
Check ($out -match 'Companion chiuso') 'stop'
Start-Sleep -Seconds 2
Check (-not (Running)) 'processo chiuso dopo stop'
$orphans = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*chrome-devtools-mcp*' -and $_.Name -ne 'powershell.exe' }).Count
Check ($orphans -eq 0) "nessun server MCP orfano ($orphans)"

# Come all'accesso: Windows esegue il comando scritto nella chiave Run.
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "start `"`" $cmd" -WindowStyle Hidden
$deadline = (Get-Date).AddSeconds(15)
while (-not (Running) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
Check (Running) 'parte dal comando della chiave Run'

$out = & $exe uninstall | Out-String
Write-Host $out
Start-Sleep -Seconds 2
Check (-not (Running)) 'uninstall chiude il companion'
Check ($null -eq (Get-ItemProperty $runKey).CiccioCompanion) 'chiave Run tolta'
Check (-not (Test-Path $bg)) 'copia in background tolta'
Check (-not (Test-Path $protoKey)) 'link ciccio-companion:// tolto'

if ($failed) { Write-Host "`nPROVA FALLITA"; exit 1 }
Write-Host "`nPROVA RIUSCITA"
