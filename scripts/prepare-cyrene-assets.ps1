# Prepare bundled Cyrene materials from the cyrene-balance package.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-cyrene-assets.ps1
#
# Reads cyrene-balance-*.zip next to the repository (or -Zip <path>),
# downscales runtime images, and writes assets/cyrene/.
# Source zip is NOT copied into the repository; only the downscaled
# runtime files land in assets/cyrene/ so the packaged size stays small.
#
# This script is a development-time helper. It is not part of `pnpm verify`.

param(
  [string]$Zip = '',
  [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not $RepoRoot) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

if (-not $Zip) {
  # The zip usually sits at the workspace root, two levels above this repo.
  $parents = @(
    $RepoRoot,
    (Split-Path $RepoRoot -Parent),
    (Split-Path (Split-Path $RepoRoot -Parent) -Parent)
  )
  $found = $null
  foreach ($dir in ($parents | Where-Object { $_ -and (Test-Path -LiteralPath $_) })) {
    $found = Get-ChildItem -LiteralPath $dir -Filter 'cyrene-balance-*.zip' -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if ($found) { break }
  }
  if (-not $found) {
    throw "cyrene-balance-*.zip not found near $RepoRoot; pass -Zip <path>."
  }
  $Zip = $found.FullName
}

$outRoot = Join-Path $RepoRoot 'assets\cyrene'
$workRoot = Join-Path $RepoRoot 'tmp\cyrene-assets-src'

if (Test-Path -LiteralPath $workRoot) {
  Remove-Item -LiteralPath $workRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
Expand-Archive -LiteralPath $Zip -DestinationPath $workRoot -Force

$srcRoot = Join-Path $workRoot 'cyrene-balance\assets'
if (-not (Test-Path -LiteralPath $srcRoot)) {
  throw "Unexpected zip layout: $srcRoot not found."
}

if (Test-Path -LiteralPath $outRoot) {
  Remove-Item -LiteralPath $outRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $outRoot -Force | Out-Null

function Save-ResizedPng {
  param(
    [Parameter(Mandatory = $true)][string]$In,
    [Parameter(Mandatory = $true)][string]$Out,
    [Parameter(Mandatory = $true)][int]$MaxHeight
  )

  $img = [System.Drawing.Image]::FromFile($In)
  try {
    $ratio = [Math]::Min(1.0, $MaxHeight / [double]$img.Height)
    $w = [Math]::Max(1, [int][Math]::Round($img.Width * $ratio))
    $h = [Math]::Max(1, [int][Math]::Round($img.Height * $ratio))
    $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      # SourceCopy keeps the original alpha channel instead of blending onto black.
      $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.DrawImage($img, 0, 0, $w, $h)
    } finally {
      $g.Dispose()
    }
    $dir = Split-Path $Out -Parent
    if (-not (Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  } finally {
    $img.Dispose()
  }
}

function Copy-Plain {
  param(
    [Parameter(Mandatory = $true)][string]$In,
    [Parameter(Mandatory = $true)][string]$Out
  )
  $dir = Split-Path $Out -Parent
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  Copy-Item -LiteralPath $In -Destination $Out -Force
}

# Poses: 512 px tall keeps them crisp at 1.4x UI scale on a 1440p desktop.
$poses = @(
  @{ From = 'calm.png'; To = 'stand/calm.png' },
  @{ From = 'confident.png'; To = 'stand/confident.png' },
  @{ From = 'love-happy.png'; To = 'stand/love-happy.png' },
  @{ From = 'playful.png'; To = 'stand/playful.png' },
  @{ From = 'serious.png'; To = 'stand/serious.png' },
  @{ From = 'DSniang1.png'; To = 'stand/default.png' }
)
foreach ($pose in $poses) {
  $in = Join-Path $srcRoot $pose.From
  if (Test-Path -LiteralPath $in) {
    Save-ResizedPng -In $in -Out (Join-Path $outRoot $pose.To) -MaxHeight 512
  }
}

# Idle frames: 512 px tall, same budget as the poses.
for ($i = 1; $i -le 8; $i++) {
  $name = 'frame-{0:D2}.png' -f $i
  $in = Join-Path $srcRoot $name
  if (Test-Path -LiteralPath $in) {
    $out = Join-Path $outRoot ('frames\' + $name)
    Save-ResizedPng -In $in -Out $out -MaxHeight 512
  }
}

# Emoji stickers: 128 px tall is plenty for a 64 px bubble sticker at 2x DPI.
$emojiDir = Join-Path $srcRoot 'emoji'
if (Test-Path -LiteralPath $emojiDir) {
  foreach ($file in Get-ChildItem -LiteralPath $emojiDir -Filter '*.png' -File) {
    $out = Join-Path $outRoot ('emoji\' + $file.Name)
    Save-ResizedPng -In $file.FullName -Out $out -MaxHeight 128
  }
}

# Avatar for the desktop status bar.
$mimi = Join-Path $srcRoot 'mimi.png'
if (Test-Path -LiteralPath $mimi) {
  Save-ResizedPng -In $mimi -Out (Join-Path $outRoot 'avatar.png') -MaxHeight 128
}

# Audio and looped stickers stay as-is; they are already small.
$plain = @(
  @{ From = 'greeting.wav'; To = 'audio/greeting.wav' },
  @{ From = 'task-end-a.wav'; To = 'audio/task-end.wav' },
  @{ From = 'cost-default.wav'; To = 'audio/cost-default.wav' },
  @{ From = 'minecraft-exp-orb.wav'; To = 'audio/exp-orb.wav' },
  @{ From = 'Ya1.mp3'; To = 'audio/ya-1.mp3' },
  @{ From = 'Ya2.mp3'; To = 'audio/ya-2.mp3' },
  @{ From = 'bubble-money1.gif'; To = 'sticker/bubble-money.gif' },
  @{ From = 'bubble-petpet.gif'; To = 'sticker/bubble-petpet.gif' }
)
foreach ($item in $plain) {
  $in = Join-Path $srcRoot $item.From
  if (Test-Path -LiteralPath $in) {
    Copy-Plain -In $in -Out (Join-Path $outRoot $item.To)
  }
}

# Manifest: code reads paths from here, so renaming files only needs one edit.
$manifest = [ordered]@{
  id = 'cyrene'
  version = 1
  source = 'bestlike093/cyrene-balance'
  sourceCommit = 'c54d9f67b1f41f6f2a383db86d0c4f2ae10d487e'
  license = 'self-authored; see ../ATTRIBUTION.md'
  poses = [ordered]@{
    default = 'stand/default.png'
    neutral = 'stand/calm.png'
    calm = 'stand/calm.png'
    confident = 'stand/confident.png'
    happy = 'stand/love-happy.png'
    playful = 'stand/playful.png'
    serious = 'stand/serious.png'
  }
  frames = @(1..8 | ForEach-Object { 'frames/frame-{0:D2}.png' -f $_ })
  emotions = [ordered]@{
    neutral = 'emoji/midmeh.png'
    happy = 'emoji/awesome.png'
    excited = 'emoji/hellyeah.png'
    sad = 'emoji/Hurtcry.png'
    crying = 'emoji/Sobbinghard.png'
    angry = 'emoji/Madnow.png'
    shy = 'emoji/blushhard.png'
    thinking = 'emoji/thinking.png'
    sleepy = 'emoji/sleepynow.png'
    tired = 'emoji/deadtired.png'
    surprised = 'emoji/Whatswrong.png'
    confused = 'emoji/awkward.png'
    love = 'emoji/Airkiss.png'
    thanks = 'emoji/Thanks.png'
    ok = 'emoji/OK.png'
    greeting = 'emoji/hello.png'
    goodnight = 'emoji/goodnight.png'
    cheer = 'emoji/fighting.png'
    hug = 'emoji/hugtight.png'
    hungry = 'emoji/eating.png'
  }
  avatar = 'avatar.png'
  sounds = [ordered]@{
    greeting = 'audio/greeting.wav'
    taskEnd = 'audio/task-end.wav'
    cost = 'audio/cost-default.wav'
    expOrb = 'audio/exp-orb.wav'
    ya1 = 'audio/ya-1.mp3'
    ya2 = 'audio/ya-2.mp3'
  }
  stickers = [ordered]@{
    money = 'sticker/bubble-money.gif'
    petpet = 'sticker/bubble-petpet.gif'
  }
}
$manifestPath = Join-Path $outRoot 'manifest.json'
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

# Report total runtime size. Keep it under 8 MB.
$files = Get-ChildItem -LiteralPath $outRoot -Recurse -File
$total = ($files | Measure-Object -Property Length -Sum).Sum
Write-Output ('CYRENE_ASSETS_OK files={0} bytes={1} mb={2:N2}' -f $files.Count, $total, ($total / 1MB))
$files | Sort-Object FullName | ForEach-Object {
  Write-Output ('{0,10}  {1}' -f $_.Length, $_.FullName.Substring($outRoot.Length + 1))
}

# Keep the extracted source for inspection, but never package it.
