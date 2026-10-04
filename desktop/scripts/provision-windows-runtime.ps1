[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess) { throw 'Windows x64 required' }
$Destination = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $Destination) { throw 'Supply destination must be fresh' }
$Parent = Split-Path -Parent $Destination
if (-not (Test-Path -LiteralPath $Parent -PathType Container)) { throw 'Supply parent does not exist' }
# Provision only inside a freshly created private build parent; never change an existing ACL.
$Private = Join-Path $Parent ('windows-supply-build-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($Private) | Out-Null
$Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$Acl = New-Object Security.AccessControl.DirectorySecurity
$Acl.SetAccessRuleProtection($true,$false)
$Acl.SetOwner($Sid)
foreach ($Identity in @($Sid, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
  $Rule = New-Object Security.AccessControl.FileSystemAccessRule($Identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $Acl.AddAccessRule($Rule)
}
Set-Acl -LiteralPath $Private -AclObject $Acl
$VsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $VsWhere -PathType Leaf)) { throw 'MSVC x64 Build Tools with CMake are required' }
$Vs = & $VsWhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $Vs) { throw 'MSVC x64 toolchain unavailable' }
$DevShell = Join-Path $Vs 'Common7\Tools\Launch-VsDevShell.ps1'
& $DevShell -Arch amd64 -HostArch amd64 -SkipAutomaticLocation | Out-Null
if (-not (Get-Command nmake.exe -ErrorAction SilentlyContinue)) { throw 'MSVC environment was not initialized' }
$Build = Join-Path $Private 'supply'
& node (Join-Path $PSScriptRoot 'provision-windows-runtime.cjs') $Build
if ($LASTEXITCODE -ne 0) { throw 'Windows supply preparation failed; retained private evidence' }
# Publication is namespace placement of rebuildable output, not a durable user-data commit.
Move-Item -LiteralPath $Build -Destination $Destination
# Absolute build paths must reflect the published supply root.
$Metadata = Get-Content -Raw -LiteralPath (Join-Path $Destination 'supply.json') | ConvertFrom-Json
$Metadata.jdk = Join-Path $Destination 'jdk'
$Metadata.runtime = Join-Path $Destination 'runtime'
[IO.File]::WriteAllText((Join-Path $Destination 'supply.json'),($Metadata | ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
Write-Output ('CODE_INTELLIGENCE_WINDOWS_SUPPLY=' + $Destination)
