$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$files = Get-ChildItem -LiteralPath (Join-Path $root 'packages') -Recurse -Filter *.ts -File |
  Where-Object { $_.FullName -notmatch 'node_modules|\\dist\\' }
Write-Output "SCANNING $($files.Count) files under $root"

foreach ($iface in @('IVault', 'IDeviceIdentity', 'IInteropChecker')) {
  Write-Output "=== $iface ==="

  Write-Output '--- implements ---'
  $impl = $files | Select-String -Pattern "implements\s+$iface\b"
  if ($impl) {
    $impl | ForEach-Object { "$($_.Path):$($_.LineNumber): $($_.Line.Trim())" }
  } else {
    '(0 match)'
  }

  Write-Output '--- class ---'
  $cls = $files | Select-String -Pattern "class\s+\w*$iface\w*"
  if ($cls) {
    $cls | ForEach-Object { "$($_.Path):$($_.LineNumber): $($_.Line.Trim())" }
  } else {
    '(0 match)'
  }
}

Write-Output '=== IVault method probes (seal/open/rotate/pairStart) ==='
$targets = $files | Where-Object {
  $_.FullName -match '\\vault\\src\\' -or $_.FullName -match '\\shared\\src\\contracts\\crypto\.ts$'
}
$probes = $targets | Select-String -Pattern '\b(seal|open|rotate|pairStart)\s*\('
if ($probes) {
  $probes | ForEach-Object { "$($_.Path):$($_.LineNumber): $($_.Line.Trim())" }
} else {
  '(0 match)'
}
