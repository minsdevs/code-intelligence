param(
    [Parameter(Mandatory=$true)][UInt32]$ParentId,
    [Parameter(Mandatory=$true)][UInt32]$DescendantId,
    [Parameter(Mandatory=$true)][string]$ExpectedImageBase64
)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OwnedProcessExitWait {
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
    static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder image, ref uint size);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll")] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static int Wait(uint parent, uint descendant, string expectedImage) {
        var handles = new IntPtr[2];
        var ids = new uint[] { parent, descendant };
        var image = new StringBuilder(32768);
        string phase = "OPEN", failure = null;
        try {
            for (int i = 0; i < handles.Length; i++) {
                phase = "OPEN";
                // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION. Never terminate
                // by PID; retain the two known live objects before guardian death.
                handles[i] = OpenProcess(0x00101000, false, ids[i]);
                if (handles[i] == IntPtr.Zero) throw new InvalidOperationException();
                phase = "IMAGE"; uint capacity = 32768; image.Clear();
                if (!QueryFullProcessImageName(handles[i], 0, image, ref capacity) ||
                    !String.Equals(image.ToString(), expectedImage, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
                phase = "LIVE"; uint code;
                if (!GetExitCodeProcess(handles[i], out code) || code != 259) throw new InvalidOperationException();
            }
            Console.WriteLine("PINNED"); Console.Out.Flush();
            phase = "WAIT";
            uint result = WaitForMultipleObjects(2, handles, true, 15000);
            if (result == 258) phase = "TIMEOUT";
            if (result != 0) throw new InvalidOperationException();
        } catch {
            failure = "WINDOWS_GUARDIAN_WAIT_" + phase + "_FAILED";
        } finally {
            foreach (IntPtr handle in handles) {
                if (handle != IntPtr.Zero && !CloseHandle(handle) && failure == null)
                    failure = "WINDOWS_GUARDIAN_WAIT_CLOSE_FAILED";
            }
        }
        if (failure != null) { Console.Error.WriteLine(failure); return 1; }
        Console.WriteLine("STOPPED"); Console.Out.Flush(); return 0;
    }
}
'@ | Out-Null
    $image = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ExpectedImageBase64))
    exit ([OwnedProcessExitWait]::Wait($ParentId, $DescendantId, $image))
} catch {
    [Console]::Error.WriteLine('WINDOWS_GUARDIAN_WAIT_PROCESS_FAILED')
    exit 1
}
