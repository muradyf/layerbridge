# Chrome throttles a hidden page much harder once it has been hidden for ~5
# minutes (intensive wake-up throttling: timers fire at most once a minute).
# A short minimize/restore never reaches that stage, so this holds Figma in one
# state for several minutes and probes every minute: a small icon (health) and
# a full screen frame exported as SVG to a temp folder.
#
#   pwsh scripts/long-hidden-test.ps1 -State minimized -Minutes 7
param(
  [ValidateSet("minimized", "covered")][string]$State = "minimized",
  [int]$Minutes = 7,
  [string]$SmallNode = "I2071:22581;649:9433;280:3364",
  [string]$BigNode = "2071:22565",
  # Must sit inside the bridge server's working directory (or FIGMA_BRIDGE_OUTPUT_ROOTS).
  [string]$OutDir = "C:\Users\Admin\Projects\portfolio\.scratch\figma-long-test",
  [string]$Rpc = "$PSScriptRoot\rpc.mjs"
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class W2 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@

$figma = Get-Process Figma | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$h = $figma.MainWindowHandle
$tmp = $OutDir
New-Item -ItemType Directory -Force $tmp | Out-Null
$start = Get-Date

if ($State -eq "minimized") { [W2]::ShowWindow($h, 6) | Out-Null }
else { [W2]::SetWindowPos($h, [IntPtr]1, 0, 0, 0, 0, 0x0013) | Out-Null }

try {
  for ($i = 0; $i -le $Minutes; $i++) {
    if ($i -gt 0) { Start-Sleep -Seconds 60 }
    $elapsed = [int]((Get-Date) - $start).TotalSeconds

    $t = Get-Date
    $small = node $Rpc health ('{"nodeId":"' + $SmallNode + '"}') 2>&1 | Out-String
    $smallMs = [int]((Get-Date) - $t).TotalMilliseconds
    $smallOk = $small -match '"ok":\s*true'

    $out = Join-Path $tmp ("big-$i.svg")
    $t = Get-Date
    $big = node $Rpc save_screenshots ('{"items":[{"nodeId":"' + $BigNode + '","outputPath":"' + ($out -replace '\\', '/') + '"}],"overwrite":true,"timeoutMs":60000}') 2>&1 | Out-String
    $bigMs = [int]((Get-Date) - $t).TotalMilliseconds
    $bigOk = $big -match '"succeeded":\s*1'

    "t+{0,4}s  {1}  icon {2,-5} {3,6}ms   frame {4,-5} {5,6}ms {6}" -f $elapsed, $State,
      ($(if ($smallOk) { "OK" } else { "STALL" })), $smallMs,
      ($(if ($bigOk) { "OK" } else { "STALL" })), $bigMs,
      ($(if (-not $bigOk) { ($big -replace '\s+', ' ').Substring(0, [Math]::Min(160, $big.Length)) } else { "" }))
  }
}
finally {
  [W2]::ShowWindow($h, 9) | Out-Null
  [W2]::SetForegroundWindow($h) | Out-Null
}
