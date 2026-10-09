param(
    [Parameter(Mandatory = $true)][string]$LinuxStudioPath,
    [string]$Distribution = "Ubuntu",
    [string]$LinuxUser = "david"
)
$ErrorActionPreference = "Stop"
$taskName = "MdmediaStudioWSL"
$windowsUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$directory = Join-Path $env:LOCALAPPDATA "MdmediaStudio"
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$launcher = Join-Path $directory "start-wsl.ps1"
Copy-Item (Join-Path $PSScriptRoot "start-wsl.ps1") $launcher -Force
$arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Distribution "{1}" -LinuxUser "{2}" -LinuxStudioPath "{3}"' -f $launcher, $Distribution, $LinuxUser, $LinuxStudioPath
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $arguments -WorkingDirectory $directory
$login = New-ScheduledTaskTrigger -AtLogOn -User $windowsUser
# WSL must launch in the distro owner's interactive Windows logon context.
# Password-free S4U tasks cannot reliably start this user's WSL distribution.
$principal = New-ScheduledTaskPrincipal -UserId $windowsUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $login `
    -Principal $principal -Settings $settings `
    -Description "Start mdmedia Studio in Ubuntu and keep WSL running for tailnet access." -Force | Out-Null
Write-Output "Installed $taskName for $windowsUser (at Windows sign-in)."
