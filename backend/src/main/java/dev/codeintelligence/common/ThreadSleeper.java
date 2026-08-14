package dev.codeintelligence.common;

import java.time.Duration;
import org.springframework.stereotype.Component;

@Component
public class ThreadSleeper implements Sleeper {

    @Override
    public void sleep(Duration duration) throws InterruptedException {
        if (duration == null || duration.isZero() || duration.isNegative()) {
            return;
        }
        Thread.sleep(duration.toMillis());
    }
}
