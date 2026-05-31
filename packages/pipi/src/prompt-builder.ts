import type { ContextItem } from "./context-store.ts";
import type { RoleDefinition } from "./role-loader.ts";
import type { PipiSkill } from "./skills.ts";
import type { ToolMode } from "./workspace-tools.ts";

export interface RolePromptParts {
	baseSystemPrompt?: string;
	role: RoleDefinition;
	sessionContext: ContextItem[];
	skills: PipiSkill[];
	toolMode: ToolMode;
}

export function buildRoleSystemPrompt(parts: RolePromptParts): string {
	const sections: string[] = [];
	const base = parts.baseSystemPrompt?.trim();
	if (base) sections.push(`# Base Instructions\n${base}`);
	sections.push(`# ROLE.md\n${parts.role.content.trim()}`);
	sections.push(formatSkills(parts.skills));
	sections.push(formatTools(parts.toolMode));
	if (parts.sessionContext.length > 0) {
		sections.push(`# Session Context\n${formatSessionContext(parts.sessionContext)}`);
	}
	return sections.join("\n\n");
}

function formatSkills(skills: PipiSkill[]): string {
	if (skills.length === 0) {
		return [
			"# Enabled Skills",
			"No skills are currently loaded.",
			"If the user asks what skills are enabled, what skills you have, or similar, answer exactly that no skills are currently enabled.",
			"Do not list general model abilities such as Q&A, writing, translation, coding, planning, or brainstorming as skills.",
			"Do not claim any skill is installed or callable.",
		].join("\n");
	}
	return [
		"# Enabled Skills",
		"These are the only skills currently enabled. If the user asks what skills are enabled, list only these skills by name and description.",
		"These are instruction-only skills. They do not grant tool permissions or external-system access by themselves.",
		"Do not list general model abilities such as Q&A, writing, translation, coding, planning, or brainstorming as skills.",
		...skills.map((skill) => `## ${skill.name}\nDescription: ${skill.description || "(none)"}\n\n${skill.content}`),
	].join("\n\n");
}

function formatTools(mode: ToolMode): string {
	if (mode === "none") return "# Enabled Tools\nNo tools are currently enabled.";
	const base = ["# Enabled Tools", `Tool mode: ${mode}`, "Available tools are runtime capabilities, not skills."];
	if (mode === "read") {
		base.push("Enabled: read_file, list_dir, search_files, run_command for read-only commands.");
	} else {
		base.push("Enabled: read_file, list_dir, search_files, run_command, write_file.");
		base.push("write_file requires confirm=true after explicit user confirmation. Dangerous commands are blocked.");
	}
	base.push("Use run_command for local CLIs such as lark-cli, feishu-lark, bitscli, gh, git, or npm when appropriate. Do not claim tool access beyond this list.");
	return base.join("\n");
}

function formatSessionContext(items: ContextItem[]): string {
	return items.map((item) => `- ${item.key}: ${item.content}`).join("\n");
}
