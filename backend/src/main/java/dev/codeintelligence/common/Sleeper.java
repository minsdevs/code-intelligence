package dev.codeintelligence.common;

import java.time.Duration;

/** Injectable wait so GitHub rate-limit backoff is testable without {@code Thread.sleep}. */
@FunctionalInterface
public interface Sleeper {

    void sleep(Duration duration) throws InterruptedException;
}
