# One headless baro run against the stand-in models, with a hard time limit.
# Fails on a hang, on an Architect crash, and when the pipeline stops short of
# the phase this lane is expected to reach.
param(
    [Parameter(Mandatory)] [string] $Llm,
    [int] $LimitSeconds = 360
)
$ErrorActionPreference = "Stop"
$smoke = $PSScriptRoot
$work = Join-Path $env:RUNNER_TEMP "smoke-$Llm"
$out = Join-Path $work "out"
New-Item -ItemType Directory -Force -Path "$work\repo", "$work\bin", $out | Out-Null

Set-Content "$work\bin\codex.cmd" "@node `"$smoke\fake-codex.mjs`" %*"
Set-Content "$work\goal.txt" "Add a goodbye.js file that prints goodbye"
Push-Location "$work\repo"
git init -q
git config user.email ci@example.com
git config user.name ci
Set-Content README.md "# sample"
Set-Content hello.js "console.log('hello')"
git add -A
git commit -q -m init
Pop-Location

$env:OPENAI_API_KEY = "dummy"
$env:OPENAI_BASE_URL = "http://127.0.0.1:8787/v1"
$env:FAKE_CODEX_LOG = "$out\fake-codex.log"
$env:PATH = "$work\bin;$env:PATH"
$server = Start-Process node -ArgumentList "$smoke\fake-openai.mjs", "$out\fake-openai.log" -PassThru -NoNewWindow
Start-Sleep -Seconds 2

$baro = Join-Path $env:USERPROFILE ".baro\bin\baro.exe"
$started = Get-Date
$p = Start-Process $baro -ArgumentList "--headless", "--llm", $Llm, "--cwd", "$work\repo", "--goal-file", "$work\goal.txt" `
    -RedirectStandardOutput "$out\stdout.log" -RedirectStandardError "$out\stderr.log" -PassThru -NoNewWindow
$finished = $p.WaitForExit($LimitSeconds * 1000)
$elapsed = [int]((Get-Date) - $started).TotalSeconds
if (-not $finished) {
    Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node|baro|codex|cmd|git' } |
        Select-Object ProcessId, ParentProcessId, Name, CommandLine | Format-List |
        Out-File "$out\processes.txt" -Width 4000 -Encoding utf8
    taskkill /F /T /PID $p.Id | Out-Null
}
Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force "$env:USERPROFILE\.baro\runs" "$out\runs" -ErrorAction SilentlyContinue

$stderr = Get-Content "$out\stderr.log" -Raw -ErrorAction SilentlyContinue
$phases = Get-Content "$out\fake-codex.log", "$out\fake-openai.log" -ErrorAction SilentlyContinue |
    Select-String -Pattern 'phase=([a-z]+)' -AllMatches | ForEach-Object { $_.Matches.Groups[1].Value } | Sort-Object -Unique
"--- stderr tail"; Get-Content "$out\stderr.log" -Tail 40 -ErrorAction SilentlyContinue
"--- phases reached: $($phases -join ', ')"

$failures = @()
if (-not $finished) { $failures += "run hung past ${LimitSeconds}s (process tree in processes.txt)" }
if ($stderr -match '\] crashed:') { $failures += "a helper process crashed" }
# The codex stand-in does the story's work, so that lane must finish clean.
# The openai stand-in cannot drive the native story loop; reaching the plan
# is what proves every phase before execution ran on Windows.
if ($Llm -eq "codex") {
    if ($finished -and $p.ExitCode -ne 0) { $failures += "exit code $($p.ExitCode), expected 0" }
    if ($phases -notcontains "story") { $failures += "story phase was never reached" }
} elseif ($phases -notcontains "planner") {
    $failures += "planner phase was never reached"
}
if ($failures.Count -gt 0) {
    "SMOKE FAILED ($Llm, ${elapsed}s): " + ($failures -join "; ")
    exit 1
}
"SMOKE OK ($Llm, ${elapsed}s)"
