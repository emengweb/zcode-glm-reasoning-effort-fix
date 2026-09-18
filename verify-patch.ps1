$ErrorActionPreference='Stop'
$root=Split-Path -Parent $MyInvocation.MyCommand.Path
node (Join-Path $root 'patch.mjs') check
