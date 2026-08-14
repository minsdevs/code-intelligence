package dev.codeintelligence.ai;

public class NoOpAIProvider implements AIProvider {

    @Override
    public boolean enabled() {
        return false;
    }

    @Override
    public String name() {
        return "none";
    }

    @Override
    public ChatResponse chat(ChatRequest request) {
        throw new AiNotConfiguredException();
    }

    @Override
    public void stream(ChatRequest request, TokenConsumer consumer) {
        throw new AiNotConfiguredException();
    }

    @Override
    public float[] embed(String text) {
        throw new AiNotConfiguredException();
    }
}
