' spawn-cf.vbs <工作目录> <cf.cmd 路径>
' 浮窗（GUI 程序）直接 spawn 控制台子进程时，Windows 会分新窗口但子进程拿到的是
' 空 stdio 句柄（Node 忽略 stdio 时不传真实控制台句柄），claude 检测不到 TTY，
' 会以为自己在 --print 管道模式，报 "Input must be provided..." 秒退。
' 经 WScript.Shell.Run 走 ShellExecute，系统按规范给新控制台分配真实控制台句柄，
' claude 才能正常进入交互模式。wscript 起完即退，cmd 窗口独立存活。
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = WScript.Arguments(0)
sh.Run "cmd /k """ & WScript.Arguments(1) & """", 1, False
