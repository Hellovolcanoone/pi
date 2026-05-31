#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createLlmboxGetApiKeyAndHeaders, createLlmboxModel } from "./llmbox.ts";
import { FileRoleLoader, RoleAgentRuntime, StaticRoleLoader, type RoleLoader } from "./index.ts";

const DEFAULT_ROLE_PATH = "ROLE.md";
const DEFAULT_ROLE_CONTENT = "你是一个轻量 role-agent。保持角色一致，优先遵循用户输入和 session context，回答要清晰、简洁、稳定。";

interface CliOptions {
	prompt?: string;
	rolePath?: string;
	model?: string;
	context: Array<{ key: string; content: string }>;
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = { context: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-p" || arg === "--prompt") {
			options.prompt = readValue(argv, ++i, arg);
		} else if (arg === "--role") {
			options.rolePath = readValue(argv, ++i, arg);
		} else if (arg === "-m" || arg === "--model") {
			options.model = readValue(argv, ++i, arg);
		} else if (arg === "--context") {
			options.context.push(parseContext(readValue(argv, ++i, arg)));
		} else if (arg === "-h" || arg === "--help") {
			printHelp();
			process.exit(0);
		} else if (!arg.startsWith("-") && options.prompt === undefined) {
			options.prompt = arg;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return options;
}

function readValue(argv: string[], index: number, flag: string): string {
	const value = argv[index];
	if (value === undefined) throw new Error(`${flag} requires a value`);
	return value;
}

function parseContext(raw: string): { key: string; content: string } {
	const separator = raw.indexOf("=");
	if (separator <= 0) throw new Error("--context must use key=value format");
	return { key: raw.slice(0, separator), content: raw.slice(separator + 1) };
}

function printHelp(): void {
	console.log(`Usage: role-agent [options] [prompt]

Options:
  -p, --prompt <text>    Prompt to send in print mode
  --role <path>          ROLE.md path (default: ./ROLE.md if present, otherwise built-in role)
  -m, --model <model>    llmbox model id (default: llmbox switch role-agent)
  --context <key=value>  Session context injected into every prompt
  -h, --help             Show help

Environment:
  LLMBOX_API_KEY, LLMGW_OPENAI_API_KEY, or OPENAI_API_KEY supplies the llmbox token.
`);
}

function readStdinPrompt(): string {
	if (process.stdin.isTTY) return "";
	return readFileSync(0, "utf8").trim();
}

function resolveRoleLoader(options: CliOptions): RoleLoader {
	if (options.rolePath !== undefined) {
		const explicitPath = resolve(options.rolePath);
		if (!existsSync(explicitPath)) throw new Error(`ROLE.md not found: ${explicitPath}`);
		return new FileRoleLoader(explicitPath);
	}
	const defaultPath = resolve(DEFAULT_ROLE_PATH);
	return existsSync(defaultPath) ? new FileRoleLoader(defaultPath) : new StaticRoleLoader(DEFAULT_ROLE_CONTENT);
}

function assistantText(content: AssistantMessage["content"]): string {
	return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

async function main(argv: string[]): Promise<void> {
	const options = parseArgs(argv);
	const role = resolveRoleLoader(options);
	const prompt = options.prompt ?? readStdinPrompt();
	if (!prompt) throw new Error("No prompt provided. Use `llmbox role-agent -- -p \"...\"` or pipe stdin, e.g. `echo \"...\" | llmbox role-agent`.");

	const runtime = new RoleAgentRuntime({
		role,
		model: createLlmboxModel({
			modelId: options.model ?? process.env.LLMBOX_MODEL,
			projectRoot: process.env.LLMBOX_PROJECT_ROOT,
			repoInfo: process.env.LLMBOX_REPO_INFO,
		}),
		getApiKeyAndHeaders: createLlmboxGetApiKeyAndHeaders({
			source: process.env.LLMBOX_X_SOURCE,
			projectRoot: process.env.LLMBOX_PROJECT_ROOT,
			repoInfo: process.env.LLMBOX_REPO_INFO,
		}),
	});
	const session = await runtime.createSession();
	for (const item of options.context) session.setContext(item);
	const response = await session.prompt(prompt);
	const text = assistantText(response.content);
	if (text) console.log(text);
}

main(process.argv.slice(2)).catch((error: unknown) => {
	console.error(`[role-agent] ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
