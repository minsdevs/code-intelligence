// ADR-01 adapter bridge: Electron main's only path to this app's AdapterSupervisor XPC service
// (Electron has no XPC binding). stdin starts with one line "open <worker> <run-token>\n"; the rest
// of stdin is relayed to the worker and the worker's output to stdout, unparsed. The run token
// travels on stdin, never in argv or the environment. Exit status: see protocol.h.
#include <CoreFoundation/CoreFoundation.h>
#include <dispatch/dispatch.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <xpc/xpc.h>
#include "protocol.h"

#define OPEN_TIMEOUT_SECONDS 30

static xpc_connection_t service;
static volatile int opened;

static void fail(int status, const char *code) {
  dprintf(2, "ADAPTER_BRIDGE %s\n", code);
  _exit(status);
}

static void write_all(const void *bytes, size_t length) {
  const char *cursor = bytes;
  while (length > 0) {
    ssize_t n = write(1, cursor, length);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) fail(BRIDGE_EXIT_IO, "STDOUT_FAILED");
    cursor += n; length -= (size_t)n;
  }
}

// The service identifier comes from the embedded bundle of the app this bridge belongs to.
static char *service_name(void) {
  CFURLRef app = CFBundleCopyBundleURL(CFBundleGetMainBundle());
  if (!app) return NULL;
  CFURLRef url = CFURLCreateCopyAppendingPathComponent(NULL, app, CFSTR(ADAPTER_SERVICE_BUNDLE), true);
  CFRelease(app);
  CFBundleRef bundle = url ? CFBundleCreate(NULL, url) : NULL;
  if (url) CFRelease(url);
  CFStringRef identifier = bundle ? CFBundleGetIdentifier(bundle) : NULL;
  char *result = NULL;
  if (identifier) {
    result = calloc(1, 256);
    if (!CFStringGetCString(identifier, result, 256, kCFStringEncodingUTF8)) { free(result); result = NULL; }
  }
  if (bundle) CFRelease(bundle);
  return result;
}

static int read_open_line(char *worker, char *token) {
  char line[128];
  size_t used = 0;
  for (;;) {
    char c;
    ssize_t n = read(0, &c, 1);
    if (n < 0 && errno == EINTR) continue;
    if (n != 1) return 0;
    if (c == '\n') break;
    if (used + 1 >= sizeof line) return 0;
    line[used++] = c;
  }
  line[used] = 0;
  char *save = NULL, *verb = strtok_r(line, " ", &save), *id = strtok_r(NULL, " ", &save), *run = strtok_r(NULL, " ", &save);
  if (!verb || strcmp(verb, "open") != 0 || strtok_r(NULL, " ", &save)) return 0;
  if (!adapter_worker_id_valid(id) || !adapter_run_token_valid(run)) return 0;
  strlcpy(worker, id, ADAPTER_MAX_WORKER_ID + 1);
  strlcpy(token, run, ADAPTER_RUN_TOKEN_LENGTH + 1);
  return 1;
}

int main(void) {
  char worker[ADAPTER_MAX_WORKER_ID + 1], token[ADAPTER_RUN_TOKEN_LENGTH + 1];
  if (!read_open_line(worker, token)) fail(BRIDGE_EXIT_USAGE, "OPEN_LINE_INVALID");
  char *name = service_name();
  if (!name) fail(BRIDGE_EXIT_SERVICE_UNAVAILABLE, "SERVICE_BUNDLE_MISSING");
  dispatch_queue_t queue = dispatch_queue_create("dev.codeintelligence.adapter.bridge", DISPATCH_QUEUE_SERIAL);
  service = xpc_connection_create(name, queue);
  free(name);
  xpc_connection_set_event_handler(service, ^(xpc_object_t event) {
    if (xpc_get_type(event) != XPC_TYPE_DICTIONARY) {
      fail(opened ? BRIDGE_EXIT_WORKER_FAILED : BRIDGE_EXIT_SERVICE_UNAVAILABLE, "SERVICE_CONNECTION_LOST");
    }
    const char *op = xpc_dictionary_get_string(event, ADAPTER_KEY_OP);
    if (op && strcmp(op, "data") == 0) {
      size_t length = 0;
      const void *bytes = xpc_dictionary_get_data(event, ADAPTER_KEY_DATA, &length);
      if (bytes && length) write_all(bytes, length);
    } else if (op && strcmp(op, "exit") == 0) {
      _exit(xpc_dictionary_get_int64(event, ADAPTER_KEY_STATUS) == 0 ? BRIDGE_EXIT_WORKER_ENDED : BRIDGE_EXIT_WORKER_FAILED);
    }
  });
  xpc_connection_resume(service);

  xpc_object_t open = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_string(open, ADAPTER_KEY_OP, "open");
  xpc_dictionary_set_string(open, ADAPTER_KEY_WORKER, worker);
  xpc_dictionary_set_string(open, ADAPTER_KEY_RUN_TOKEN, token);
  memset(token, 0, sizeof token);
  dispatch_semaphore_t answered = dispatch_semaphore_create(0);
  __block int status = BRIDGE_EXIT_SERVICE_UNAVAILABLE;
  static char code[64] = "SERVICE_UNAVAILABLE";
  xpc_connection_send_message_with_reply(service, open, queue, ^(xpc_object_t reply) {
    if (xpc_get_type(reply) == XPC_TYPE_DICTIONARY) {
      if (xpc_dictionary_get_bool(reply, ADAPTER_KEY_OK)) status = 0;
      else {
        status = BRIDGE_EXIT_WORKER_REFUSED;
        const char *refused = xpc_dictionary_get_string(reply, ADAPTER_KEY_CODE);
        strlcpy(code, refused ? refused : "WORKER_REFUSED", sizeof code);
      }
    }
    if (status == 0) opened = 1;
    dispatch_semaphore_signal(answered);
  });
  xpc_release(open);
  if (dispatch_semaphore_wait(answered, dispatch_time(DISPATCH_TIME_NOW, OPEN_TIMEOUT_SECONDS * NSEC_PER_SEC)) != 0) {
    fail(BRIDGE_EXIT_SERVICE_UNAVAILABLE, "OPEN_TIMEOUT");
  }
  if (status != 0) fail(status, code);

  static char buffer[1 << 16];
  for (;;) {
    ssize_t n = read(0, buffer, sizeof buffer);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) fail(BRIDGE_EXIT_IO, "STDIN_FAILED");
    xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
    if (n == 0) {
      xpc_dictionary_set_string(message, ADAPTER_KEY_OP, "close");
      xpc_connection_send_message(service, message);
      xpc_release(message);
      break;
    }
    xpc_dictionary_set_string(message, ADAPTER_KEY_OP, "data");
    xpc_dictionary_set_data(message, ADAPTER_KEY_DATA, buffer, (size_t)n);
    xpc_connection_send_message(service, message);
    xpc_release(message);
  }
  dispatch_main();
}
