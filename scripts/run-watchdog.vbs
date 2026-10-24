' VPanel - run the watchdog hidden (no console window).
'
' Called by watchdog.bat. The watchdog itself brings the panel + worker up if
' they are not already running, and keeps all three alive afterwards. Because it
' runs with no window, there is nothing for the operator to keep open.

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

' This file is <root>\scripts\run-watchdog.vbs, so go up two levels to the root.
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root

' 0 = hidden window, False = do not wait for it to finish.
sh.Run "cmd /c node scripts\watchdog.mjs", 0, False
