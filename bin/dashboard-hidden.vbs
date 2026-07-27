' Uruchamia dashboard.bat z calkowicie ukrytym oknem konsoli
Dim objShell, objFSO, scriptDir, batPath

Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")

scriptDir = objFSO.GetParentFolderName(WScript.ScriptFullName)
batPath = objFSO.BuildPath(scriptDir, "dashboard.bat")

objShell.Run """" & batPath & """", 0, False
