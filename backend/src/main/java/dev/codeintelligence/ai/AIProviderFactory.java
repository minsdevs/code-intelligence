package dev.codeintelligence.ai;

@FunctionalInterface
public interface AIProviderFactory {

    AIProvider create(String provider, String apiKey, String model);
}
