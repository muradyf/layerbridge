# Starts Figma desktop with Chromium's background throttling turned off, so the
# canvas keeps rendering — and exportAsync keeps working — while the window is
# covered by other windows or minimized.
#
# Figma is Electron. Chromium stops rendering a window it believes nobody can
# see: on Windows it detects COVERED windows itself (native occlusion) and
# treats MINIMIZED ones as hidden. These switches are read by Chromium at
# startup, so they only take effect when Figma is launched with them — quit
# Figma completely first (tray icon → Quit).
#
#   pwsh scripts/launch-figma.ps1
$ErrorActionPreference = "Stop"

if (Get-Process Figma -ErrorAction SilentlyContinue) {
  throw "Figma is already running. Quit it completely (tray icon -> Quit Figma), then run this again."
}

# Squirrel keeps each version in app-<version>; launch the newest directly so the
# switches reach Chromium (the top-level Figma.exe stub does not forward them).
$app = Get-ChildItem "$env:LOCALAPPDATA\Figma" -Directory -Filter "app-*" |
  Sort-Object { [version]($_.Name -replace '^app-', '') } -Descending |
  Select-Object -First 1
if (-not $app) { throw "Figma install not found under $env:LOCALAPPDATA\Figma" }

$switches = @(
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-features=CalculateNativeWinOcclusion"
)

Start-Process -FilePath (Join-Path $app.FullName "Figma.exe") -ArgumentList $switches
"Started $($app.Name) with: $($switches -join ' ')"
