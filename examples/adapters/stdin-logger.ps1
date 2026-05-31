#!/usr/bin/env pwsh
# stdin-logger.ps1 — Windows reference wft-router adapter (vendor-neutral).
#
# Same contract as stdin-logger.ts: the event JSON arrives on stdin, the rule's
# `with:` keys arrive as key=value argv entries, exit 0 = success, and the FIRST
# line printed to stdout is captured as an opaque session id. Diagnostics go to
# stderr so they never pollute the captured session id.
#
# SECURITY: argv values are UNTRUSTED task content. Never Invoke-Expression
# them. This example only echoes them.
$ErrorActionPreference = 'Stop'

# Drain stdin (the event JSON).
$eventJson = [Console]::In.ReadToEnd()
[Console]::Error.WriteLine("[stdin-logger.ps1] event bytes: $($eventJson.Length)")

$target = 'default'
foreach ($pair in $args) {
  $idx = $pair.IndexOf('=')
  if ($idx -gt 0) {
    $key = $pair.Substring(0, $idx)
    $val = $pair.Substring($idx + 1)
    [Console]::Error.WriteLine("[stdin-logger.ps1] $key=$val")
    if ($key -eq 'target') { $target = $val }
  }
}

# Opaque session id on stdout (first line). A real adapter returns its own.
$ts = [int][double]::Parse((Get-Date -UFormat %s))
Write-Output "stdin-logger-ps1-$target-$ts"
