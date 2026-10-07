// ADR-01 spike probe: attempts what a compromised parser would do and reports each outcome.
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
extern int sandbox_check(pid_t pid, const char *operation, int type, ...);

static const char *outcome(int ok, int err) { static char b[64]; if (ok) return "ALLOWED"; snprintf(b, sizeof b, "DENIED(%s)", strerror(err)); return b; }

int main(int argc, char **argv) {
  const char *sentinel = argc > 1 ? argv[1] : "", *writeTarget = argc > 2 ? argv[2] : "";
  int port = argc > 3 ? atoi(argv[3]) : 9;
  printf("{\"label\":\"%s\",\"pid\":%d,\"sandboxed\":%d", argc > 4 ? argv[4] : "probe", getpid(), sandbox_check(getpid(), NULL, 0));
  int fd = open(sentinel, O_RDONLY); char buf[64] = {0}; int e = errno; int ok = fd >= 0 && read(fd, buf, sizeof buf - 1) > 0;
  printf(",\"readOutsideFile\":\"%s\"", outcome(ok, ok ? 0 : (fd < 0 ? e : errno))); if (fd >= 0) close(fd);
  fd = open(writeTarget, O_WRONLY | O_CREAT | O_EXCL, 0600); e = errno;
  printf(",\"createOutsideFile\":\"%s\"", outcome(fd >= 0, e)); if (fd >= 0) { close(fd); unlink(writeTarget); }
  struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(port) }; inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
  int s = socket(AF_INET, SOCK_STREAM, 0); e = errno;
  if (s < 0) printf(",\"tcpConnectLoopback\":\"%s\"", outcome(0, e));
  else { ok = connect(s, (struct sockaddr *)&a, sizeof a) == 0; e = errno; printf(",\"tcpConnectLoopback\":\"%s\"", outcome(ok, e)); if (ok) write(s, argc > 4 ? argv[4] : "probe", strlen(argc > 4 ? argv[4] : "probe")); close(s); }
  s = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in l = { .sin_family = AF_INET, .sin_port = 0 }; inet_pton(AF_INET, "127.0.0.1", &l.sin_addr);
  if (s < 0) printf(",\"tcpListenLoopback\":\"%s\"", outcome(0, errno));
  else { ok = bind(s, (struct sockaddr *)&l, sizeof l) == 0 && listen(s, 1) == 0; e = errno; printf(",\"tcpListenLoopback\":\"%s\"", outcome(ok, e)); close(s); }
  s = socket(AF_INET, SOCK_DGRAM, 0); e = errno;
  if (s < 0) printf(",\"udpSendLoopback\":\"%s\"", outcome(0, e));
  else { ok = sendto(s, argc > 4 ? argv[4] : "probe", strlen(argc > 4 ? argv[4] : "probe"), 0, (struct sockaddr *)&a, sizeof a) > 0; e = errno; printf(",\"udpSendLoopback\":\"%s\"", outcome(ok, e)); close(s); }
  struct addrinfo *res = NULL; int g = getaddrinfo("example.com", "443", NULL, &res);
  printf(",\"dnsResolve\":\"%s\"}\n", g == 0 ? "ALLOWED" : gai_strerror(g)); if (res) freeaddrinfo(res);
  return 0;
}
