// ADR-01 spike supervisor (XPC service, App Sandbox). On a "run" message it launches fixed
// workers from the enclosing bundle with bounded stdio and replies with their stdout.
#include <mach-o/dyld.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
#include <xpc/xpc.h>
extern char **environ;
extern int sandbox_check(pid_t pid, const char *operation, int type, ...);

static char contents[4096];

static char *run(char *const argv[], char *const envp[], const char *input, size_t inputLength) {
  int in[2], out[2]; pipe(in); pipe(out);
  posix_spawn_file_actions_t fa; posix_spawn_file_actions_init(&fa);
  posix_spawn_file_actions_adddup2(&fa, in[0], 0); posix_spawn_file_actions_adddup2(&fa, out[1], 1); posix_spawn_file_actions_adddup2(&fa, out[1], 2);
  posix_spawn_file_actions_addclose(&fa, in[1]); posix_spawn_file_actions_addclose(&fa, out[0]);
  pid_t pid; int rc = posix_spawn(&pid, argv[0], &fa, NULL, argv, envp);
  close(in[0]); close(out[1]);
  char *result = calloc(1, 65536);
  if (rc != 0) { snprintf(result, 65536, "SPAWN_FAILED %s: %s", argv[0], strerror(rc)); close(in[1]); close(out[0]); return result; }
  if (input) write(in[1], input, inputLength);
  close(in[1]);
  size_t used = 0; ssize_t n;
  while (used < 65535 && (n = read(out[0], result + used, 65535 - used)) > 0) used += n; // bounded output
  close(out[0]); int status = 0; waitpid(pid, &status, 0);
  snprintf(result + strlen(result), 65536 - strlen(result), " [exit=%d signal=%d]", WIFEXITED(status) ? WEXITSTATUS(status) : -1, WIFSIGNALED(status) ? WTERMSIG(status) : 0);
  return result;
}

static void handle(xpc_connection_t peer, xpc_object_t message) {
  xpc_object_t reply = xpc_dictionary_create_reply(message);
  size_t length = 0; const void *source = xpc_dictionary_get_data(message, "source", &length);
  const char *sentinel = xpc_dictionary_get_string(message, "sentinel"), *writeTarget = xpc_dictionary_get_string(message, "writeTarget"), *port = xpc_dictionary_get_string(message, "port");
  char path[4][4096];
  snprintf(path[0], 4096, "%s/Resources/runtime/jre/bin/java", contents);
  snprintf(path[1], 4096, "%s/MacOS/Code Intelligence Validation", contents);
  snprintf(path[2], 4096, "%s/Resources/spike/probe", contents);
  snprintf(path[3], 4096, "%s/Resources/spike", contents);
  char script[4096]; snprintf(script, sizeof script, "%s/node-analyze.cjs", path[3]);
  char *noEnv[] = { "LANG=C", NULL };
  char *nodeEnv[] = { "ELECTRON_RUN_AS_NODE=1", "LANG=C", NULL };
  char *javaArgs[] = { path[0], "-Xshare:off", "-cp", path[3], "Count", NULL };
  char *nodeArgs[] = { path[1], script, path[2], (char *)sentinel, (char *)writeTarget, (char *)port, NULL };
  char *probeArgs[] = { path[2], (char *)sentinel, (char *)writeTarget, (char *)port, "supervisor-child", NULL };
  char self[128]; snprintf(self, sizeof self, "{\"pid\":%d,\"sandboxed\":%d}", getpid(), sandbox_check(getpid(), NULL, 0));
  xpc_dictionary_set_string(reply, "supervisor", self);
  char *r;
  r = run(javaArgs, noEnv, source, length); xpc_dictionary_set_string(reply, "java", r); free(r);
  r = run(nodeArgs, nodeEnv, source, length); xpc_dictionary_set_string(reply, "node", r); free(r);
  r = run(probeArgs, noEnv, NULL, 0); xpc_dictionary_set_string(reply, "probe", r); free(r);
  xpc_connection_send_message(peer, reply); xpc_release(reply);
}

static void connection(xpc_connection_t peer) {
  xpc_connection_set_event_handler(peer, ^(xpc_object_t event) {
    if (xpc_get_type(event) == XPC_TYPE_DICTIONARY) handle(peer, event);
  });
  xpc_connection_resume(peer);
}

int main(void) {
  uint32_t size = sizeof contents; _NSGetExecutablePath(contents, &size);
  // Workers live inside the service bundle: .../Supervisor.xpc/Contents/MacOS/Supervisor -> .../Supervisor.xpc/Contents
  for (int i = 0; i < 2; i++) *strrchr(contents, '/') = 0;
  xpc_main(connection);
}
