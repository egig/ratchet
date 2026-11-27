import { defineModel, field } from '../../core/index.js';

/**
 * A saved API credential + endpoint. `Agent.providerId` references one of these so an agent
 * picks a `Provider` instead of typing an API key (or an env var name) directly. `apiKey` is
 * `sensitive: true` (see `core/serialize.ts`) — stored in plain, read server-side by
 * `runAgentTurn` (src/automation/run-turn.ts), but stripped from every HTTP response the same
 * way `Account.password` is.
 */
export const Provider = defineModel('providers', {
  fields: {
    name: field.string({ required: true, unique: true, indexed: true, maxLength: 255 }),
    // which wire protocol this credential speaks — picks the LangChain chat model in
    // `src/automation/model-factory.ts` (`ChatAnthropic` vs `ChatOpenAI`). `run-turn.ts` reads it
    // off this row, never off the `Agent` (an agent only chooses *which* Provider via `providerId`).
    kind: field.enum(['anthropic', 'openai'], { default: 'openai', indexed: true }),
    // base URL override — meaningful to the `openai` kind (Azure OpenAI, Groq, Together,
    // OpenRouter, local vLLM/Ollama, ...); left blank to use a provider's default endpoint.
    url: field.string({ required: false, maxLength: 2048 }),
    apiKey: field.string({ required: true, sensitive: true, maxLength: 512, displayText: 'API Key', writeAs: "apiKey" }),
  },
  console: { label: 'Providers', displayField: 'name' },
});
