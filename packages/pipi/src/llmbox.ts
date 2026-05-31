import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentHarnessOptions } from "@earendil-works/pi-agent-core/node";

export const LLMBOX_BASE_URL = "https://llmbox.bytedance.net/v1";
export const LLMBOX_SOURCE = "caijing-pay-aicoding";
export const LLMBOX_EXTENDED_SUFFIX = "[1m]";
export const LLMBOX_EXTENDED_CONTEXT_WINDOW = 1_000_000;
export const LLMBOX_EXTENDED_AUTO_COMPACT = 900_000;
export const LLMBOX_DEFAULT_MODEL_PATH = join(homedir(), ".pyllmbox", "default-models.json");
export const LLMBOX_TOKEN_PATH = join(homedir(), ".pyllmbox", "cache", "accesstoken");

export interface LlmboxModelOptions {
	modelId?: string;
	baseUrl?: string;
	source?: string;
	projectRoot?: string;
	repoInfo?: Record<string, unknown> | string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	stripExtendedSuffix?: boolean;
}

export interface LlmboxAuthOptions {
	apiKey?: string;
	env?: NodeJS.ProcessEnv;
	source?: string;
	projectRoot?: string;
	repoInfo?: Record<string, unknown> | string;
	extraHeaders?: Record<string, string>;
}

export function createLlmboxModel(options: LlmboxModelOptions = {}): Model<"openai-responses"> {
	const modelId = options.modelId ?? resolveLlmboxDefaultModel();
	const source = options.source ?? LLMBOX_SOURCE;
	const requestModelId = options.stripExtendedSuffix === false ? modelId : stripLlmboxExtendedSuffix(modelId);
	const contextWindow = isLlmboxExtendedModel(modelId) ? LLMBOX_EXTENDED_CONTEXT_WINDOW : (options.contextWindow ?? 200_000);
	return {
		id: requestModelId,
		name: modelId,
		api: "openai-responses",
		provider: "llmbox",
		baseUrl: options.baseUrl ?? LLMBOX_BASE_URL,
		reasoning: options.reasoning ?? false,
		input: ["text", "image"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow,
		maxTokens: options.maxTokens ?? 32_768,
		headers: createLlmboxHeaders({
			source,
			projectRoot: options.projectRoot,
			repoInfo: options.repoInfo,
		}),
		compat: {
			sendSessionIdHeader: false,
			supportsLongCacheRetention: false,
		},
	};
}

export function createLlmboxGetApiKeyAndHeaders(
	options: LlmboxAuthOptions = {},
): NonNullable<AgentHarnessOptions["getApiKeyAndHeaders"]> {
	return async () => ({
		apiKey: resolveLlmboxApiKey(options),
		headers: {
			...createLlmboxHeaders(options),
			...options.extraHeaders,
		},
	});
}

export function resolveLlmboxApiKey(options: LlmboxAuthOptions = {}): string {
	const env = options.env ?? process.env;
	const raw = options.apiKey ?? env.LLMBOX_API_KEY ?? env.LLMGW_OPENAI_API_KEY ?? env.OPENAI_API_KEY ?? readLlmboxCachedToken();
	if (!raw) {
		throw new Error(
			`Missing llmbox API key. Set LLMBOX_API_KEY, LLMGW_OPENAI_API_KEY, OPENAI_API_KEY, or run llmbox login to populate ${LLMBOX_TOKEN_PATH}.`,
		);
	}
	return raw.startsWith("at-") ? raw : `at-${raw}`;
}

export function resolveLlmboxDefaultModel(agent = "pipi", path = LLMBOX_DEFAULT_MODEL_PATH): string {
	try {
		const raw = readFileSync(path, "utf8");
		const defaults = JSON.parse(raw) as Record<string, unknown>;
		const model = defaults[agent];
		if (typeof model === "string" && model.trim()) return model;
	} catch {
		// Fall through to the actionable error below.
	}
	throw new Error(`Missing llmbox default model for ${agent}. Run llmbox switch ${agent} first.`);
}

export function readLlmboxCachedToken(path = LLMBOX_TOKEN_PATH, nowSeconds = Math.floor(Date.now() / 1000)): string | undefined {
	try {
		const [timestampLine, tokenLine] = readFileSync(path, "utf8").split("\n");
		const timestamp = Number(timestampLine);
		const token = tokenLine?.trim();
		if (!token || !Number.isFinite(timestamp)) return undefined;
		if (nowSeconds - timestamp >= 29 * 24 * 3600) return undefined;
		return token.startsWith("at-") ? token : `at-${token}`;
	} catch {
		return undefined;
	}
}

export function createLlmboxHeaders(options: {
	source?: string;
	projectRoot?: string;
	repoInfo?: Record<string, unknown> | string;
}): Record<string, string> {
	const headers: Record<string, string> = {
		"x-source": options.source ?? LLMBOX_SOURCE,
	};
	if (options.projectRoot) headers["x-project-root"] = options.projectRoot;
	if (options.repoInfo !== undefined) {
		headers["x-repo-info"] = typeof options.repoInfo === "string" ? options.repoInfo : JSON.stringify(options.repoInfo);
	}
	return headers;
}

export function isLlmboxExtendedModel(modelId: string): boolean {
	return modelId.endsWith(LLMBOX_EXTENDED_SUFFIX);
}

export function stripLlmboxExtendedSuffix(modelId: string): string {
	return isLlmboxExtendedModel(modelId) ? modelId.slice(0, -LLMBOX_EXTENDED_SUFFIX.length) : modelId;
}
