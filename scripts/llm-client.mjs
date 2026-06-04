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
      timeoutMs: Number(env.LLM_REQUEST_TIMEOUT_MS || 45000),
      extraHeaders: { "X-GitHub-Api-Version": "2022-11-28" }
    });
  }

  if (provider === "groq") {
    return openAiCompatibleClient({
      provider,
      baseUrl: env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
      apiKey: env.GROQ_API_KEY,
      model: env.LLM_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct",
      timeoutMs: Number(env.LLM_REQUEST_TIMEOUT_MS || 45000)
    });
  }

  if (provider === "ollama") {
    return openAiCompatibleClient({
      provider,
      baseUrl: env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
      apiKey: env.OLLAMA_API_KEY || "ollama",
      model: env.LLM_MODEL || "llama3.1:8b",
      timeoutMs: Number(env.LLM_REQUEST_TIMEOUT_MS || 120000)
    });
  }

  if (provider === "openai-compatible") {
    return openAiCompatibleClient({
      provider,
      baseUrl: env.LLM_BASE_URL,
      apiKey: env.LLM_API_KEY,
      model: env.LLM_MODEL,
      timeoutMs: Number(env.LLM_REQUEST_TIMEOUT_MS || 45000)
    });
  }

  throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
}

function openAiCompatibleClient({ provider, baseUrl, apiKey, model, extraHeaders = {}, timeoutMs = 45000 }) {
  if (!baseUrl) throw new Error(`${provider} requires a base URL`);
  if (!apiKey) throw new Error(`${provider} requires an API token`);
  if (!model) throw new Error(`${provider} requires LLM_MODEL`);

  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  return {
    provider,
    model,
    async chatJson(messages, options = {}) {
      const result = await this.chatJsonWithMeta(messages, options);
      return result.parsed;
    },
    async chatJsonWithMeta(messages, options = {}) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || timeoutMs));
      const requestBody = {
        model,
        messages,
        temperature: Number(options.temperature ?? 0.1),
        max_tokens: Number(options.maxTokens ?? 1800)
      };
      let response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Accept": "application/json",
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            ...extraHeaders
          },
          body: JSON.stringify(requestBody)
        });
      } catch (error) {
        if (error?.name === "AbortError") {
          throw withLlmDebug(new Error(`${provider} request timed out after ${Number(options.timeoutMs || timeoutMs)}ms`), {
            provider,
            model,
            endpoint,
            request: summarizeRequest(requestBody),
            error_type: "timeout"
          });
        }
        throw withLlmDebug(error, {
          provider,
          model,
          endpoint,
          request: summarizeRequest(requestBody),
          error_type: "network"
        });
      } finally {
        clearTimeout(timeout);
      }

      const text = await response.text();
      if (!response.ok) {
        throw withLlmDebug(new Error(`${provider} HTTP ${response.status}: ${text.slice(0, 800)}`), {
          provider,
          model,
          endpoint,
          request: summarizeRequest(requestBody),
          http_status: response.status,
          raw_response: text,
          error_type: "http"
        });
      }

      let payload;
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw withLlmDebug(new Error(`${provider} response was not JSON: ${text.slice(0, 300)}`), {
          provider,
          model,
          endpoint,
          request: summarizeRequest(requestBody),
          http_status: response.status,
          raw_response: text,
          error_type: "response-json-parse"
        });
      }
      const content = payload.choices?.[0]?.message?.content || "";
      try {
        return {
          parsed: parseJsonContent(content),
          raw_content: content,
          raw_response: text,
          response: summarizeResponsePayload(payload),
          request: summarizeRequest(requestBody)
        };
      } catch (error) {
        throw withLlmDebug(error, {
          provider,
          model,
          endpoint,
          request: summarizeRequest(requestBody),
          http_status: response.status,
          raw_response: text,
          raw_content: content,
          response: summarizeResponsePayload(payload),
          error_type: "content-json-parse"
        });
      }
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

function withLlmDebug(error, debug) {
  if (error && typeof error === "object") {
    error.llmDebug = debug;
  }
  return error;
}

function summarizeRequest(requestBody) {
  return {
    model: requestBody.model,
    temperature: requestBody.temperature,
    max_tokens: requestBody.max_tokens,
    message_count: requestBody.messages.length,
    messages: requestBody.messages.map((message) => ({
      role: message.role,
      char_count: String(message.content || "").length,
      preview: String(message.content || "").slice(0, 500)
    }))
  };
}

function summarizeResponsePayload(payload) {
  return {
    id: payload.id,
    model: payload.model,
    usage: payload.usage,
    finish_reason: payload.choices?.[0]?.finish_reason,
    content_char_count: String(payload.choices?.[0]?.message?.content || "").length
  };
}
