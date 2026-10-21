using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Settop
{
    class Program
    {
        static readonly IntPtr HWND_TOP = new IntPtr(0);
        static readonly uint ASFW_ANY = 0xFFFFFFFF;
        const uint SWP_NOMOVE = 0x0001;
        const uint SWP_NOSIZE = 0x0002;
        const uint SWP_NOZORDER = 0x0004;
        const int SW_RESTORE = 9;
        const int SW_SHOW = 5;
        const int SW_MINIMIZE = 2;
        const uint WM_CLOSE = 0x0010;

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", SetLastError = true)]
        static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        [DllImport("user32.dll", SetLastError = true)]
        static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
        [DllImport("user32.dll", SetLastError = true)]
        static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint GetCurrentThreadId();
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool AllowSetForegroundWindow(uint dwProcessId);
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        struct RECT { public int Left, Top, Right, Bottom; }

        delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        static uint targetPid = 0;
        static List<string> titleSubs = new List<string>();
        static HashSet<uint> procPids = null;
        static int waitMs = 1500;

        static List<IntPtr> candidates = new List<IntPtr>();
        static List<IntPtr> procWindows = new List<IntPtr>();
        static uint targetClosePid = 0;

        static int Main(string[] args)
        {
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i].ToLowerInvariant();
                if (a == "--pid" && i + 1 < args.Length) { uint.TryParse(args[++i], out targetPid); }
                else if (a == "--title" && i + 1 < args.Length) { titleSubs.Add(args[++i]); }
                else if (a == "--proc" && i + 1 < args.Length)
                {
                    string pname = args[++i];
                    procPids = new HashSet<uint>();
                    try { foreach (var p in Process.GetProcessesByName(pname)) procPids.Add((uint)p.Id); } catch { }
                    if (procPids.Count == 0) { Console.WriteLine("no-proc:" + pname); return 3; }
                }
                else if (a == "--wait" && i + 1 < args.Length) { int.TryParse(args[++i], out waitMs); }
            }

            if (targetPid == 0 && procPids == null && titleSubs.Count == 0)
            {
                Console.WriteLine("usage: settop.exe --pid <pid> [--title <substr>] | --proc <name> [--title <substr>] | --title <substr> [--wait <ms>]");
                return 4;
            }

            // 允许任意进程抢前台（若本进程恰为前台则生效；非前台时为无害 no-op）
            try { AllowSetForegroundWindow(ASFW_ANY); } catch { }

            // 找不到窗口时按 --wait 轮询（Signal 刚启动还没建窗口等场景）
            IntPtr hwnd = IntPtr.Zero;
            int waited = 0;
            while (waited <= waitMs)
            {
                hwnd = FindBestWindow();
                if (hwnd != IntPtr.Zero) break;
                if (waited == waitMs) break;
                Thread.Sleep(100);
                waited += 100;
            }
            if (hwnd == IntPtr.Zero) { Console.WriteLine("no-window"); return 2; }

            IntPtr prevFg = GetForegroundWindow();
            bool wasMin = false;
            try { wasMin = IsIconic(hwnd); } catch { }
            try { ShowWindow(hwnd, wasMin ? SW_RESTORE : SW_SHOW); } catch { }

            // 抬到同层 z 序最前
            try { SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE); } catch { }

            // 真正切换前台：直接试 + 单向挂接兜底，重试绕过前台锁；成功后停在前台
            bool fgOk = false;
            for (int i = 0; i < 8; i++)
            {
                if (StealForeground(hwnd)) { fgOk = true; break; }
                Thread.Sleep(50);
            }

            // v2.5.1080：选中真窗后，把同进程里的空白/黑屏兄弟窗缩到最小并自动关掉，
            // 这样即使它先于真窗弹出，也会被收掉，跳转不再被黑屏挡住。
            TryCloseStrayBlankWindows(hwnd);

            IntPtr afterFg = GetForegroundWindow();
            Console.WriteLine("ok hwnd=" + hwnd + " pid=" + targetPid + " minimized=" + wasMin +
                              " setfg=" + fgOk + " waited=" + waited + " prevFg=" + prevFg + " afterFg=" + afterFg);
            return 0;
        }

        static bool StealForeground(IntPtr hwnd)
        {
            if (SetForegroundWindow(hwnd)) return true;
            IntPtr fg = GetForegroundWindow();
            if (fg == IntPtr.Zero || fg == hwnd) return false;
            uint fgThread = 0;
            GetWindowThreadProcessId(fg, out fgThread);
            uint myThread = GetCurrentThreadId();
            if (fgThread == 0 || fgThread == myThread) return false;
            bool ok = false;
            try
            {
                AttachThreadInput(fgThread, myThread, true);
                ok = SetForegroundWindow(hwnd);
            }
            finally
            {
                AttachThreadInput(fgThread, myThread, false);
            }
            return ok;
        }

        static IntPtr FindBestWindow()
        {
            candidates.Clear();
            EnumWindows(EnumProc, IntPtr.Zero);
            if (candidates.Count == 0) return IntPtr.Zero;

            // v2.5.1080：三档优先级选窗，根治「黑屏窗被顶到最前」：
            //   ① 标题命中 IM 关键字（WhatsApp/Signal/Telegram）→ 首选
            //   ② 标题非空（任何真页面窗）→ 次选
            //   ③ 面积最大（兜底，尽量不回退到这里）
            IntPtr titled = IntPtr.Zero; int titledArea = -1;
            IntPtr nonBlank = IntPtr.Zero; int nonBlankArea = -1;
            IntPtr best = IntPtr.Zero; int bestArea = -1;

            foreach (var h in candidates)
            {
                RECT r; int area = 0;
                if (GetWindowRectSafe(h, out r)) area = (r.Right - r.Left) * (r.Bottom - r.Top);
                if (area > bestArea) { bestArea = area; best = h; }
                string t = GetWindowTextSafe(h);
                if (string.IsNullOrEmpty(t)) continue;
                if (nonBlankArea < 0 || area > nonBlankArea) { nonBlankArea = area; nonBlank = h; }
                if (IsImTitle(t) && (titledArea < 0 || area > titledArea)) { titledArea = area; titled = h; }
            }
            IntPtr chosen = titled != IntPtr.Zero ? titled
                          : (nonBlank != IntPtr.Zero ? nonBlank : best);
            return chosen != IntPtr.Zero ? chosen : candidates[0];
        }

        /** 标题是否像 IM 主窗（命中其一即算） */
        static bool IsImTitle(string t)
        {
            return t.IndexOf("WhatsApp", StringComparison.OrdinalIgnoreCase) >= 0
                || t.IndexOf("Signal", StringComparison.OrdinalIgnoreCase) >= 0
                || t.IndexOf("Telegram", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        /** 安全读窗口标题（失败返回空串） */
        static string GetWindowTextSafe(IntPtr h)
        {
            try
            {
                int len = GetWindowTextLength(h);
                if (len <= 0) return string.Empty;
                var sb = new StringBuilder(len + 1);
                GetWindowText(h, sb, sb.Capacity);
                return sb.ToString();
            }
            catch { return string.Empty; }
        }

        /** 判断窗口是否为「空白/黑屏」窗（无标题或纯新标签页） */
        static bool IsBlankWindow(IntPtr h)
        {
            string t = GetWindowTextSafe(h);
            if (string.IsNullOrEmpty(t)) return true;
            if (t.IndexOf("New Tab", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (t.IndexOf("about:blank", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (t.IndexOf("chrome://newtab", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (t == "Google Chrome" || t == "Chrome") return true;
            return false;
        }

        /** 选中真窗后，把同进程里的空白/黑屏兄弟窗缩成 1×1 再 WM_CLOSE 自动关掉。
         *  重新枚举该进程全部顶层窗口（不依赖候选过滤），因此即便选窗时按标题排除了空白窗，
         *  这里仍能找到并关掉它，满足「黑屏弹出后最好能自己关闭」的诉求。
         *  只动与选定窗同 pid 的窗，绝不碰其它进程；真 IM 窗标题非空、不会被判定为空白。 */
        static void TryCloseStrayBlankWindows(IntPtr chosen)
        {
            if (chosen == IntPtr.Zero) return;
            uint chosenPid; GetWindowThreadProcessId(chosen, out chosenPid);
            if (chosenPid == 0) return;
            procWindows.Clear();
            targetClosePid = chosenPid;
            EnumWindows(EnumProcByPid, IntPtr.Zero);
            foreach (var h in procWindows)
            {
                if (h == chosen) continue;
                if (!IsBlankWindow(h)) continue;  // 只关空白/黑屏
                try { ShowWindow(h, SW_MINIMIZE); } catch { }
                try { SetWindowPos(h, HWND_TOP, 0, 0, 1, 1, SWP_NOZORDER); } catch { }
                try { PostMessage(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); } catch { }
            }
        }

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        static bool GetWindowRectSafe(IntPtr h, out RECT r)
        {
            try { return GetWindowRect(h, out r); } catch { r = new RECT(); return false; }
        }

        /** 按 pid 收集某进程的全部顶层窗口（用于选中后清理同进程空白窗，不依赖候选过滤） */
        static bool EnumProcByPid(IntPtr hWnd, IntPtr lParam)
        {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == targetClosePid) procWindows.Add(hWnd);
            return true;
        }

        static bool EnumProc(IntPtr hWnd, IntPtr lParam)
        {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            bool pidOk = (targetPid != 0) ? (pid == targetPid)
                        : (procPids != null) ? procPids.Contains(pid)
                        : true;
            if (!pidOk) return true;
            if (titleSubs.Count > 0)
            {
                int len = 0;
                try { len = GetWindowTextLength(hWnd); } catch { }
                if (len <= 0) return true; // 无标题窗不可能命中关键字
                var sb = new StringBuilder(len + 1);
                try { GetWindowText(hWnd, sb, sb.Capacity); } catch { return true; }
                string t = sb.ToString();
                bool anyMatch = false;
                foreach (var sub in titleSubs)
                {
                    if (t.IndexOf(sub, StringComparison.OrdinalIgnoreCase) >= 0) { anyMatch = true; break; }
                }
                if (!anyMatch) return true;
            }
            candidates.Add(hWnd);
            return true;
        }
    }
}
