' Launch Claude float window without a console
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
exe = fso.BuildPath(dir, "node_modules\electron\dist\electron.exe")
CreateObject("WScript.Shell").Run Chr(34) & exe & Chr(34) & " " & Chr(34) & dir & Chr(34), 0, False
