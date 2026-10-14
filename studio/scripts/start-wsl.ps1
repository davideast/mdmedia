param(
    [Parameter(Mandatory = $true)][string]$LinuxStudioPath,
    [string]$Distribution = "Ubuntu",
    [string]$LinuxUser = "david"
)
$ErrorActionPreference = "Stop"
$directory = Join-Path $env:LOCALAPPDATA "MdmediaStudio"
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$log = Join-Path $directory "startup.log"
"$(Get-Date -Format o) Starting Studio WSL keepalive" | Out-File -FilePath $log -Append
& "$env:SystemRoot\System32\wsl.exe" --distribution $Distribution --user $LinuxUser `
    --exec /bin/bash "$LinuxStudioPath/scripts/keep-wsl-alive.sh" >> $log 2>&1
$result = $LASTEXITCODE
"$(Get-Date -Format o) WSL exited with code $result" | Out-File -FilePath $log -Append
exit $result
