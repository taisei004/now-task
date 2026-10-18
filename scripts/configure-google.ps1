param([Parameter(Mandatory=$true)][string]$AppOrigin)
$ErrorActionPreference='Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if($AppOrigin -notmatch '^https://[a-zA-Z0-9.-]+$'){throw 'HTTPS origin without trailing slash is required.'}
$taskClientId=Read-Host 'Google Client ID'
if($taskClientId -notmatch '\.apps\.googleusercontent\.com$'){throw 'Enter the Google OAuth client ID.'}
$taskSecureSecret=Read-Host 'Google Client Secret (hidden)' -AsSecureString
$taskSecretPtr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecureSecret)
try{
  $taskSecret=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskSecretPtr)
  $taskPayload=@{GOOGLE_CLIENT_ID=$taskClientId;GOOGLE_CLIENT_SECRET=$taskSecret;APP_ORIGIN=$AppOrigin}|ConvertTo-Json -Compress
  $taskStart=[Diagnostics.ProcessStartInfo]::new()
  $taskStart.FileName=(Get-Command node).Source
  $taskStart.ArgumentList.Add((Join-Path (Get-Location) 'node_modules/wrangler/bin/wrangler.js'))
  $taskStart.ArgumentList.Add('secret');$taskStart.ArgumentList.Add('bulk')
  $taskStart.RedirectStandardInput=$true;$taskStart.UseShellExecute=$false;$taskStart.CreateNoWindow=$true
  $taskProcess=[Diagnostics.Process]::Start($taskStart)
  $taskProcess.StandardInput.WriteLine($taskPayload);$taskProcess.StandardInput.Close();$taskProcess.WaitForExit()
  if($taskProcess.ExitCode -ne 0){throw 'Cloudflare secret configuration failed.'}
}finally{
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskSecretPtr)
  $taskPayload=$null;$taskSecret=$null
}
Write-Host 'Google authentication configured. No secret was written to the repository.'
