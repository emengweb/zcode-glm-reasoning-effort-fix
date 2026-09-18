param([switch]$Confirm)
$ErrorActionPreference='Stop'
if(-not $Confirm){throw 'This changes the ZCode installation file. Re-run with -Confirm after reviewing README.'}
$root=Split-Path -Parent $MyInvocation.MyCommand.Path
$target='C:\Program Files\ZCode\resources\config\provider\zcode-builtin.json'
node (Join-Path $root 'patch.mjs') apply $target --confirm
