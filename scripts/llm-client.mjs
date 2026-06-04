export function createLlmClient(env = process.env) {
  const provider = normalizeProvider(env.LLM_PROVIDER || "none");
  if (provider === "rule" || provider === "none" || provider === "off") {
    return null;
  }

  if (provider === "github-models") {
    return openAiCompatibleClient({
      provider,
      baseUrl: env.GITHUB_MODELS_BASE_URL || "https://models.github.ai/inference",
      apiKey: env.GITHUB_MODELS_TOKEN || env.GITHUB_TOKEN,
      model: env.LLM_MODEL || "openai/gpt-4.1-mini",
      extraHeaders: { "X-GitHub-Api-Version": "2022-11-28" }
    });
  }

  if (provider === "groq") {
    return openAiCompatibleClient({
      provider,
      baseUrl: env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
      apiKey: env.GROQ_API_KEY,
      model: env.LLM_MODEL || "llama-3.1-8b-instant"
    });
  }

  if (provider === "ollama") {
    return openAiCompatibleClient({
      provider,
      baseUrl: env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
      apiKey: env.OLLAMA_API_KEY || "ollama",
      model: env.LLM_MODEL || "llama3.1:8b"
    });
  }

  if (provider === "openai-compatible") {
    return openAiCompatibleClient({
      provider,
      baseUrl: env.LLM_BASE_URL,
      apiKey: env.LLM_API_KEY,
      model: env.LLM_MODEL
    });
  }

  throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
}

function openAiCompatibleClient({ provider, baseUrl, apiKey, model, extraHeaders = {} }) {
  if (!baseUrl) throw new Error(`${provider} requires a base URL`);
  if (!apiKey) throw new Error(`${provider} requires an API token`);
  if (!model) throw new Error(`${provider} requires LLM_MODEL`);

  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  return {
    provider,
    model,
    async chatJson(messages, options = {}) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...extraHeaders
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: Number(options.temperature ?? 0.1),
          max_tokens: Number(options.maxTokens ?? 1800)
        })
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(`${provider} HTTP ${response.status}: ${text.slice(0, 800)}`);
      }

      const payload = JSON.parse(text);
      const content = payload.choices?.[0]?.message?.content || "";
      return parseJsonContent(content);
    }
  };
}

function parseJsonContent(content) {
  const text = String(content || "").trim();
  if (!text) throw new Error("LLM returned an empty response");

  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(fenced.trim());

    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    }
  }

  throw new Error(`LLM response was not JSON: ${text.slice(0, 300)}`);
}

function normalizeProvider(value) {
  return String(value || "rule").trim().toLowerCase();
}
