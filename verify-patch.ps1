$ErrorActionPreference='Stop'
try {
    $root=Split-Path -Parent $MyInvocation.MyCommand.Path
    & node (Join-Path $root 'patch.mjs') check
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine("无法启动检查命令`n请确认 Node.js 已安装且可从当前终端访问。`n`n--- English ---`nUnable to start the verification command`nEnsure Node.js is installed and available in this terminal.`n`n--- Details ---`n$($_.Exception.Message)")
    exit 1
}
