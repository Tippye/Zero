param([Parameter(Mandatory=$true)][string]$Executable, [switch]$LaunchLinks)
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path $Executable).Path
$cap = Get-ItemProperty 'HKCU:\Software\Clients\Mail\Zero Mail\Capabilities\URLAssociations'
if ($cap.mailto -ne 'ZeroMail.mailto') { throw 'MAILTO capability missing' }
$registered = Get-ItemProperty 'HKCU:\Software\RegisteredApplications'
if ($registered.'Zero Mail' -ne 'Software\Clients\Mail\Zero Mail\Capabilities') { throw 'RegisteredApplications entry missing' }
$command = (Get-Item 'HKCU:\Software\Classes\ZeroMail.mailto\shell\open\command').GetValue('')
if (!$command.Contains('"%1"') -or !$command.Contains($exe)) { throw 'Protocol executable or URL argument is not quoted correctly' }
$custom = (Get-Item 'HKCU:\Software\Classes\zeromail\shell\open\command').GetValue('')
if (!$custom.Contains($exe)) { throw 'Custom scheme missing' }
$current = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\mailto\UserChoice' -ErrorAction SilentlyContinue
[pscustomobject]@{Windows=[Environment]::OSVersion.VersionString;MailtoRegistered=$true;CustomSchemeRegistered=$true;CurrentMailtoProgId=$current.ProgId;DefaultChangedByTest=$false} | ConvertTo-Json
if ($LaunchLinks) {
  Start-Process -FilePath $exe -ArgumentList '"mailto:demo@example.invalid?subject=Zero%20Windows%20test&body=Hello%20from%20Windows"'
  Start-Sleep -Seconds 3
  Start-Process 'zeromail://compose?to=demo@example.invalid&subject=Second%20instance'
  Write-Output 'Verify two compose launches, then use Settings > Test notification and click the toast. No email is sent by this script.'
}
