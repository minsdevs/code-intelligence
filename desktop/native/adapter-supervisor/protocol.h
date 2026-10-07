// ADR-01 bridge <-> supervisor XPC messages. Both sides are built from this one header.
//
// bridge -> supervisor: {op:"open", worker, runToken} (reply {ok, code}), then {op:"data", data}
//                       chunks of the host's stdin and one {op:"close"} at its end.
// supervisor -> bridge: {op:"data", data} chunks of the worker's stdout, then {op:"exit", status}.
// Neither side parses the adapter frames: the host checks the run-token handshake and every frame.
#ifndef CODE_INTELLIGENCE_ADAPTER_PROTOCOL_H
#define CODE_INTELLIGENCE_ADAPTER_PROTOCOL_H

#define ADAPTER_SERVICE_BUNDLE "Contents/XPCServices/AdapterSupervisor.xpc"
#define ADAPTER_KEY_OP "op"
#define ADAPTER_KEY_WORKER "worker"
#define ADAPTER_KEY_RUN_TOKEN "runToken"
#define ADAPTER_KEY_DATA "data"
#define ADAPTER_KEY_OK "ok"
#define ADAPTER_KEY_CODE "code"
#define ADAPTER_KEY_STATUS "status"
#define ADAPTER_MAX_CHUNK (1 << 20)
#define ADAPTER_MAX_WORKER_ID 32
#define ADAPTER_RUN_TOKEN_LENGTH 64

// Bridge exit status, read by desktop/src/adapter-isolation.cjs.
#define BRIDGE_EXIT_WORKER_ENDED 0
#define BRIDGE_EXIT_USAGE 64
#define BRIDGE_EXIT_SERVICE_UNAVAILABLE 69
#define BRIDGE_EXIT_WORKER_REFUSED 70
#define BRIDGE_EXIT_WORKER_FAILED 71
#define BRIDGE_EXIT_IO 74

static inline int adapter_worker_id_valid(const char *value) {
  if (!value || !*value) return 0;
  size_t length = 0;
  for (const char *c = value; *c; c++, length++) {
    if (length >= ADAPTER_MAX_WORKER_ID) return 0;
    if (!((*c >= 'a' && *c <= 'z') || (*c >= '0' && *c <= '9') || *c == '-')) return 0;
  }
  return 1;
}

static inline int adapter_run_token_valid(const char *value) {
  if (!value) return 0;
  size_t length = 0;
  for (const char *c = value; *c; c++, length++) {
    if (length >= ADAPTER_RUN_TOKEN_LENGTH) return 0;
    if (!((*c >= '0' && *c <= '9') || (*c >= 'a' && *c <= 'f'))) return 0;
  }
  return length == ADAPTER_RUN_TOKEN_LENGTH;
}

#endif
