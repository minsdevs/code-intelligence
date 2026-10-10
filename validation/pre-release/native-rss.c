// Read-only process discovery and target-only RSS. Owner/XPC attribution remains in process-memory.cjs.
//
// Protocol 2 (one request per line, one frame per request, each frame ends with "END"):
//   "D"            discovery: every live PID as "<pid> <ppid> <source> <executable>" where source is
//                  P (proc_pidpath), A (exec path recorded by the kernel for the process' arguments,
//                  the same source /bin/ps uses when the vnode path is gone) or C (short kernel command
//                  name only; another user's process whose argument area this unprivileged helper
//                  cannot read). A PID that exits between listing and reading is omitted only after a
//                  second metadata read confirms ESRCH; any other failure fails the frame (exit 3).
//   "<pid>,<pid>"  selected RSS: "<pid> <ppid> <rssKiB> <executable>" (P or A path only) with PID-reuse
//                  checks (exit 4); a selected PID without any executable path fails the frame (exit 3).
//                  A privileged (other effective UID) process in the set whose task this helper may not
//                  read is reported as "<pid> <ppid> U <executable>" for the caller to read via /bin/ps.
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <unistd.h>

#define MAX_TARGETS 1024
#define MAX_PROCESSES 50000
#define MAX_OUTPUT (2 * 1024 * 1024)
static char output[MAX_OUTPUT];
static char arguments[1024 * 1024];
static pid_t pids[MAX_TARGETS];
static pid_t all_pids[MAX_PROCESSES + 1];

static int bsd(pid_t pid, struct proc_bsdinfo *value) {
  errno = 0;
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, value, sizeof(*value)) == sizeof(*value);
}
static int short_bsd(pid_t pid, struct proc_bsdshortinfo *value) {
  errno = 0;
  return proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0, value, sizeof(*value)) == sizeof(*value);
}
static int compare_pid(const void *a, const void *b) {
  pid_t left = *(const pid_t *)a, right = *(const pid_t *)b;
  return (left > right) - (left < right);
}
static int printable(const char *text) {
  for (const unsigned char *c = (const unsigned char *)text; *c; c++) if (*c < 32 || *c == 127) return 0;
  return *text != 0;
}
// Exec path the kernel stored with the process arguments (first string after argc). Not argv[0],
// which a process may rewrite.
static int argument_exec_path(pid_t pid, char *out, size_t capacity) {
  int mib[3] = { CTL_KERN, KERN_PROCARGS2, pid };
  size_t size = sizeof(arguments);
  if (sysctl(mib, 3, arguments, &size, NULL, 0) != 0 || size <= sizeof(int)) return 0;
  const char *start = arguments + sizeof(int);
  size_t length = strnlen(start, size - sizeof(int));
  if (length == 0 || length >= size - sizeof(int) || length >= capacity || start[0] != '/') return 0;
  memcpy(out, start, length + 1);
  return 1;
}
static int append(size_t *length, const char *format, ...) {
  va_list list;
  va_start(list, format);
  int written = vsnprintf(output + *length, sizeof(output) - *length, format, list);
  va_end(list);
  if (written < 0 || (size_t)written >= sizeof(output) - *length) return 0;
  *length += (size_t)written;
  return 1;
}
static int discover(void) {
  int count = proc_listallpids(all_pids, sizeof(all_pids));
  if (count <= 0 || count > MAX_PROCESSES) return 3;
  size_t length = 0;
  for (int i = 0; i < count; i++) {
    pid_t pid = all_pids[i];
    if (pid <= 0) continue;
    struct proc_bsdshortinfo info;
    if (!short_bsd(pid, &info)) {
      struct proc_bsdshortinfo again;
      if (!short_bsd(pid, &again) && errno == ESRCH) continue;
      return 3;
    }
    if (info.pbsi_pid != (uint32_t)pid) return 3;
    char executable[PROC_PIDPATHINFO_MAXSIZE];
    char source = 'P';
    if (proc_pidpath(pid, executable, sizeof(executable)) <= 0) {
      if (argument_exec_path(pid, executable, sizeof(executable))) source = 'A';
      else {
        struct proc_bsdshortinfo again;
        if (!short_bsd(pid, &again)) { if (errno == ESRCH) continue; return 3; }
        memcpy(executable, info.pbsi_comm, sizeof(info.pbsi_comm));
        executable[sizeof(info.pbsi_comm) - 1] = 0;
        source = 'C';
      }
    }
    if (!printable(executable)) return 3;
    if (!append(&length, "%d %u %c %s\n", pid, info.pbsi_ppid, source, executable)) return 5;
  }
  if (fwrite(output, 1, length, stdout) != length || fputs("END\n", stdout) < 0 || fflush(stdout)) return 6;
  return 0;
}
static int selected(char *input) {
  size_t count = 0, length = 0;
  char *cursor = input;
  for (;;) {
    char *end;
    if (*cursor < '1' || *cursor > '9') return 2;
    errno = 0;
    long parsed = strtol(cursor, &end, 10);
    if (errno || parsed <= 1 || parsed > INT_MAX || count == MAX_TARGETS) return 2;
    pids[count++] = (pid_t)parsed;
    if (*end == '\n' && end[1] == 0) break;
    if (*end != ',') return 2;
    cursor = end + 1;
  }
  qsort(pids, count, sizeof(*pids), compare_pid);
  for (size_t i = 1; i < count; i++) if (pids[i - 1] == pids[i]) return 2;
  for (size_t i = 0; i < count; i++) {
    struct proc_bsdinfo before, after;
    struct proc_taskinfo task;
    char executable[PROC_PIDPATHINFO_MAXSIZE];
    if (!bsd(pids[i], &before)) {
      if (errno == ESRCH) continue;
      if (errno != EPERM) return 3;
      // A privileged child in the tree (e.g. the app's own setuid /bin/ps run): this unprivileged helper
      // may read its short metadata and path but not its task. Report it as U so the caller reads its
      // RSS through /bin/ps instead of dropping it.
      struct proc_bsdshortinfo info;
      if (!short_bsd(pids[i], &info)) { if (errno == ESRCH) continue; return 3; }
      if (info.pbsi_pid != (uint32_t)pids[i] || info.pbsi_uid == getuid()) return 3;
      if (proc_pidpath(pids[i], executable, sizeof(executable)) <= 0
          && !argument_exec_path(pids[i], executable, sizeof(executable))) {
        struct proc_bsdshortinfo again;
        if (!short_bsd(pids[i], &again) && errno == ESRCH) continue;
        return 3;
      }
      if (!printable(executable)) return 4;
      if (!append(&length, "%d %u U %s\n", pids[i], info.pbsi_ppid, executable)) return 5;
      continue;
    }
    // RSS is attached only to a process identified by an executable path (vnode path, else the exec
    // path recorded with its arguments, as in discovery).
    if (proc_pidinfo(pids[i], PROC_PIDTASKINFO, 0, &task, sizeof(task)) != sizeof(task)
        || (proc_pidpath(pids[i], executable, sizeof(executable)) <= 0
            && !argument_exec_path(pids[i], executable, sizeof(executable)))
        || !bsd(pids[i], &after)) {
      struct proc_bsdinfo current;
      if (!bsd(pids[i], &current) && errno == ESRCH) continue;
      return 3;
    }
    // Refuse PID reuse across the task/path reads; do not attach old RSS to a new process.
    if (before.pbi_pid != (uint32_t)pids[i] || after.pbi_pid != (uint32_t)pids[i]
        || before.pbi_start_tvsec != after.pbi_start_tvsec
        || before.pbi_start_tvusec != after.pbi_start_tvusec) return 4;
    if (!printable(executable)) return 4;
    if (!append(&length, "%d %u %" PRIu64 " %s\n", pids[i], after.pbi_ppid, task.pti_resident_size / 1024, executable)) return 5;
  }
  if (fwrite(output, 1, length, stdout) != length || fputs("END\n", stdout) < 0 || fflush(stdout)) return 6;
  return 0;
}
int main(int argc, char **argv) {
  (void)argv;
  if (argc != 1) return 2;
  char input[MAX_TARGETS * 12 + 2];
  if (puts("READY 2") < 0 || fflush(stdout)) return 6;
  while (fgets(input, sizeof(input), stdin)) {
    int status = strcmp(input, "D\n") == 0 ? discover() : selected(input);
    if (status) return status;
  }
  return ferror(stdin) ? 2 : 0;
}
