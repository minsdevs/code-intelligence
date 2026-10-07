// ADR-01 spike host: connects to the embedded supervisor XPC service and prints its reply.
#include <dispatch/dispatch.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <xpc/xpc.h>
int main(int argc, char **argv) {
  if (argc < 4) return 2;
  xpc_connection_t c = xpc_connection_create("dev.codeintelligence.spike.adr01.supervisor", NULL);
  xpc_connection_set_event_handler(c, ^(xpc_object_t e) { if (e == XPC_ERROR_CONNECTION_INVALID) fprintf(stderr, "XPC_CONNECTION_INVALID\n"); });
  xpc_connection_resume(c);
  const char *source = "export const answer: number = 42;\nfunction twice(x: number) { return x * 2; }\nclass Box { value = twice(answer); }\n";
  xpc_object_t m = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_data(m, "source", source, strlen(source));
  xpc_dictionary_set_string(m, "sentinel", argv[1]); xpc_dictionary_set_string(m, "writeTarget", argv[2]); xpc_dictionary_set_string(m, "port", argv[3]);
  xpc_object_t r = xpc_connection_send_message_with_reply_sync(c, m);
  if (xpc_get_type(r) != XPC_TYPE_DICTIONARY) { char *d = xpc_copy_description(r); printf("XPC_ERROR %s\n", d); return 1; }
  for (const char *k[] = { "supervisor", "java", "node", "probe", NULL }, **p = k; *p; p++) printf("== %s\n%s\n", *p, xpc_dictionary_get_string(r, *p));
  return 0;
}
