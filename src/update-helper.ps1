[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Manifest,
    [switch]$Worker
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$ScriptFolder = $null
$HelperScriptPath = $null
$ManifestPath = $null
$ManifestData = $null
$OldPath = $null
$NewPath = $null
$StagePath = $null
$ReadyPath = $null
$StartedPath = $null
$ResultPath = $null
$BackupPath = $null
$AppProcessId = $null
$OldRenamed = $false
$StageMoved = $false
$NewPid = $null
$BackupRetained = $false

function Convert-ToAbsolutePath {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if ([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathRooted($Value)) {
        throw "$Label must be an absolute path"
    }
    return [IO.Path]::GetFullPath($Value)
}

function Assert-SameParent {
    param(
        [Parameter(Mandatory = $true)][string]$BasePath,
        [Parameter(Mandatory = $true)][string]$CandidatePath,
        [Parameter(Mandatory = $true)][string]$Label
    )
    $BaseDirectory = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($BasePath))
    $CandidateDirectory = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($CandidatePath))
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals($BaseDirectory, $CandidateDirectory)) {
        throw "$Label must be in the portable executable directory"
    }
}

function Test-AnyPath {
    param([Parameter(Mandatory = $true)][string]$PathValue)
    return [IO.File]::Exists($PathValue) -or [IO.Directory]::Exists($PathValue)
}

function Remove-OwnFile {
    param([string]$PathValue)
    if ([string]::IsNullOrWhiteSpace($PathValue)) { return }
    try {
        if ([IO.File]::Exists($PathValue)) { [IO.File]::Delete($PathValue) }
    } catch {
        # Cleanup is best effort and is always limited to an exact file path.
    }
}

function Write-UpdateResult {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('success', 'error')][string]$Status,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if ([string]::IsNullOrWhiteSpace($ResultPath)) { return }
    $ResultDirectory = [IO.Path]::GetDirectoryName($ResultPath)
    if (-not [string]::IsNullOrWhiteSpace($ResultDirectory)) {
        [IO.Directory]::CreateDirectory($ResultDirectory) | Out-Null
    }
    $ResultObject = [ordered]@{
        status = $Status
        message = $Message
    }
    if ($null -ne $ManifestData -and $ManifestData.PSObject.Properties['currentVersion']) {
        if (-not [string]::IsNullOrWhiteSpace([string]$ManifestData.currentVersion)) {
            $ResultObject.currentVersion = [string]$ManifestData.currentVersion
        }
    }
    if ($null -ne $ManifestData -and $ManifestData.PSObject.Properties['newVersion']) {
        if (-not [string]::IsNullOrWhiteSpace([string]$ManifestData.newVersion)) {
            $ResultObject.newVersion = [string]$ManifestData.newVersion
        }
    }
    if ($null -ne $NewPid -and [Int64]$NewPid -gt 0) { $ResultObject.newPid = [Int64]$NewPid }
    $ResultJson = $ResultObject | ConvertTo-Json -Compress
    $Utf8 = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText($ResultPath, $ResultJson, $Utf8)
}

function Try-WriteUpdateResult {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('success', 'error')][string]$Status,
        [Parameter(Mandatory = $true)][string]$Message
    )
    try { Write-UpdateResult -Status $Status -Message $Message } catch { }
}

function Test-StagedExecutable {
    if (-not [IO.File]::Exists($StagePath)) { throw 'staged portable update is missing' }
    $StageItem = Get-Item -LiteralPath $StagePath -Force
    if ($StageItem.PSIsContainer -or (($StageItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw 'staged portable update must be a regular file'
    }
    if ([Int64]$StageItem.Length -ne [Int64]$ExpectedSize) {
        throw 'staged portable update has an unexpected size'
    }
    $HashStream = [IO.File]::OpenRead($StagePath)
    $Hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $ActualHash = [BitConverter]::ToString($Hasher.ComputeHash($HashStream)).Replace('-', '').ToLowerInvariant()
    } finally {
        $HashStream.Dispose()
        $Hasher.Dispose()
    }
    if ($ActualHash -ne $ExpectedHash) { throw 'staged portable update SHA-256 does not match release metadata' }
    $HeaderStream = [IO.File]::OpenRead($StagePath)
    try {
        $Header = New-Object byte[] 2
        $ReadCount = $HeaderStream.Read($Header, 0, 2)
    } finally {
        $HeaderStream.Dispose()
    }
    if ($ReadCount -ne 2 -or $Header[0] -ne 0x4d -or $Header[1] -ne 0x5a) {
        throw 'staged portable update is not a Windows executable'
    }
}

function Wait-ForAppExit {
    $Deadline = [DateTime]::UtcNow.AddSeconds(120)
    while ($true) {
        $AppProcess = Get-Process -Id $AppProcessId -ErrorAction SilentlyContinue
        if ($null -eq $AppProcess) { return }
        if ([DateTime]::UtcNow -ge $Deadline) { throw 'portable application did not exit within 120 seconds' }
        Start-Sleep -Milliseconds 250
    }
}

function Rename-OldExecutable {
    $BackupName = '.glyph-studio-old-' + [Guid]::NewGuid().ToString('N') + '.bak'
    $script:BackupPath = [IO.Path]::Combine([IO.Path]::GetDirectoryName($OldPath), $BackupName)
    $Deadline = [DateTime]::UtcNow.AddSeconds(60)
    while ($true) {
        try {
            [IO.File]::Move($OldPath, $BackupPath)
            $script:OldRenamed = $true
            return
        } catch {
            if ([DateTime]::UtcNow -ge $Deadline) { throw 'unable to rename the old portable executable within 60 seconds' }
            Start-Sleep -Milliseconds 500
        }
    }
}

function Restore-OldExecutable {
    if (-not $OldRenamed -or [string]::IsNullOrWhiteSpace($BackupPath)) { return }
    if (-not [IO.File]::Exists($BackupPath)) { return }
    if ([IO.File]::Exists($OldPath)) { return }
    try { [IO.File]::Move($BackupPath, $OldPath) } catch { }
}

function Start-OldExecutable {
    if (-not [IO.File]::Exists($OldPath)) { return }
    $RunningApp = Get-Process -Id $AppProcessId -ErrorAction SilentlyContinue
    if ($null -ne $RunningApp) { return }
    $PriorReadyValue = [Environment]::GetEnvironmentVariable('GLYPH_UPDATE_READY_FILE', 'Process')
    try {
        [Environment]::SetEnvironmentVariable('GLYPH_UPDATE_READY_FILE', $null, 'Process')
        Start-Process -FilePath $OldPath -WorkingDirectory ([IO.Path]::GetDirectoryName($OldPath)) -WindowStyle Hidden -ErrorAction Stop | Out-Null
    } catch {
    } finally {
        [Environment]::SetEnvironmentVariable('GLYPH_UPDATE_READY_FILE', $PriorReadyValue, 'Process')
    }
}

function Convert-HelperErrorMessage {
    param([string]$TechnicalMessage)
    if ([string]::IsNullOrWhiteSpace($TechnicalMessage)) { return '便携版更新失败，请重试' }
    if ($TechnicalMessage -match 'SHA-256|校验') { return '更新文件校验失败，旧程序已保留' }
    if ($TechnicalMessage -match 'Windows executable|Windows 可执行') { return '更新文件不是有效的 Windows 程序，旧程序已保留' }
    if ($TechnicalMessage -match 'exit|launch|handshake|ready|启动|握手') { return '新程序启动失败，已恢复旧程序' }
    if ($TechnicalMessage -match 'did not exit|120 seconds|未退出') { return '旧程序未能及时退出，更新已取消' }
    if ($TechnicalMessage -match 'rename|重命名') { return '旧程序文件被占用，更新已取消' }
    if ($TechnicalMessage -match 'target already exists|目标已存在') { return '官方更新文件已存在，更新已取消' }
    return '便携版更新失败，旧程序已保留'
}

function Try-ReadReadyHandshake {
    try {
        $ReadyText = [IO.File]::ReadAllText($ReadyPath)
        $ReadyData = ConvertFrom-Json -InputObject $ReadyText
        if ($null -eq $ReadyData -or -not $ReadyData.PSObject.Properties['pid'] -or -not $ReadyData.PSObject.Properties['version']) { return $false }
        $CandidatePid = [Int64]$ReadyData.pid
        $ExpectedVersion = [string]$ManifestData.newVersion
        if ($CandidatePid -le 0 -or [string]::IsNullOrWhiteSpace($ExpectedVersion) -or [string]$ReadyData.version -cne $ExpectedVersion) { return $false }
        $script:NewPid = $CandidatePid
        return $true
    } catch {
        return $false
    }
}

function Remove-OldBackup {
    if ([string]::IsNullOrWhiteSpace($BackupPath)) { return $true }
    $Deadline = [DateTime]::UtcNow.AddSeconds(20)
    while ($true) {
        try {
            if (-not [IO.File]::Exists($BackupPath)) { return $true }
            [IO.File]::Delete($BackupPath)
            return $true
        } catch {
            if ([DateTime]::UtcNow -ge $Deadline) { return $false }
            Start-Sleep -Milliseconds 500
        }
    }
}

function Cleanup-HelperFiles {
    Remove-OwnFile -PathValue $Manifest
    Remove-OwnFile -PathValue $HelperScriptPath
    Remove-OwnFile -PathValue $ReadyPath
    Remove-OwnFile -PathValue $StartedPath
    if (-not [string]::IsNullOrWhiteSpace($ScriptFolder)) {
        try { [IO.Directory]::Delete($ScriptFolder, $false) } catch { }
    }
}

function Start-PersistentWorker {
    $SystemRootPath = [Environment]::GetEnvironmentVariable('SystemRoot', 'Process')
    if ([string]::IsNullOrWhiteSpace($SystemRootPath)) { $SystemRootPath = 'C:\Windows' }
    $PowerShellPath = [IO.Path]::Combine($SystemRootPath, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    $HelperArgument = '"' + $HelperScriptPath + '"'
    $ManifestArgument = '"' + $ManifestPath + '"'
    $WorkerArguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $HelperArgument, '-Worker', '-Manifest', $ManifestArgument)
    Start-Process -FilePath $PowerShellPath -ArgumentList $WorkerArguments -WorkingDirectory $ScriptFolder -WindowStyle Hidden -ErrorAction Stop | Out-Null
}

try {
    $ManifestPath = Convert-ToAbsolutePath -Value $Manifest -Label 'manifest'
    $HelperScriptPath = [IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)
    $ScriptFolder = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($HelperScriptPath))
    $ManifestData = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($ManifestPath))
    if ($null -eq $ManifestData) { throw 'update manifest is empty' }

    $OldPath = Convert-ToAbsolutePath -Value ([string]$ManifestData.oldExe) -Label 'oldExe'
    $NewPath = Convert-ToAbsolutePath -Value ([string]$ManifestData.newExe) -Label 'newExe'
    $StageValue = if ($ManifestData.PSObject.Properties['stagePath']) { [string]$ManifestData.stagePath } else { [string]$ManifestData.stagedExe }
    $StagePath = Convert-ToAbsolutePath -Value $StageValue -Label 'stagePath'
    $ReadyPath = Convert-ToAbsolutePath -Value ([string]$ManifestData.readyFile) -Label 'readyFile'
    $StartedPath = if ($ManifestData.PSObject.Properties['startedFile'] -and -not [string]::IsNullOrWhiteSpace([string]$ManifestData.startedFile)) { Convert-ToAbsolutePath -Value ([string]$ManifestData.startedFile) -Label 'startedFile' } else { $null }
    $ResultPath = Convert-ToAbsolutePath -Value ([string]$ManifestData.resultFile) -Label 'resultFile'
    $AppProcessId = [Int64]$ManifestData.pid
    $ExpectedHash = if ($ManifestData.PSObject.Properties['expectedSha256']) { [string]$ManifestData.expectedSha256 } else { [string]$ManifestData.sha256 }
    $ExpectedHash = $ExpectedHash.ToLowerInvariant()
    $ExpectedSize = if ($ManifestData.PSObject.Properties['expectedSize']) { [Int64]$ManifestData.expectedSize } else { [Int64]$ManifestData.size }

    # A direct detached PowerShell process can be discarded by the host when
    # the installer exits. Bootstrap a worker through Start-Process after the
    # manifest is loaded; the worker owns all installation and cleanup work.
    $BootstrapWorker = (-not $Worker) -and $ManifestData.PSObject.Properties['startedFile']
    if ($BootstrapWorker) {
        Start-PersistentWorker
        if (-not [string]::IsNullOrWhiteSpace($StartedPath)) {
            try { [IO.File]::WriteAllText($StartedPath, 'started', [Text.UTF8Encoding]::new($false)) } catch { }
        }
        exit 0
    }

    if (-not [string]::IsNullOrWhiteSpace($StartedPath)) {
        try { [IO.File]::WriteAllText($StartedPath, 'started', [Text.UTF8Encoding]::new($false)) } catch { }
    }

    if ($AppProcessId -le 0) { throw 'pid must be a positive process id' }
    if ($ExpectedSize -le 0 -or $ExpectedSize -gt 262144000) { throw 'update size exceeds the portable update limit' }
    if ($ExpectedHash -notmatch '^[a-f0-9]{64}$') { throw 'update SHA-256 is invalid' }
    if ([IO.Path]::GetFileName($ReadyPath) -cne 'ready') { throw 'readyFile must use the exact filename ready' }
    Assert-SameParent -BasePath $OldPath -CandidatePath $NewPath -Label 'newExe'
    Assert-SameParent -BasePath $OldPath -CandidatePath $StagePath -Label 'stagePath'
    if ([StringComparer]::OrdinalIgnoreCase.Equals($OldPath, $NewPath) -or [StringComparer]::OrdinalIgnoreCase.Equals($OldPath, $StagePath) -or [StringComparer]::OrdinalIgnoreCase.Equals($NewPath, $StagePath)) {
        throw 'portable update paths must be distinct'
    }
    if (-not [IO.File]::Exists($OldPath)) { throw 'oldExe does not exist' }
    $OldItem = Get-Item -LiteralPath $OldPath -Force
    if ($OldItem.PSIsContainer -or (($OldItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'oldExe must be a regular file' }
    if (Test-AnyPath -PathValue $NewPath) { throw 'official update target already exists' }
    Test-StagedExecutable
    Wait-ForAppExit
    if (Test-AnyPath -PathValue $NewPath) { throw 'official update target appeared before installation' }
    [IO.File]::Move($StagePath, $NewPath)
    $script:StageMoved = $true
    Rename-OldExecutable

    if ([IO.File]::Exists($ReadyPath)) { [IO.File]::Delete($ReadyPath) }
    $PriorReadyValue = [Environment]::GetEnvironmentVariable('GLYPH_UPDATE_READY_FILE', 'Process')
    $NewProcess = $null
    try {
        [Environment]::SetEnvironmentVariable('GLYPH_UPDATE_READY_FILE', $ReadyPath, 'Process')
        $NewProcess = Start-Process -FilePath $NewPath -WorkingDirectory ([IO.Path]::GetDirectoryName($NewPath)) -WindowStyle Hidden -PassThru -ErrorAction Stop
    } finally {
        [Environment]::SetEnvironmentVariable('GLYPH_UPDATE_READY_FILE', $PriorReadyValue, 'Process')
    }

    $ReadyDeadline = [DateTime]::UtcNow.AddSeconds(60)
    while ($true) {
        if ([IO.File]::Exists($ReadyPath) -and (Try-ReadReadyHandshake)) { break }
        if ($null -ne $NewProcess) {
            $NewProcess.Refresh()
            if ($NewProcess.HasExited) { throw 'new portable executable exited before ready handshake' }
        }
        if ([DateTime]::UtcNow -ge $ReadyDeadline) { throw 'new portable executable did not complete the ready handshake within 60 seconds' }
        Start-Sleep -Milliseconds 250
    }

    $BackupRemoved = Remove-OldBackup
    if (-not $BackupRemoved) { $script:BackupRetained = $true }
    $SuccessMessage = if ($BackupRetained) { '便携版更新已成功安装，旧程序备份尚未清除' } else { '便携版更新已成功安装' }
    Try-WriteUpdateResult -Status 'success' -Message $SuccessMessage
    Cleanup-HelperFiles
    exit 0
} catch {
    $CaughtError = if ($OldRenamed) { '新程序启动失败，已恢复旧程序' } else { Convert-HelperErrorMessage -TechnicalMessage $_.Exception.Message }
    Restore-OldExecutable
    if ($StageMoved -and -not [string]::IsNullOrWhiteSpace($NewPath)) { Remove-OwnFile -PathValue $NewPath }
    if (-not $StageMoved -and -not [string]::IsNullOrWhiteSpace($StagePath)) { Remove-OwnFile -PathValue $StagePath }
    if (-not [string]::IsNullOrWhiteSpace($ReadyPath)) { Remove-OwnFile -PathValue $ReadyPath }
    Try-WriteUpdateResult -Status 'error' -Message $CaughtError
    Start-OldExecutable
    Cleanup-HelperFiles
    exit 1
}
