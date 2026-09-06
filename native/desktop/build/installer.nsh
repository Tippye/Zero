!macro customInstall
  WriteRegStr HKCU "Software\Classes\ZeroMail.mailto" "" "Zero Mail compose link"
  WriteRegStr HKCU "Software\Classes\ZeroMail.mailto" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\ZeroMail.mailto\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr HKCU "Software\Classes\ZeroMail.mailto\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Classes\zeromail" "" "Zero Mail link"
  WriteRegStr HKCU "Software\Classes\zeromail" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\zeromail\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Clients\Mail\Zero Mail" "" "Zero Mail"
  WriteRegStr HKCU "Software\Clients\Mail\Zero Mail\Capabilities" "ApplicationName" "Zero Mail"
  WriteRegStr HKCU "Software\Clients\Mail\Zero Mail\Capabilities" "ApplicationDescription" "Open self-hosted email client"
  WriteRegStr HKCU "Software\Clients\Mail\Zero Mail\Capabilities\URLAssociations" "mailto" "ZeroMail.mailto"
  WriteRegStr HKCU "Software\RegisteredApplications" "Zero Mail" "Software\Clients\Mail\Zero Mail\Capabilities"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\ZeroMail.mailto"
  DeleteRegKey HKCU "Software\Classes\zeromail"
  DeleteRegKey HKCU "Software\Clients\Mail\Zero Mail"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Zero Mail"
!macroend
