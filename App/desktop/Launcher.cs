using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("Carnet PDF")]
[assembly: System.Reflection.AssemblyDescription("Carnet PDF desktop launcher")]
[assembly: System.Reflection.AssemblyVersion("1.12.1.0")]

internal static class Launcher
{
    [STAThread]
    private static int Main(string[] args)
    {
        bool noOpen = Array.IndexOf(args, "--no-open") >= 0;
        string root = AppDomain.CurrentDomain.BaseDirectory;
        bool stop = Array.IndexOf(args, "--stop") >= 0 || Path.GetFileNameWithoutExtension(Application.ExecutablePath) == "Stop Reader";
        string program = Path.Combine(root, "App");
        if (File.Exists(Path.Combine(root, "runtime", "node.exe")))
        {
            program = root;
            root = Directory.GetParent(root.TrimEnd(Path.DirectorySeparatorChar)).FullName;
        }
        string node = Path.Combine(program, "runtime", "node.exe");
        string script = Path.Combine(program, "scripts", stop ? "stop.mjs" : "launch.mjs");
        try
        {
            foreach (string argument in args)
                if (argument != "--no-open" && argument != "--stop")
                    throw new ArgumentException("不支持的启动参数：" + argument);
            if (!File.Exists(node) || !File.Exists(script))
                throw new FileNotFoundException("阅读器文件不完整。请完整解压 Carnet-PDF 文件夹后再启动。\n\n" + root);

            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = node;
            start.Arguments = "\"" + script + "\"" + (noOpen ? " --no-open" : "");
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            StringBuilder output = new StringBuilder();
            using (Process process = new Process())
            {
                process.StartInfo = start;
                DataReceivedEventHandler received = delegate(object sender, DataReceivedEventArgs e)
                {
                    if (e.Data != null) lock (output) output.AppendLine(e.Data);
                };
                process.OutputDataReceived += received;
                process.ErrorDataReceived += received;
                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                if (!process.WaitForExit(25000))
                {
                    process.Kill();
                    throw new TimeoutException("启动等待超时，请查看阅读器 Files 文件夹中的 server.log。\n\n" + root);
                }
                process.WaitForExit();
                if (process.ExitCode != 0)
                    throw new InvalidOperationException(output.Length > 0 ? output.ToString().Trim() : "阅读器启动失败，请查看 Files\\server.log。");
            }
            return 0;
        }
        catch (Exception error)
        {
            if (noOpen) Console.Error.WriteLine(error.Message);
            else MessageBox.Show(error.Message, "Carnet PDF", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
