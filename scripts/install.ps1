$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22.19+ from https://nodejs.org first.' }
$PsiInstaller = Join-Path ([IO.Path]::GetTempPath()) ('psi-' + [Guid]::NewGuid() + '.mjs')
try {
  Invoke-WebRequest 'https://raw.githubusercontent.com/sebastianmiletic/Psi/main/scripts/install.mjs' -OutFile $PsiInstaller
  & node $PsiInstaller
  if ($LASTEXITCODE -ne 0) { throw 'Psi installation failed.' }
} finally { Remove-Item $PsiInstaller -ErrorAction SilentlyContinue }
