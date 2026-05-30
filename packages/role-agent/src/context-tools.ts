import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { SessionContextStore } from "./context-store.ts";

const setContextSchema = Type.Object({
	scope: Type.Optional(Type.Literal("session", { description: "Only session scope is supported in the role-agent MVP" })),
	key: Type.String({ description: "Stable context key. Setting an existing key overwrites its content." }),
	content: Type.String({ description: "Context content to inject into every prompt for this session." }),
});

type SetContextParams = Static<typeof setContextSchema>;

const unsetContextSchema = Type.Object({
	scope: Type.Optional(Type.Literal("session", { description: "Only session scope is supported in the role-agent MVP" })),
	key: Type.String({ description: "Context key to remove." }),
});

type UnsetContextParams = Static<typeof unsetContextSchema>;

const listContextSchema = Type.Object({
	scope: Type.Optional(Type.Literal("session", { description: "Only session scope is supported in the role-agent MVP" })),
});

type ListContextParams = Static<typeof listContextSchema>;

type ContextToolDetails = { action: "set" | "list" | "unset"; key?: string; count?: number; removed?: boolean };

type ContextToolResult = AgentToolResult<ContextToolDetails>;

function textResult(text: string, details: ContextToolDetails): ContextToolResult {
	return { content: [{ type: "text", text }], details };
}

function ensureSessionScope(scope: "session" | undefined): void {
	if (scope !== undefined && scope !== "session") {
		throw new Error("role-agent MVP only supports session context scope");
	}
}

export function createContextTools(store: SessionContextStore): AgentTool[] {
	return [createSetContextTool(store), createListContextTool(store), createUnsetContextTool(store)];
}

export function createSetContextTool(store: SessionContextStore): AgentTool<typeof setContextSchema, ContextToolDetails> {
	return {
		label: "Set Session Context",
		name: "set_context",
		description: `Set or overwrite session-scoped context that is injected into every prompt. Limits: ${store.limits.maxKeyChars} characters per key, ${store.limits.maxChars} characters per item, ${store.limits.maxTotalChars} total injected characters, ${store.limits.maxItems} items.`,
		parameters: setContextSchema,
		execute: async (_toolCallId: string, params: SetContextParams) => {
			ensureSessionScope(params.scope);
			const item = store.set({ scope: "session", key: params.key, content: params.content, source: "tool" });
			return textResult(`Set session context '${item.key}'.`, { action: "set", key: item.key });
		},
	};
}

export function createListContextTool(store: SessionContextStore): AgentTool<typeof listContextSchema, ContextToolDetails> {
	return {
		label: "List Session Context",
		name: "list_context",
		description: "List session-scoped context currently injected into every prompt.",
		parameters: listContextSchema,
		execute: async (_toolCallId: string, params: ListContextParams) => {
			ensureSessionScope(params.scope);
			const items = store.list();
			if (items.length === 0) return textResult("No session context is set.", { action: "list", count: 0 });
			const lines = items.map((item) => `- ${item.key}: ${item.content}`);
			return textResult(lines.join("\n"), { action: "list", count: items.length });
		},
	};
}

export function createUnsetContextTool(store: SessionContextStore): AgentTool<typeof unsetContextSchema, ContextToolDetails> {
	return {
		label: "Unset Session Context",
		name: "unset_context",
		description: "Remove a session-scoped context item.",
		parameters: unsetContextSchema,
		execute: async (_toolCallId: string, params: UnsetContextParams) => {
			ensureSessionScope(params.scope);
			const removed = store.unset({ scope: "session", key: params.key });
			return textResult(removed ? `Removed session context '${params.key}'.` : `Session context '${params.key}' was not set.`, {
				action: "unset",
				key: params.key,
				removed,
			});
		},
	};
}
