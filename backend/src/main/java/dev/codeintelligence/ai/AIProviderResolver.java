package dev.codeintelligence.ai;

@FunctionalInterface
public interface AIProviderResolver {
    default String blockedReason() {
        return null;
    }

    AIProvider resolve(long userId);
}
