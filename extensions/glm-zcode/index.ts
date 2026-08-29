import type { ExtensionAPI, ProviderModelConfig } from "@code-yeongyu/senpi";
import type { OAuthCredentials } from "@earendil-works/pi-ai/compat";
import { loginGlmZcode, refreshGlmZcode } from "./oauth.js";

const MODELS = [
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
  },
] satisfies ProviderModelConfig[];

export default function glmZcodeExtension(pi: ExtensionAPI): void {
  pi.registerProvider("glm-zcode", {
    name: "GLM ZCode (unofficial)",
    baseUrl: "https://api.z.ai/api/anthropic",
    api: "anthropic-messages",
    authHeader: true,
    headers: { "User-Agent": "ZCode/3.1.2", "X-ZCode-Agent": "glm", "X-ZCode-Version": "3.1.2" },
    models: MODELS,
    oauth: {
      name: "GLM ZCode (unofficial)",
      login: loginGlmZcode,
      refreshToken: refreshGlmZcode,
      getApiKey: (credentials: OAuthCredentials) => credentials.access,
    },
  });
}
