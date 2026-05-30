import type { ContextItem } from "./context-store.ts";
import type { RoleDefinition } from "./role-loader.ts";

export interface RolePromptParts {
	baseSystemPrompt?: string;
	role: RoleDefinition;
	sessionContext: ContextItem[];
}

export function buildRoleSystemPrompt(parts: RolePromptParts): string {
	const sections: string[] = [];
	const base = parts.baseSystemPrompt?.trim();
	if (base) sections.push(`# Base Instructions\n${base}`);
	sections.push(`# ROLE.md\n${parts.role.content.trim()}`);
	if (parts.sessionContext.length > 0) {
		sections.push(`# Session Context\n${formatSessionContext(parts.sessionContext)}`);
	}
	return sections.join("\n\n");
}

function formatSessionContext(items: ContextItem[]): string {
	return items.map((item) => `- ${item.key}: ${item.content}`).join("\n");
}
