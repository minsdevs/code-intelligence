$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:GITHUB_EVENT_NAME -notin @('workflow_dispatch', 'pull_request') -or $env:NATIVE_ACCEPTANCE_CONSENT -ne 'disposable-hosted-os') { throw 'Disposable hosted workflow required' }
$trustedEvent = @{}
if ($env:GITHUB_EVENT_NAME -eq 'pull_request') {
    $event = Get-Content -Raw -LiteralPath $env:GITHUB_EVENT_PATH | ConvertFrom-Json
    if (-not $env:GITHUB_REPOSITORY -or $event.pull_request.head.repo.full_name -cne $env:GITHUB_REPOSITORY -or $event.pull_request.base.repo.full_name -cne $env:GITHUB_REPOSITORY) { throw 'Untrusted pull request refused' }
    $trustedEvent = @{ pull_request = @{ head = @{ repo = @{ full_name = $env:GITHUB_REPOSITORY } }; base = @{ repo = @{ full_name = $env:GITHUB_REPOSITORY } } } }
}
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 required' }
$artifacts = Join-Path $env:RUNNER_TEMP 'native-acceptance-artifacts'
New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Provisioning requires the hosted administrative runner token; acceptance never uses it' }
$name = 'ciaccept' + [Guid]::NewGuid().ToString('N').Substring(0, 10)
$password = 'Aa1!' + [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
Write-Output "::add-mask::$password"
$securePassword = ConvertTo-SecureString $password -AsPlainText -Force
$private = Join-Path 'C:\' ('native-acceptance-' + [Guid]::NewGuid().ToString('N'))
$taskName = $name + '-native'
$node = (Get-Command node.exe).Source
$pwsh = (Get-Command pwsh.exe).Source
$cmake = (Get-Command cmake.exe).Source
$phase = 'standard-user-provisioning'
try {
    $user = New-LocalUser -Name $name -Password $securePassword -AccountNeverExpires -PasswordNeverExpires -Description 'Disposable native acceptance only'
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $user
    $sid = $user.SID.Value
    # Task Scheduler's XML principal must not rely on the .\ account alias.
    # Resolve the fresh SAM identity both ways before supplying its password.
    $account = $user.SID.Translate([Security.Principal.NTAccount]).Value
    $accountSid = [Security.Principal.NTAccount]::new($account).Translate([Security.Principal.SecurityIdentifier]).Value
    if ($accountSid -ne $sid -or $account -ine "$env:COMPUTERNAME\$name") { throw 'Fresh local account resolution failed' }
    if (Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object { $_.SID.Value -eq $sid }) { throw 'Administrative acceptance account rejected' }
    New-Item -ItemType Directory -Path $private | Out-Null
    # This is a fresh CI-only directory, never an installed app or existing user profile.
    & icacls.exe $private /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Private NTFS ACL provisioning failed' }
    # The managed-process test requires protected executable ancestors. Do not rely
    # on broad hosted-toolcache ACLs or modify the runner's installed Node tree.
    $privateNode = Join-Path $private 'node-runtime'
    Copy-Item -LiteralPath (Split-Path -Parent $node) -Destination $privateNode -Recurse
    $node = Join-Path $privateNode 'node.exe'
    & icacls.exe $private /setowner '*S-1-5-32-544' /T /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Private tool ownership provisioning failed' }
    # Checkout contains only repository data: no checkout token is persisted by the workflow.
    & icacls.exe $env:GITHUB_WORKSPACE /grant "*${sid}:(OI)(CI)RX" /T /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Read-only source access failed' }
    $trustedEvent | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $private 'event.json') -Encoding utf8
    $config = @{
        GITHUB_ACTIONS = 'true'; RUNNER_ENVIRONMENT = 'github-hosted'; GITHUB_EVENT_NAME = $env:GITHUB_EVENT_NAME;
        GITHUB_REPOSITORY = $env:GITHUB_REPOSITORY; GITHUB_EVENT_PATH = (Join-Path $private 'event.json');
        NATIVE_ACCEPTANCE_CONSENT = 'disposable-hosted-os'; GITHUB_SHA = $env:GITHUB_SHA;
        GITHUB_WORKSPACE = $env:GITHUB_WORKSPACE; RUNNER_TEMP = $private;
        CODE_INTELLIGENCE_BUILD_SEQUENCE = $env:CODE_INTELLIGENCE_BUILD_SEQUENCE;
        NATIVE_ACCEPTANCE_CMAKE = $cmake; PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';
        NATIVE_ACCEPTANCE_EXPECTED_SID = $sid;
        PATH = (Join-Path $private 'node-runtime') + ';' + $env:PATH
    }
    $config | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $private 'environment.json') -Encoding utf8
    $childScript = @'
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = $PSScriptRoot
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Elevated acceptance token rejected' }
    if ($identity.User.Value -in @('S-1-5-18', 'S-1-5-19', 'S-1-5-20')) { throw 'Service-account acceptance token rejected' }
    $config = Get-Content -Raw (Join-Path $root 'environment.json') | ConvertFrom-Json -AsHashtable
    if ($identity.User.Value -ne $config.NATIVE_ACCEPTANCE_EXPECTED_SID) { throw 'Unexpected acceptance identity rejected' }
    if ($identity.Groups.Value -contains 'S-1-5-32-544') { throw 'Administrative group acceptance token rejected' }
    foreach ($key in $config.Keys) { [Environment]::SetEnvironmentVariable($key, [string]$config[$key], 'Process') }
    New-Item -ItemType Directory -Path (Join-Path $root 'native-acceptance-artifacts') -Force | Out-Null
    @{ elevated = $false; serviceAccount = $false; freshLocalUser = $true } | ConvertTo-Json | Set-Content (Join-Path $root 'native-acceptance-artifacts/token.json')
    & '__NODE__' (Join-Path $env:GITHUB_WORKSPACE 'desktop/scripts/native-acceptance.cjs') windows *> (Join-Path $root 'private-run.log')
    $code = $LASTEXITCODE
} catch { $code = 1 }
[IO.File]::WriteAllText((Join-Path $root 'exit-code'), [string]$code)
exit $code
'@
    $childScript.Replace('__NODE__', $node.Replace("'", "''")) | Set-Content -LiteralPath (Join-Path $private 'run.ps1') -Encoding utf8
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoLogo -NoProfile -NonInteractive -File `"$private\run.ps1`"" -WorkingDirectory $private
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 38) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $phase = 'standard-user-task-registration'
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Password -RunLevel Limited
    $task = New-ScheduledTask -Action $action -Settings $settings -Principal $taskPrincipal
    Register-ScheduledTask -TaskName $taskName -InputObject $task -User $account -Password $password -Force | Out-Null
    $registered = (Get-ScheduledTask -TaskName $taskName).Principal
    $registeredSid = if ($registered.UserId -match '^S-1-') { $registered.UserId } else { [Security.Principal.NTAccount]::new($registered.UserId).Translate([Security.Principal.SecurityIdentifier]).Value }
    if ($registeredSid -ne $sid -or $registered.RunLevel -ne 'Limited' -or $registered.LogonType -ne 'Password') { throw 'Task must use the fresh password-authenticated standard-user principal' }
    $phase = 'standard-user-task-execution'
    $requestedAt = Get-Date
    Start-ScheduledTask -TaskName $taskName
    $deadline = [DateTime]::UtcNow.AddMinutes(39)
    while (-not (Test-Path (Join-Path $private 'exit-code'))) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Standard-user acceptance timed out' }
        Start-Sleep -Seconds 2
        $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName
        $taskState = (Get-ScheduledTask -TaskName $taskName).State
        if ($taskState -notin @('Running', 'Queued') -and $taskInfo.LastRunTime -ge $requestedAt.AddSeconds(-1) -and -not (Test-Path (Join-Path $private 'exit-code'))) {
            throw 'Standard-user task exited without its completion marker'
        }
    }
    $code = [int](Get-Content -Raw (Join-Path $private 'exit-code'))
    if ($code -ne 0) { throw 'NATIVE_ACCEPTANCE_FAILED: inspect acceptance.json and windows-native.json' }
    @{ status = 'PASS'; phase = $phase; code = 'STANDARD_USER_RUN_COMPLETED' } | ConvertTo-Json | Set-Content (Join-Path $artifacts 'provisioning.json')
} catch {
    $lastResult = $null
    $failedTask = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
    if ($failedTask) { $lastResult = [long]$failedTask.LastTaskResult }
    @{ status = 'FAIL'; phase = $phase; code = 'WINDOWS_NATIVE_ACCEPTANCE_LAUNCH_OR_CHECK_FAILED'; hresult = [int]$_.Exception.HResult; lastTaskResult = $lastResult } | ConvertTo-Json | Set-Content (Join-Path $artifacts 'provisioning.json')
    throw
} finally {
    if (Test-Path (Join-Path $private 'native-acceptance-artifacts')) {
        # Only these explicit report names can cross the private account boundary.
        foreach ($file in @('acceptance.json', 'token.json', 'windows-native.json', 'windows-native-build.log', 'windows-safe-storage.json')) {
            $candidate = Join-Path $private "native-acceptance-artifacts/$file"
            if (Test-Path -LiteralPath $candidate) { Copy-Item -LiteralPath $candidate -Destination $artifacts }
        }
    }
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    # Removing this test account does not mutate any pre-existing user or credential store.
    Remove-LocalUser -Name $name -ErrorAction SilentlyContinue
    $password = $null; $securePassword = $null
}
