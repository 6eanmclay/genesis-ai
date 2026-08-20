# Run a command WITHOUT administrator privileges, and capture its result.
#
# PostgreSQL refuses to start under an administrator account on Windows:
#
#     Execution of PostgreSQL by a user with administrative permissions is not
#     permitted. The server must be started under an unprivileged user ID to
#     prevent possible system security compromises.
#
# That is Postgres protecting itself, and it is right to. The fix belongs in the
# environment, not in the application — so this drops privileges rather than
# reaching for anything that would weaken the test.
#
# `runas /trustlevel:0x20000` runs the command under a RESTRICTED token: same
# user, administrator group disabled. Verified before use — the wrapped command
# reports Elevated=False where the calling shell reports True.
#
# runas detaches, so stdout cannot be piped back. The command's output and its
# exit code are written to files instead, and the caller reads those.
#
#   powershell -File scripts/run-unelevated.ps1 -Command "npx tsx scripts/x.ts" -OutFile out.txt

param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string]$OutFile
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$outPath = if ([System.IO.Path]::IsPathRooted($OutFile)) { $OutFile } else { Join-Path $root $OutFile }
$exitPath = "$outPath.exit"

foreach ($p in @($outPath, $exitPath)) {
    if (Test-Path $p) { Remove-Item $p -Force }
}

# The inner script: cd to the repo, run the command, record everything.
# Written to a file rather than passed inline, because quoting a nested command
# through runas -> cmd -> powershell is its own small nightmare.
$inner = @"
Set-Location -LiteralPath '$root'
try {
    & cmd /c "$Command" *>&1 | Tee-Object -FilePath '$outPath'
    `$code = `$LASTEXITCODE
} catch {
    `$_ | Out-String | Add-Content -Path '$outPath'
    `$code = 1
}
Set-Content -Path '$exitPath' -Value `$code
"@

$innerPath = Join-Path $env:TEMP "genesis-unelevated-$PID.ps1"
Set-Content -Path $innerPath -Value $inner -Encoding UTF8

try {
    # 0x20000 = TRUSTLEVEL_BASICUSER: the same user with the administrators
    # group disabled, which is exactly what Postgres is checking for.
    $args = "/trustlevel:0x20000 `"powershell -NoProfile -ExecutionPolicy Bypass -File `"`"$innerPath`"`"`""
    Start-Process -FilePath "runas.exe" -ArgumentList $args -NoNewWindow -Wait

    # runas returns as soon as it has launched, so wait for the exit-code file.
    $deadline = (Get-Date).AddMinutes(20)
    while (-not (Test-Path $exitPath)) {
        if ((Get-Date) -gt $deadline) {
            throw "Timed out waiting for the unelevated command to finish. Partial output is in $outPath"
        }
        Start-Sleep -Milliseconds 500
    }

    $code = (Get-Content $exitPath -Raw).Trim()
    Write-Output "UNELEVATED EXIT CODE: $code"
    exit [int]$code
} finally {
    if (Test-Path $innerPath) { Remove-Item $innerPath -Force }
}
