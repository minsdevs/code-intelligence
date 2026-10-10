// Target-only RSS. Global discovery and owner/XPC attribution remain in process-memory.cjs.
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>

#define MAX_TARGETS 1024
#define MAX_OUTPUT (2 * 1024 * 1024)
static char output[MAX_OUTPUT];
static pid_t pids[MAX_TARGETS];

static int bsd(pid_t pid, struct proc_bsdinfo *value) {
  errno = 0;
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, value, sizeof(*value)) == sizeof(*value);
}
static int compare_pid(const void *a, const void *b) {
  pid_t left = *(const pid_t *)a, right = *(const pid_t *)b;
  return (left > right) - (left < right);
}
int main(int argc, char **argv) {
  (void)argv;
  if (argc != 1) return 2;
  char input[MAX_TARGETS * 12 + 2];
  if (puts("READY 1") < 0 || fflush(stdout)) return 6;
  while (fgets(input, sizeof(input), stdin)) {
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
      if (!bsd(pids[i], &before)) { if (errno == ESRCH) continue; return 3; }
      if (proc_pidinfo(pids[i], PROC_PIDTASKINFO, 0, &task, sizeof(task)) != sizeof(task)
          || proc_pidpath(pids[i], executable, sizeof(executable)) <= 0
          || !bsd(pids[i], &after)) {
        struct proc_bsdinfo current;
        if (!bsd(pids[i], &current) && errno == ESRCH) continue;
        return 3;
      }
      // Refuse PID reuse across the task/path reads; do not attach old RSS to a new process.
      if (before.pbi_pid != (uint32_t)pids[i] || after.pbi_pid != (uint32_t)pids[i]
          || before.pbi_start_tvsec != after.pbi_start_tvsec
          || before.pbi_start_tvusec != after.pbi_start_tvusec) return 4;
      for (char *c = executable; *c; c++) if ((unsigned char)*c < 32 || (unsigned char)*c == 127) return 4;
      int written = snprintf(output + length, sizeof(output) - length, "%d %u %" PRIu64 " %s\n",
        pids[i], after.pbi_ppid, task.pti_resident_size / 1024, executable);
      if (written < 0 || (size_t)written >= sizeof(output) - length) return 5;
      length += (size_t)written;
    }
    if (fwrite(output, 1, length, stdout) != length || fputs("END\n", stdout) < 0 || fflush(stdout)) return 6;
  }
  return ferror(stdin) ? 2 : 0;
}
