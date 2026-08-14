package dev.codeintelligence.ai;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

@TestConfiguration
public class MockAiTestConfig {

    @Bean
    @Primary
    MockAIProvider mockAIProvider() {
        return new MockAIProvider();
    }
}
