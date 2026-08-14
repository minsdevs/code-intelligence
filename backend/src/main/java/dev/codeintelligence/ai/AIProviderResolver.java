package dev.codeintelligence.ai;

@FunctionalInterface
public interface AIProviderResolver {

    AIProvider resolve(long userId);
}
