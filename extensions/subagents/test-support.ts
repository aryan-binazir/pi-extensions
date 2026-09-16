// Synthetic catalog; no authentication files or provider requests in fixtures.
export function fixtureModelRegistry() {
  const models = ['test/fixture', 'test/selected', 'test/different', 'openai-codex/gpt-6-astra', 'openai-codex/gpt-5.6-luna'].map(value => {
    const [provider, id] = value.split('/'); return {provider, id, reasoning: true};
  });
  return {
    find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
    getAvailable: () => models,
    getApiKeyAndHeaders: async () => ({ok: false, error: 'Fixture tracker unavailable'}),
  };
}
