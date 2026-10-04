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
$child = $null
$credential = $null
$outcome = 'STANDARD_USER_PROVISIONING_FAILED'
$childPhase = $null
$childHresult = $null
$childWin32Error = $null
$node = (Get-Command node.exe).Source
$pwsh = (Get-Command pwsh.exe).Source
$cmake = (Get-Command cmake.exe).Source
$phase = 'standard-user-provisioning'
try {
    $user = New-LocalUser -Name $name -Password $securePassword -AccountNeverExpires -PasswordNeverExpires -Description 'Disposable native acceptance only'
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $user
    $sid = $user.SID.Value
    # Resolve the fresh SAM identity both ways before password-authenticated logon.
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
        JAVA_HOME = $env:JAVA_HOME;
        NATIVE_ACCEPTANCE_EXPECTED_SID = $sid; NATIVE_ACCEPTANCE_PARENT_PROFILE = $env:USERPROFILE;
        PATH = (Join-Path $private 'node-runtime') + ';' + $env:PATH
    }
    $config | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $private 'environment.json') -Encoding utf8
    $childScript = @'
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = $PSScriptRoot
$phase = 'child-token'
$code = 1
try {
    [IO.File]::WriteAllText((Join-Path $root 'child-started'), [string]$PID)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Elevated acceptance token rejected' }
    if ($identity.User.Value -in @('S-1-5-18', 'S-1-5-19', 'S-1-5-20')) { throw 'Service-account acceptance token rejected' }
    $config = Get-Content -Raw (Join-Path $root 'environment.json') | ConvertFrom-Json -AsHashtable
    if ($identity.User.Value -ne $config.NATIVE_ACCEPTANCE_EXPECTED_SID) { throw 'Unexpected acceptance identity rejected' }
    if ($identity.Groups.Value -contains 'S-1-5-32-544') { throw 'Administrative group acceptance token rejected' }
    $env:TEMP = Join-Path $root 'bootstrap-temp'; $env:TMP = $env:TEMP
    New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
    Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class AcceptanceToken {
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr token, int informationClass, out uint value, uint length, out uint returned);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetUserProfileDirectory(IntPtr token, StringBuilder directory, ref uint length);
    public static void RequireNotElevated(IntPtr token) {
        uint elevated, returned;
        if (!GetTokenInformation(token, 20, out elevated, 4, out returned)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (returned != 4 || elevated != 0) throw new InvalidOperationException("Nonstandard token rejected");
    }
    public static string Profile(IntPtr token) {
        uint length = 32768;
        var directory = new StringBuilder((int)length);
        if (!GetUserProfileDirectory(token, directory, ref length)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return directory.ToString();
    }
}
"@
    [AcceptanceToken]::RequireNotElevated($identity.Token)
    $phase = 'child-profile'
    $profile = [AcceptanceToken]::Profile($identity.Token)
    $registeredProfile = (Get-ItemProperty -LiteralPath ("Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\" + $identity.User.Value)).ProfileImagePath
    if (-not [IO.Path]::IsPathFullyQualified($profile) -or $profile -ine [Environment]::ExpandEnvironmentVariables($registeredProfile) -or $profile -ieq $config.NATIVE_ACCEPTANCE_PARENT_PROFILE) { throw 'Fresh profile required' }
    if (-not (Test-Path -LiteralPath ("Registry::HKEY_USERS\" + $identity.User.Value)) -or -not (Test-Path -LiteralPath $profile -PathType Container)) { throw 'Loaded user profile required' }
    # Alternate-credential processes can inherit runner environment variables. Keep
    # only OS/tool discovery, then derive all user paths from this token's profile.
    foreach ($key in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
        if ($key -notmatch '^(SystemRoot|windir|ProgramFiles(\(x86\))?|ProgramW6432|ProgramData|ALLUSERSPROFILE|COMSPEC|PATHEXT|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|COMPUTERNAME)$') {
            [Environment]::SetEnvironmentVariable($key, $null, 'Process')
        }
    }
    $env:USERPROFILE = $profile
    $env:HOMEDRIVE = [IO.Path]::GetPathRoot($profile).TrimEnd('\')
    $env:HOMEPATH = $profile.Substring($env:HOMEDRIVE.Length)
    $env:HOME = $profile
    $env:USERNAME = $identity.Name.Split('\')[-1]
    $env:USERDOMAIN = $identity.Name.Split('\')[0]
    $env:APPDATA = [Environment]::GetFolderPath('ApplicationData')
    $env:LOCALAPPDATA = [Environment]::GetFolderPath('LocalApplicationData')
    foreach ($folder in @($env:APPDATA, $env:LOCALAPPDATA)) {
        if (-not $folder.StartsWith($profile + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Foreign user shell folder rejected' }
    }
    $env:TEMP = Join-Path $env:LOCALAPPDATA 'Temp'; $env:TMP = $env:TEMP
    New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
    foreach ($key in $config.Keys) { [Environment]::SetEnvironmentVariable($key, [string]$config[$key], 'Process') }
    $phase = 'child-dpapi'
    $probe = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
    $cipher = $null; $plain = $null
    try {
        $cipher = [Security.Cryptography.ProtectedData]::Protect($probe, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $plain = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        if ($plain.Length -ne $probe.Length) { throw 'CurrentUser DPAPI failed' }
        $difference = 0
        for ($index = 0; $index -lt $probe.Length; $index++) { $difference = $difference -bor ($probe[$index] -bxor $plain[$index]) }
        if ($difference -ne 0) { throw 'CurrentUser DPAPI failed' }
    } finally {
        [Array]::Clear($probe, 0, $probe.Length)
        if ($cipher) { [Array]::Clear($cipher, 0, $cipher.Length) }
        if ($plain) { [Array]::Clear($plain, 0, $plain.Length) }
    }
    New-Item -ItemType Directory -Path (Join-Path $root 'native-acceptance-artifacts') -Force | Out-Null
    @{ elevated = $false; serviceAccount = $false; freshLocalUser = $true; exactSid = $true; administratorGroup = $false; profileLoaded = $true; currentUserDpapi = $true } | ConvertTo-Json | Set-Content (Join-Path $root 'native-acceptance-artifacts/token.json')
    [IO.File]::WriteAllText((Join-Path $root 'child-ready.pending'), [string]$PID)
    [IO.File]::Move((Join-Path $root 'child-ready.pending'), (Join-Path $root 'child-ready'))
    $phase = 'child-acceptance'
    & '__NODE__' (Join-Path $env:GITHUB_WORKSPACE 'desktop/scripts/native-acceptance.cjs') windows *> (Join-Path $root 'private-run.log')
    $code = $LASTEXITCODE
} catch {
    $failure = $_.Exception
    $nativeError = $null
    while ($failure) {
        if ($failure -is [ComponentModel.Win32Exception]) { $nativeError = [int]$failure.NativeErrorCode; break }
        $failure = $failure.InnerException
    }
    @{ phase = $phase; hresult = [int]$_.Exception.HResult; win32Error = $nativeError } | ConvertTo-Json | Set-Content (Join-Path $root 'child-failure.json')
}
[IO.File]::WriteAllText((Join-Path $root 'exit-code'), [string]$code)
exit $code
'@
    $childScript.Replace('__NODE__', $node.Replace("'", "''")) | Set-Content -LiteralPath (Join-Path $private 'run.ps1') -Encoding utf8
    $credential = [Management.Automation.PSCredential]::new($account, $securePassword)
    $phase = 'standard-user-process-startup'
    $outcome = 'STANDARD_USER_LOGON_FAILED'
    $startup = [Diagnostics.Stopwatch]::StartNew()
    # Password logon loads a real fresh-user profile (and hence CurrentUser DPAPI).
    # No scheduler, S4U, elevated fallback, inherited runner token or current-user credentials.
    $child = Start-Process -FilePath $pwsh -Credential $credential -LoadUserProfile -PassThru -WorkingDirectory $private -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', ('"' + $private + '\run.ps1"')) -RedirectStandardOutput (Join-Path $private 'private-launch.stdout.log') -RedirectStandardError (Join-Path $private 'private-launch.stderr.log')
    $outcome = 'STANDARD_USER_STARTUP_EXITED'
    $ready = Join-Path $private 'child-ready'
    while (-not (Test-Path -LiteralPath $ready)) {
        if ($child.HasExited) { throw 'Standard-user child exited before readiness' }
        if ($startup.Elapsed.TotalSeconds -ge 120) { $outcome = 'STANDARD_USER_STARTUP_TIMEOUT'; throw 'Standard-user child startup deadline exceeded' }
        Start-Sleep -Milliseconds 200
    }
    if ($startup.Elapsed.TotalSeconds -ge 120) { $outcome = 'STANDARD_USER_STARTUP_TIMEOUT'; throw 'Standard-user child startup deadline exceeded' }
    if ([int](Get-Content -Raw -LiteralPath $ready) -ne $child.Id -or [int](Get-Content -Raw -LiteralPath (Join-Path $private 'child-started')) -ne $child.Id) { $outcome = 'STANDARD_USER_PROCESS_IDENTITY_FAILED'; throw 'Unexpected child marker' }
    $phase = 'standard-user-process-execution'
    $outcome = 'STANDARD_USER_EXECUTION_TIMEOUT'
    if (-not $child.WaitForExit(38 * 60 * 1000)) { throw 'Standard-user acceptance deadline exceeded' }
    $outcome = 'STANDARD_USER_COMPLETION_MISSING'
    if (-not (Test-Path -LiteralPath (Join-Path $private 'exit-code'))) { throw 'Standard-user completion missing' }
    $code = [int](Get-Content -Raw -LiteralPath (Join-Path $private 'exit-code'))
    $outcome = 'STANDARD_USER_ACCEPTANCE_FAILED'
    if ($code -ne 0 -or $child.ExitCode -ne 0) { throw 'Standard-user acceptance failed' }
    @{ status = 'PASS'; phase = $phase; code = 'STANDARD_USER_RUN_COMPLETED'; processExitCode = $child.ExitCode } | ConvertTo-Json | Set-Content (Join-Path $artifacts 'provisioning.json')
} catch {
    $failure = $_.Exception; $hresult = [int]$failure.HResult; $win32Error = $null
    while ($failure) {
        if ($failure -is [ComponentModel.Win32Exception]) { $win32Error = [int]$failure.NativeErrorCode; break }
        $failure = $failure.InnerException
    }
    $processExitCode = $null
    if ($child -and $child.HasExited) { $processExitCode = $child.ExitCode }
    $diagnostic = Join-Path $private 'child-failure.json'
    if (Test-Path -LiteralPath $diagnostic) {
        try {
            $details = Get-Content -Raw -LiteralPath $diagnostic | ConvertFrom-Json
            if ($details.phase -cin @('child-token', 'child-profile', 'child-dpapi', 'child-acceptance')) { $childPhase = $details.phase }
            $childHresult = [int]$details.hresult
            if ($null -ne $details.win32Error) { $childWin32Error = [int]$details.win32Error }
        } catch { $childPhase = 'child-diagnostic-invalid'; $childHresult = $null; $childWin32Error = $null }
    }
    @{ status = 'FAIL'; phase = $phase; code = $outcome; hresult = $hresult; win32Error = $win32Error; processExitCode = $processExitCode; childPhase = $childPhase; childHresult = $childHresult; childWin32Error = $childWin32Error } | ConvertTo-Json | Set-Content (Join-Path $artifacts 'provisioning.json')
    # Do not rethrow a credential/process exception with raw runtime paths or arguments.
    throw 'WINDOWS_NATIVE_ACCEPTANCE_FAILED: inspect allowlisted reports'
} finally {
    if ($child) {
        # Only this retained process handle is terminated. Descendants are not
        # guessed from PID trees; disposable hosted-VM teardown owns final cleanup.
        try {
            if (-not $child.HasExited) {
                $child.Kill()
                if (-not $child.WaitForExit(10000)) { throw 'Owned root exit unconfirmed' }
            }
        } catch {
            Write-Warning 'OWNED_ROOT_CLEANUP_UNCONFIRMED: disposable hosted VM teardown required'
        } finally { $child.Dispose() }
    }
    if (Test-Path (Join-Path $private 'native-acceptance-artifacts')) {
        # Only these explicit report names can cross the private account boundary.
        foreach ($file in @('acceptance.json', 'token.json', 'windows-native.json', 'windows-native-build.log', 'windows-safe-storage.json')) {
            $candidate = Join-Path $private "native-acceptance-artifacts/$file"
            if (Test-Path -LiteralPath $candidate) { Copy-Item -LiteralPath $candidate -Destination $artifacts }
        }
    }
    # Removing this test account does not mutate any pre-existing user or credential store.
    Remove-LocalUser -Name $name -ErrorAction SilentlyContinue
    $credential = $null; $password = $null
    if ($securePassword) { $securePassword.Dispose(); $securePassword = $null }
}
