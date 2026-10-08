// ADR-01 adapter supervisor: an XPC service signed with App Sandbox only (no network, user-file,
// Keychain or automation entitlement). A peer must satisfy the code requirement sealed in this
// bundle's Info.plist (the app's adapter bridge). Each connection runs at most one worker from the
// signed CodeIntelligenceWorkers table of that Info.plist, after checking the SHA-256 of the
// worker's executable and entry script, inside a per-run scratch directory of this service's
// container. The worker inherits the sandbox (app-sandbox + inherit); one that is not sandboxed is
// killed. The worker's length-prefixed stdio session is relayed without parsing it.
#include <CommonCrypto/CommonDigest.h>
#include <CoreFoundation/CoreFoundation.h>
#include <dirent.h>
#include <dispatch/dispatch.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <removefile.h>
#include <signal.h>
#include <spawn.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include <xpc/xpc.h>
#include "protocol.h"

extern int sandbox_check(pid_t pid, const char *operation, int type, ...);

#define MAX_SESSIONS 2
#define MAX_ENVIRONMENT 16
// One analysis per session: a single request (one 10 MiB frame in, one 64 MiB frame out) or one 03 §6
// analyzer session (chunks of at most 512 MiB of source in, 1 MiB result pages out). The host enforces
// the exact frame bounds and the analysis time limit; these cap what one session relays: twice the
// session source bound in, and the same out (a 25 MiB project returns about 47 MiB of pages).
#define MAX_INPUT_BYTES ((size_t)1 << 30)
#define MAX_OUTPUT_BYTES ((size_t)1 << 30)
#define SCRATCH_PREFIX "adapter-run-"

static char contents[PATH_MAX];
static char scratchRoot[PATH_MAX];
static char *peerRequirement;
static atomic_int sessions;

typedef struct {
  xpc_connection_t peer;
  dispatch_queue_t queue;
  pid_t pid;
  dispatch_io_t input, output;
  size_t received, sent;
  char scratch[PATH_MAX];
  int references;  // the connection and each open I/O channel; only touched on the session queue
  bool opened, counted, closed, finished;
} session_t;

static void release_session(session_t *s) {
  if (--s->references > 0) return;
  dispatch_release(s->queue);
  free(s);
}

static char *copy_string(CFTypeRef value) {
  if (!value || CFGetTypeID(value) != CFStringGetTypeID()) return NULL;
  CFIndex size = CFStringGetMaximumSizeForEncoding(CFStringGetLength(value), kCFStringEncodingUTF8) + 1;
  char *result = calloc(1, (size_t)size);
  if (result && !CFStringGetCString(value, result, size, kCFStringEncodingUTF8)) { free(result); result = NULL; }
  return result;
}

static CFTypeRef info_value(const char *key) {
  CFStringRef name = CFStringCreateWithCString(NULL, key, kCFStringEncodingUTF8);
  CFTypeRef value = CFBundleGetValueForInfoDictionaryKey(CFBundleGetMainBundle(), name);
  CFRelease(name);
  return value;
}

static CFTypeRef entry_value(CFDictionaryRef entry, const char *key) {
  CFStringRef name = CFStringCreateWithCString(NULL, key, kCFStringEncodingUTF8);
  CFTypeRef value = CFDictionaryGetValue(entry, name);
  CFRelease(name);
  return value;
}

// A bundle-relative path of plain segments; the resolved file must be a regular file inside this
// bundle reached without any symbolic link.
static bool resolve(const char *relative, char out[PATH_MAX]) {
  if (!relative || !*relative || relative[0] == '/' || strlen(relative) > 512) return false;
  for (const char *c = relative; *c; c++) {
    if (!((*c >= 'a' && *c <= 'z') || (*c >= 'A' && *c <= 'Z') || (*c >= '0' && *c <= '9')
          || *c == '.' || *c == '-' || *c == '_' || *c == '/')) return false;
  }
  if (strstr(relative, "..") || strstr(relative, "//")) return false;
  char joined[PATH_MAX], real[PATH_MAX];
  if (snprintf(joined, sizeof joined, "%s/%s", contents, relative) >= (int)sizeof joined) return false;
  if (!realpath(joined, real) || strcmp(real, joined) != 0) return false;
  struct stat st;
  if (lstat(joined, &st) != 0 || !S_ISREG(st.st_mode)) return false;
  strlcpy(out, joined, PATH_MAX);
  return true;
}

static bool sha256_matches(const char *file, const char *expected) {
  if (!expected || strlen(expected) != 64) return false;
  int fd = open(file, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return false;
  struct stat st;
  if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode)) { close(fd); return false; }
  CC_SHA256_CTX context; CC_SHA256_Init(&context);
  unsigned char buffer[1 << 16]; ssize_t n;
  while ((n = read(fd, buffer, sizeof buffer)) > 0) CC_SHA256_Update(&context, buffer, (CC_LONG)n);
  close(fd);
  if (n < 0) return false;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH]; CC_SHA256_Final(digest, &context);
  char hex[65];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) snprintf(hex + 2 * i, 3, "%02x", digest[i]);
  return strcmp(hex, expected) == 0;
}

static void remove_stale_scratch(void) {
  DIR *directory = opendir(scratchRoot);
  if (!directory) return;
  struct dirent *entry;
  while ((entry = readdir(directory))) {
    if (strncmp(entry->d_name, SCRATCH_PREFIX, strlen(SCRATCH_PREFIX)) != 0) continue;
    char stale[PATH_MAX];
    if (snprintf(stale, sizeof stale, "%s/%s", scratchRoot, entry->d_name) < (int)sizeof stale)
      removefile(stale, NULL, REMOVEFILE_RECURSIVE);
  }
  closedir(directory);
}

static void send_exit(session_t *s, int status) {
  xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_string(message, ADAPTER_KEY_OP, "exit");
  xpc_dictionary_set_int64(message, ADAPTER_KEY_STATUS, status);
  xpc_connection_send_message(s->peer, message);
  xpc_release(message);
}

// Ends the worker and every descendant (its own session/process group), reaps it and removes the
// run's scratch directory. Runs on the session queue only.
static int finish(session_t *s) {
  if (s->finished) return -1;
  s->finished = true;
  int status = -1;
  if (s->pid > 0) {
    int raw = 0;
    pid_t reaped = 0;
    for (int i = 0; i < 200 && (reaped = waitpid(s->pid, &raw, WNOHANG)) == 0; i++) usleep(10000);
    kill(-s->pid, SIGKILL);
    if (reaped == 0) { kill(s->pid, SIGKILL); while (waitpid(s->pid, &raw, 0) < 0 && errno == EINTR) {} }
    status = WIFEXITED(raw) ? WEXITSTATUS(raw) : 128 + (WIFSIGNALED(raw) ? WTERMSIG(raw) : 0);
    s->pid = 0;
  }
  if (s->input) { dispatch_io_close(s->input, DISPATCH_IO_STOP); dispatch_release(s->input); s->input = NULL; }
  if (s->output) { dispatch_io_close(s->output, DISPATCH_IO_STOP); dispatch_release(s->output); s->output = NULL; }
  if (s->scratch[0]) { removefile(s->scratch, NULL, REMOVEFILE_RECURSIVE); s->scratch[0] = 0; }
  if (s->counted) { atomic_fetch_sub(&sessions, 1); s->counted = false; }
  return status;
}

static const char *start_worker(session_t *s, const char *id, const char *runToken) {
  if (sandbox_check(getpid(), NULL, 0) != 1) return "SANDBOX_INACTIVE";
  CFTypeRef table = info_value("CodeIntelligenceWorkers");
  CFStringRef key = CFStringCreateWithCString(NULL, id, kCFStringEncodingUTF8);
  CFTypeRef entry = table && CFGetTypeID(table) == CFDictionaryGetTypeID() ? CFDictionaryGetValue(table, key) : NULL;
  CFRelease(key);
  if (!entry || CFGetTypeID(entry) != CFDictionaryGetTypeID()) return "WORKER_UNKNOWN";
  char executable[PATH_MAX], script[PATH_MAX] = {0};
  char *relative = copy_string(entry_value(entry, "executable")), *digest = copy_string(entry_value(entry, "sha256"));
  bool ok = resolve(relative, executable) && sha256_matches(executable, digest);
  free(relative); free(digest);
  if (!ok) return "WORKER_HASH_MISMATCH";
  CFTypeRef scriptValue = entry_value(entry, "script");
  if (scriptValue) {
    relative = copy_string(scriptValue); digest = copy_string(entry_value(entry, "scriptSha256"));
    ok = resolve(relative, script) && sha256_matches(script, digest);
    free(relative); free(digest);
    if (!ok) return "WORKER_HASH_MISMATCH";
  }
  // Only the signed table chooses the environment; the host contributes the run token alone.
  char *environment[MAX_ENVIRONMENT + 5] = {0};
  int count = 0;
  CFTypeRef variables = entry_value(entry, "environment");
  if (variables) {
    if (CFGetTypeID(variables) != CFDictionaryGetTypeID() || CFDictionaryGetCount(variables) > MAX_ENVIRONMENT) return "WORKER_TABLE_INVALID";
    CFIndex size = CFDictionaryGetCount(variables);
    const void *names[MAX_ENVIRONMENT], *values[MAX_ENVIRONMENT];
    CFDictionaryGetKeysAndValues(variables, names, values);
    for (CFIndex i = 0; i < size; i++) {
      char *name = copy_string(names[i]), *value = copy_string(values[i]);
      if (!name || !value || !*name || strchr(name, '=')) { free(name); free(value); goto invalid; }
      asprintf(&environment[count++], "%s=%s", name, value);
      free(name); free(value);
    }
  }
  if (snprintf(s->scratch, sizeof s->scratch, "%s/" SCRATCH_PREFIX "XXXXXXXX", scratchRoot) >= (int)sizeof s->scratch
      || !mkdtemp(s->scratch)) { s->scratch[0] = 0; goto failed; }
  asprintf(&environment[count++], "ADAPTER_RUN_TOKEN=%s", runToken);
  asprintf(&environment[count++], "TMPDIR=%s/", s->scratch);
  asprintf(&environment[count++], "HOME=%s", s->scratch);
  asprintf(&environment[count++], "PATH=/usr/bin:/bin");

  int in[2] = {-1, -1}, out[2] = {-1, -1};
  if (pipe(in) != 0 || pipe(out) != 0) goto failed_pipes;
  posix_spawn_file_actions_t actions; posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_adddup2(&actions, in[0], 0);
  posix_spawn_file_actions_adddup2(&actions, out[1], 1);
  posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0);
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  posix_spawn_file_actions_addchdir_np(&actions, s->scratch);
#pragma clang diagnostic pop
  posix_spawnattr_t attributes; posix_spawnattr_init(&attributes);
  sigset_t none, all; sigemptyset(&none); sigfillset(&all);
  posix_spawnattr_setsigmask(&attributes, &none);
  posix_spawnattr_setsigdefault(&attributes, &all);
  posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);
  char *argv[] = { executable, script[0] ? script : NULL, NULL };
  int rc = posix_spawn(&s->pid, executable, &actions, &attributes, argv, environment);
  posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes);
  close(in[0]); close(out[1]);
  for (int i = 0; i < count; i++) free(environment[i]);
  if (rc != 0) { s->pid = 0; close(in[1]); close(out[0]); return "WORKER_SPAWN_FAILED"; }
  if (sandbox_check(s->pid, NULL, 0) != 1) { close(in[1]); close(out[0]); return "WORKER_NOT_SANDBOXED"; }
  int input = in[1], output = out[0];
  s->references += 2;
  s->input = dispatch_io_create(DISPATCH_IO_STREAM, input, s->queue, ^(int error) { (void)error; close(input); release_session(s); });
  s->output = dispatch_io_create(DISPATCH_IO_STREAM, output, s->queue, ^(int error) { (void)error; close(output); release_session(s); });
  // Deliver each chunk as it arrives: the worker answers a frame and then waits for the next one.
  dispatch_io_set_low_water(s->output, 1);
  dispatch_io_set_high_water(s->output, 1 << 16);
  dispatch_io_read(s->output, 0, SIZE_MAX, s->queue, ^(bool done, dispatch_data_t data, int error) {
    if (s->finished) return;
    if (data && dispatch_data_get_size(data) > 0) {
      s->sent += dispatch_data_get_size(data);
      if (s->sent > MAX_OUTPUT_BYTES) { send_exit(s, finish(s)); return; }
      dispatch_data_apply(data, ^bool(dispatch_data_t region, size_t offset, const void *bytes, size_t size) {
        (void)region; (void)offset;
        xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
        xpc_dictionary_set_string(message, ADAPTER_KEY_OP, "data");
        xpc_dictionary_set_data(message, ADAPTER_KEY_DATA, bytes, size);
        xpc_connection_send_message(s->peer, message);
        xpc_release(message);
        return true;
      });
    }
    if (done || error) send_exit(s, finish(s));
  });
  return NULL;

failed_pipes:
  if (in[0] >= 0) { close(in[0]); close(in[1]); }
failed:
  for (int i = 0; i < count; i++) free(environment[i]);
  return "WORKER_SPAWN_FAILED";
invalid:
  for (int i = 0; i < count; i++) free(environment[i]);
  return "WORKER_TABLE_INVALID";
}

static void handle(session_t *s, xpc_object_t message) {
  const char *op = xpc_dictionary_get_string(message, ADAPTER_KEY_OP);
  if (op && strcmp(op, "open") == 0) {
    xpc_object_t reply = xpc_dictionary_create_reply(message);
    if (!reply) return;
    const char *worker = xpc_dictionary_get_string(message, ADAPTER_KEY_WORKER);
    const char *token = xpc_dictionary_get_string(message, ADAPTER_KEY_RUN_TOKEN);
    const char *code = NULL;
    if (s->opened) code = "SESSION_ALREADY_OPEN";
    else if (!adapter_worker_id_valid(worker) || !adapter_run_token_valid(token)) code = "OPEN_INVALID";
    else if (atomic_fetch_add(&sessions, 1) >= MAX_SESSIONS) { atomic_fetch_sub(&sessions, 1); code = "SUPERVISOR_BUSY"; }
    else { s->counted = true; s->opened = true; code = start_worker(s, worker, token); if (code) finish(s); }
    xpc_dictionary_set_bool(reply, ADAPTER_KEY_OK, code == NULL);
    if (code) xpc_dictionary_set_string(reply, ADAPTER_KEY_CODE, code);
    xpc_connection_send_message(s->peer, reply);
    xpc_release(reply);
    return;
  }
  if (!s->opened || s->finished || !s->input) { xpc_connection_cancel(s->peer); return; }
  if (op && strcmp(op, "data") == 0) {
    size_t length = 0;
    const void *bytes = xpc_dictionary_get_data(message, ADAPTER_KEY_DATA, &length);
    if (!bytes || length == 0 || length > ADAPTER_MAX_CHUNK || s->closed || (s->received += length) > MAX_INPUT_BYTES) {
      send_exit(s, finish(s)); xpc_connection_cancel(s->peer); return;
    }
    dispatch_data_t data = dispatch_data_create(bytes, length, s->queue, DISPATCH_DATA_DESTRUCTOR_DEFAULT);
    dispatch_io_write(s->input, 0, data, s->queue, ^(bool done, dispatch_data_t rest, int error) { (void)done; (void)rest; (void)error; });
    dispatch_release(data);
  } else if (op && strcmp(op, "close") == 0) {
    // Queued writes complete before the worker's stdin is closed.
    if (!s->closed) { s->closed = true; dispatch_io_close(s->input, 0); dispatch_release(s->input); s->input = NULL; }
  } else {
    send_exit(s, finish(s)); xpc_connection_cancel(s->peer);
  }
}

static void connection(xpc_connection_t peer) {
  if (!peerRequirement || xpc_connection_set_peer_code_signing_requirement(peer, peerRequirement) != 0) {
    xpc_connection_cancel(peer);
    return;
  }
  session_t *s = calloc(1, sizeof *s);
  s->peer = peer;
  s->references = 1;
  s->queue = dispatch_queue_create("dev.codeintelligence.adapter.session", DISPATCH_QUEUE_SERIAL);
  xpc_connection_set_target_queue(peer, s->queue);
  xpc_connection_set_event_handler(peer, ^(xpc_object_t event) {
    if (xpc_get_type(event) == XPC_TYPE_DICTIONARY) { handle(s, event); return; }
    // The peer is gone or failed its code requirement: no worker outlives its connection.
    finish(s);
    if (event == XPC_ERROR_CONNECTION_INVALID) release_session(s);
    else xpc_connection_cancel(peer);  // INVALID follows and releases the session
  });
  xpc_connection_resume(peer);
}

int main(void) {
  char executable[PATH_MAX];
  uint32_t size = sizeof executable;
  if (_NSGetExecutablePath(executable, &size) != 0 || !realpath(executable, contents)) return 1;
  // .../AdapterSupervisor.xpc/Contents/MacOS/AdapterSupervisor -> .../AdapterSupervisor.xpc/Contents
  for (int i = 0; i < 2; i++) { char *slash = strrchr(contents, '/'); if (!slash) return 1; *slash = 0; }
  if (confstr(_CS_DARWIN_USER_TEMP_DIR, scratchRoot, sizeof scratchRoot) == 0) return 1;
  size_t length = strlen(scratchRoot);
  if (length > 1 && scratchRoot[length - 1] == '/') scratchRoot[length - 1] = 0;
  remove_stale_scratch();
  peerRequirement = copy_string(info_value("CodeIntelligencePeerRequirement"));
  xpc_main(connection);
}
