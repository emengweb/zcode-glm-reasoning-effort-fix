param([switch]$Confirm)
$ErrorActionPreference='Stop'
try {
    if(-not $Confirm){
        [Console]::Error.WriteLine("请先确认操作`n此命令会修改安装文件。阅读 README 后，使用 -Confirm 参数重新运行。`n`n--- English ---`nConfirmation required`nThis command changes the installation file. Review README and run again with -Confirm.")
        exit 2
    }
    $root=Split-Path -Parent $MyInvocation.MyCommand.Path
    $target='C:\Program Files\ZCode\resources\config\provider\zcode-builtin.json'
    & node (Join-Path $root 'patch.mjs') apply $target --confirm
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine("无法启动补丁命令`n请确认 Node.js 已安装且可从当前终端访问。`n`n--- English ---`nUnable to start the patch command`nEnsure Node.js is installed and available in this terminal.`n`n--- Details ---`n$($_.Exception.Message)")
    exit 1
}
