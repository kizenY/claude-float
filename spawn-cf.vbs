' spawn-cf.vbs <工作目录> <cf.cmd 路径> [附加参数]
' 浮窗（GUI 程序）直接 spawn 控制台子进程时，Windows 会分新窗口但子进程拿到的是
' 空 stdio 句柄（Node 忽略 stdio 时不传真实控制台句柄），claude 检测不到 TTY，
' 会以为自己在 --print 管道模式，报 "Input must be provided..." 秒退。
' 经 WScript.Shell.Run 走 ShellExecute，系统按规范给新控制台分配真实控制台句柄，
' claude 才能正常进入交互模式。wscript 起完即退，终端窗口独立存活。
Dim sh, extra, ps
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = WScript.Arguments(0)
extra = ""
If WScript.Arguments.Count > 2 Then extra = " " & WScript.Arguments(2)
' 统一用 powershell 起（原来用 cmd /k）：-NoExit 承接「claude 退出后窗口留在提示符」的语义。
' 用全路径不依赖 PATH（浮窗进程的环境可能是旧 PATH）；cf.cmd 路径用 PS 单引号字面量包住，
' 不怕空格；附加参数由 main.js 拼好（形如 --resume <uuid>，UUID 无空格无特殊字符，可裸拼）。
ps = sh.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
sh.Run """" & ps & """ -NoProfile -NoExit -ExecutionPolicy Bypass -Command ""& '" & _
  WScript.Arguments(1) & "'" & extra & """", 1, False
