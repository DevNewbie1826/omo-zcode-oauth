declare module "@earendil-works/pi-ai/compat" {
  export interface OAuthCredentials {
    access: string;
    refresh?: string;
    expires?: number;
    email?: string;
    accountId?: string;
  }

  export interface OAuthLoginCallbacks {
    onAuth: (info: { url: string; instructions?: string }) => void;
    onPrompt: (options: { message: string }) => Promise<string>;
    onManualCodeInput?: () => Promise<string>;
    onDeviceCode?: (...args: unknown[]) => void;
    onSelect?: (...args: unknown[]) => Promise<unknown>;
    onProgress?: (message: string) => void;
    signal?: AbortSignal;
  }
}

declare module "@code-yeongyu/senpi" {
  export interface ProviderModelConfig {
    id: string;
    name: string;
    reasoning: boolean;
    input: string[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  }

  export interface ExtensionAPI {
    registerProvider: (name: string, config: unknown) => void;
  }
}
