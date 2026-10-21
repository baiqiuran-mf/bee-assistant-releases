/* 原生窗口切换助手（替代 36MB 的 .NET settop.exe）
 * 编译：cl.exe /O2 /TC winhelper.c /link /OUT:settop.exe user32.lib kernel32.lib
 * CLI：settop.exe --pid <n> | --proc <name> | --title <sub> [--wait ms]
 * 行为：找到目标窗口 -> 恢复最小化 -> 置顶 -> SetForegroundWindow（等同 Alt-Tab）。
 *       前台锁被挡时用 AllowSetForegroundWindow(ASFW_ANY) + AttachThreadInput 双保险。
 *       每次运行把完整诊断写入 %TEMP%\settop_debug.log，便于真机排查。
 */
#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdarg.h>
#include <tlhelp32.h>

static DWORD g_targetPid = 0;
static char  g_titleSub[256] = {0};
static int   g_hasTitle = 0;
static DWORD* g_procPids = NULL;
static int    g_procPidCount = 0;

static HWND g_best = NULL;
static int  g_bestArea = -1;

/* ---------- 诊断日志（写入 %TEMP%\settop_debug.log） ---------- */
static void dlog(const char* fmt, ...) {
    char path[MAX_PATH];
    if (!GetTempPathA(MAX_PATH, path)) strcpy_s(path, MAX_PATH, ".");
    strcat_s(path, MAX_PATH, "settop_debug.log");
    FILE* f = fopen(path, "a");
    if (!f) return;
    SYSTEMTIME st; GetLocalTime(&st);
    fprintf(f, "[%02d:%02d:%02d.%03d] ", st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
    va_list ap; va_start(ap, fmt); vfprintf(f, fmt, ap); va_end(ap);
    fprintf(f, "\n");
    fclose(f);
}

BOOL CALLBACK EnumProc(HWND hwnd, LPARAM lParam) {
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    int pidOk = 0;
    if (g_targetPid) pidOk = (pid == g_targetPid);
    else if (g_procPidCount > 0) {
        for (int i = 0; i < g_procPidCount; i++) if (g_procPids[i] == pid) { pidOk = 1; break; }
    } else pidOk = 1;
    if (!pidOk) return TRUE;
    if (g_hasTitle) {
        int len = GetWindowTextLengthA(hwnd);
        if (len <= 0) return TRUE;
        char* buf = (char*)malloc((size_t)len + 1);
        if (!buf) return TRUE;
        GetWindowTextA(hwnd, buf, len + 1);
        buf[len] = 0;
        int hit = (strstr(buf, g_titleSub) != NULL) ? 1 : 0;
        free(buf);
        if (!hit) return TRUE;
    }
    RECT r; int area = 0;
    if (GetWindowRect(hwnd, &r)) area = (r.right - r.left) * (r.bottom - r.top);
    if (area > g_bestArea) { g_bestArea = area; g_best = hwnd; }
    return TRUE;
}

HWND FindBest() { g_best = NULL; g_bestArea = -1; EnumWindows(EnumProc, 0); return g_best; }

int main(int argc, char** argv) {
    int waitMs = 1500;
    for (int i = 1; i < argc; i++) {
        if (!_stricmp(argv[i], "--pid") && i + 1 < argc) g_targetPid = (DWORD)atoi(argv[++i]);
        else if (!_stricmp(argv[i], "--title") && i + 1 < argc) { strncpy(g_titleSub, argv[++i], 255); g_titleSub[255] = 0; g_hasTitle = 1; }
        else if (!_stricmp(argv[i], "--proc") && i + 1 < argc) {
            HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if (snap != INVALID_HANDLE_VALUE) {
                PROCESSENTRY32 pe; pe.dwSize = sizeof(pe);
                if (Process32First(snap, &pe)) {
                    do {
                        size_t alen = strlen(argv[i + 1]);
                        if (_strnicmp(pe.szExeFile, argv[i + 1], alen) == 0) {
                            char c = pe.szExeFile[alen];
                            if (c == '.' || c == '\0') {
                                g_procPids = (DWORD*)realloc(g_procPids, (g_procPidCount + 1) * sizeof(DWORD));
                                g_procPids[g_procPidCount++] = pe.th32ProcessID;
                            }
                        }
                    } while (Process32Next(snap, &pe));
                }
                CloseHandle(snap);
            }
            i++;
        }
        else if (!_stricmp(argv[i], "--wait") && i + 1 < argc) waitMs = atoi(argv[++i]);
    }
    dlog("=== settop start (our pid=%u thread=%u) ===", GetCurrentProcessId(), GetCurrentThreadId());
    dlog("argv: pid=%u procCount=%d title='%s' wait=%d", g_targetPid, g_procPidCount, g_titleSub, waitMs);
    if (!g_targetPid && !g_hasTitle && g_procPidCount == 0) {
        dlog("usage error");
        printf("usage: settop.exe --pid <n> | --proc <name> | --title <sub> [--wait ms]\n"); return 4;
    }
    if (g_procPidCount == 0 && !g_targetPid && !g_hasTitle) { dlog("no-proc"); printf("no-proc\n"); return 3; }

    HWND fg0 = GetForegroundWindow();
    dlog("foreground hwnd at start = %p", (void*)fg0);

    HWND hwnd = NULL; int waited = 0;
    while (waited <= waitMs) {
        hwnd = FindBest();
        if (hwnd) break;
        if (waited == waitMs) break;
        Sleep(100); waited += 100;
    }
    if (!hwnd) { dlog("no-window (waited %dms)", waited); printf("no-window\n"); if (g_procPids) free(g_procPids); return 2; }
    dlog("found target hwnd=%p area=%d (after %dms wait)", (void*)hwnd, g_bestArea, waited);

    DWORD myThread = GetCurrentThreadId();
    DWORD fgPid = 0, fgThread = 0;
    HWND fg = GetForegroundWindow();
    if (fg) fgThread = GetWindowThreadProcessId(fg, &fgPid);
    dlog("foreground at focus-time: hwnd=%p pid=%u thread=%u (ourown=%d)",
         (void*)fg, fgPid, fgThread, (fgThread == myThread) ? 1 : 0);

    BOOL wasMin = IsIconic(hwnd);
    ShowWindow(hwnd, wasMin ? SW_RESTORE : SW_SHOW);
    SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    dlog("restored+topmost set (wasMin=%d)", wasMin ? 1 : 0);

    BOOL ok = FALSE;

    /* 方案 A：AllowSetForegroundWindow(ASFW_ANY) 紧挨着 SetForegroundWindow 重试。
     * 关键：授权必须在每次尝试前重新调用（授权可能被系统重置）。 */
    for (int a = 0; a < 6 && !ok; a++) {
        AllowSetForegroundWindow(ASFW_ANY);
        Sleep(20);
        ok = SetForegroundWindow(hwnd);
        dlog("  A%d: AllowSFW+SetFG -> %d (gle=%u)", a, ok ? 1 : 0, GetLastError());
        if (!ok) Sleep(50);
    }

    /* 方案 B：AttachThreadInput 把前台线程挂到本线程，再 SetForegroundWindow，保持挂接一小会儿再解。 */
    if (!ok && fgThread && fgThread != myThread) {
        for (int b = 0; b < 6 && !ok; b++) {
            if (AttachThreadInput(fgThread, myThread, TRUE)) {
                SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                ok = SetForegroundWindow(hwnd);
                dlog("  B%d: attach+SetFG -> %d", b, ok ? 1 : 0);
                Sleep(90);                       /* 保持挂接，等前台切换生效 */
                AttachThreadInput(fgThread, myThread, FALSE);
                if (!ok) Sleep(50);
            } else {
                dlog("  B%d: AttachThreadInput FAILED gle=%u", b, GetLastError());
                Sleep(50);
            }
        }
    }

    HWND after = GetForegroundWindow();
    dlog("FINAL: foreground hwnd=%p target=%p ok=%d", (void*)after, (void*)hwnd, ok ? 1 : 0);
    printf("ok hwnd=%p pid=%u minimized=%d setfg=%d waited=%d prevFg=%p afterFg=%p\n",
        (void*)hwnd, g_targetPid, wasMin ? 1 : 0, ok ? 1 : 0, waited, (void*)fg0, (void*)after);
    if (g_procPids) free(g_procPids);
    return 0;
}
