# Measures whether Figma still exports in each window state, using the bridge's
# health probe (a tiny live export). Needs the bridge server running and the
# plugin connected. Leaves the Figma window restored and in front at the end.
#
#   pwsh scripts/window-test.ps1            # front, covered, minimized
param([string]$Rpc = "$PSScriptRoot\rpc.mjs")

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
"@

$figma = Get-Process Figma -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $figma) { throw "No Figma window found" }
$h = $figma.MainWindowHandle

function Probe([string]$label) {
  Start-Sleep -Seconds 2
  $t = Get-Date
  $out = node $Rpc health 2>&1 | Out-String
  $ms = [int]((Get-Date) - $t).TotalMilliseconds
  $ok = $out -match '"ok":\s*true'
  "{0,-28} {1,-5} {2,6}ms  {3}" -f $label, ($(if ($ok) { "OK" } else { "STALL" })), $ms, (($out -replace '\s+', ' ').Substring(0, [Math]::Min(140, $out.Length)))
}

# 1. In front
[W]::ShowWindow($h, 9) | Out-Null; [W]::SetForegroundWindow($h) | Out-Null
Probe "front"

# 2. Covered: push Figma to the bottom of the z-order (restored, not minimized)
$HWND_BOTTOM = [IntPtr]1
[W]::SetWindowPos($h, $HWND_BOTTOM, 0, 0, 0, 0, 0x0013) | Out-Null   # NOSIZE|NOMOVE|NOACTIVATE
Probe "covered (bottom of z-order)"

# 3. Minimized
[W]::ShowWindow($h, 6) | Out-Null
Probe "minimized"

# restore
[W]::ShowWindow($h, 9) | Out-Null; [W]::SetForegroundWindow($h) | Out-Null
