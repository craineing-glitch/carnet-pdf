$ErrorActionPreference = 'Stop'
$readerRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (!(Test-Path -LiteralPath $compiler)) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe'
}
if (!(Test-Path -LiteralPath $compiler)) { throw '需要 Windows .NET Framework 4 编译器。' }

$iconFile = Join-Path $readerRoot 'desktop/app.ico'
if (!(Test-Path -LiteralPath $iconFile)) { throw 'Missing app.ico' }

$productRoot = Split-Path -Parent $readerRoot
$executable = Join-Path $productRoot 'Carnet.exe'
& $compiler /nologo /optimize+ /target:winexe /platform:anycpu /codepage:65001 "/win32icon:$iconFile" "/out:$executable" /reference:System.Windows.Forms.dll (Join-Path $readerRoot 'desktop/Launcher.cs')
if ($LASTEXITCODE -ne 0) { throw 'EXE 编译失败。' }
Copy-Item -LiteralPath $executable -Destination (Join-Path $readerRoot 'Stop Reader.exe')
Write-Output "Native GUI launcher built: $executable"
