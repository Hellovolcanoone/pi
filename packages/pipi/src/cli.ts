#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-agent-core";
import {
	createLlmboxGetApiKeyAndHeaders,
	createLlmboxModel,
	resolveLlmboxApiKey,
	resolveLlmboxDefaultModel,
} from "./llmbox.ts";
import {
	FileRoleLoader,
	loadSkillPath,
	mergeSkills,
	PipiRuntime,
	StaticRoleLoader,
	createWorkspaceTools,
	type ContextItem,
	type PipiSkill,
	type RoleLoader,
	type ToolMode,
} from "./index.ts";
import { runPipiTui } from "./tui-mode.ts";

const DEFAULT_ROLE_PATH = "ROLE.md";
const DEFAULT_ROLE_CONTENT = "你是一个轻量 pipi。保持角色一致，优先遵循用户输入和 session context，回答要清晰、简洁、稳定。";
const DEFAULT_SESSIONS_ROOT = join(homedir(), ".pipi", "sessions");

interface CliOptions {
	prompt?: string;
	rolePath?: string;
	model?: string;
	context: Array<{ key: string; content: string }>;
	skillPaths: string[];
	skillsRoot?: string;
	loadRoleSkills: boolean;
	sessionId?: string;
	newSession: boolean;
	tui: boolean;
	plain: boolean;
	sessionsRoot: string;
	autoCompactTokens?: number;
	toolMode: ToolMode;
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = { context: [], skillPaths: [], loadRoleSkills: true, newSession: false, tui: false, plain: false, sessionsRoot: DEFAULT_SESSIONS_ROOT, toolMode: "workspace" };
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
		} else if (arg === "--skill") {
			options.skillPaths.push(readValue(argv, ++i, arg));
		} else if (arg === "--skills-root") {
			options.skillsRoot = readValue(argv, ++i, arg);
		} else if (arg === "--no-role-skills") {
			options.loadRoleSkills = false;
		} else if (arg === "--tui") {
			options.tui = true;
		} else if (arg === "--plain") {
			options.plain = true;
		} else if (arg === "--session") {
			options.sessionId = readValue(argv, ++i, arg);
		} else if (arg === "--new-session") {
			options.newSession = true;
		} else if (arg === "--sessions-root") {
			options.sessionsRoot = readValue(argv, ++i, arg);
		} else if (arg === "--tools" || arg === "--tool-mode") {
			const mode = readValue(argv, ++i, arg);
			if (mode !== "none" && mode !== "read" && mode !== "workspace") throw new Error("--tools must be one of: none, read, workspace");
			options.toolMode = mode;
		} else if (arg === "--auto-compact-tokens") {
			options.autoCompactTokens = Number(readValue(argv, ++i, arg));
			if (!Number.isFinite(options.autoCompactTokens) || options.autoCompactTokens <= 0) {
				throw new Error("--auto-compact-tokens must be a positive number");
			}
		} else if (arg === "tui") {
			options.tui = true;
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
	console.log(`Usage: pipi [options] [prompt]
       pipi doctor [--role ROLE.md]

Modes:
  pipi                 Start TUI with session persistence
  pipi -p "..."        Run one print-mode prompt
  echo "..." | pipi    Run one print-mode prompt from stdin

Options:
  -p, --prompt <text>              Prompt to send in print mode
  --role <path>                    ROLE.md path (default: ./ROLE.md if present, otherwise built-in role)
  -m, --model <model>              llmbox model id (default: llmbox switch pipi)
  --context <key=value>            Session context injected into every prompt
  --skill <path>                   Load an instruction-only local SKILL.md file or skill directory
  --skills-root <path>             Load all SKILL.md files under a local skills root
  --no-role-skills                 Do not auto-load ROLE.md-adjacent skills/
  --tui                            Start TUI mode
  --plain                          Use plain REPL fallback instead of default TUI
  --session <id>                   Resume or create a persistent session id
  --new-session                    Force a new generated session instead of default REPL session
  --sessions-root <path>           Session JSONL root (default: ~/.pipi/sessions)
  --tools <mode>                   Tool mode: none, read, workspace (default: workspace)
  --auto-compact-tokens <tokens>   Auto compact after turns when estimated transcript branch exceeds threshold
  -h, --help                       Show help

REPL commands:
  /help
  /exit
  /sessions
  /skills list
  /context list
  /context set <key> <value>
  /context unset <key>
  /compact

Environment:
  LLMBOX_API_KEY, LLMGW_OPENAI_API_KEY, or OPENAI_API_KEY supplies the llmbox token.
`);
}

function readStdinPrompt(): string {
	if (process.stdin.isTTY) return "";
	return readFileSync(0, "utf8").trim();
}

function resolveRoleLoader(options: Pick<CliOptions, "rolePath">): RoleLoader {
	if (options.rolePath !== undefined) {
		const explicitPath = resolve(options.rolePath);
		if (!existsSync(explicitPath)) throw new Error(`ROLE.md not found: ${explicitPath}`);
		return new FileRoleLoader(explicitPath);
	}
	const defaultPath = resolve(DEFAULT_ROLE_PATH);
	return existsSync(defaultPath) ? new FileRoleLoader(defaultPath) : new StaticRoleLoader(DEFAULT_ROLE_CONTENT);
}


function roleSkillsDir(options: Pick<CliOptions, "rolePath">): string | undefined {
	if (options.rolePath) return join(dirname(resolve(options.rolePath)), "skills");
	const defaultPath = resolve(DEFAULT_ROLE_PATH);
	return existsSync(defaultPath) ? join(dirname(defaultPath), "skills") : undefined;
}

function loadSkills(options: CliOptions): PipiSkill[] {
	const skills: PipiSkill[] = [];
	if (options.loadRoleSkills) {
		const dir = roleSkillsDir(options);
		if (dir && existsSync(dir)) skills.push(...loadSkillPath(dir));
	}
	if (options.skillsRoot) skills.push(...loadSkillPath(options.skillsRoot));
	for (const path of options.skillPaths) skills.push(...loadSkillPath(path));
	return mergeSkills(skills);
}

function assistantText(message: AssistantMessage): string {
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		return message.errorMessage ?? `Assistant response ${message.stopReason}`;
	}
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function encodePathComponent(value: string): string {
	return value.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") || "root";
}

function contextPath(options: CliOptions, sessionId: string): string {
	return join(resolve(options.sessionsRoot), `--${encodePathComponent(process.cwd())}--`, `${encodeURIComponent(sessionId)}.context.json`);
}

function loadContext(options: CliOptions, sessionId: string): ContextItem[] {
	try {
		const parsed = JSON.parse(readFileSync(contextPath(options, sessionId), "utf8")) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is ContextItem => {
			return typeof item === "object" && item !== null && "key" in item && "content" in item;
		});
	} catch {
		return [];
	}
}

function saveContext(options: CliOptions, sessionId: string, items: ContextItem[]): void {
	const path = contextPath(options, sessionId);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

function createRuntime(options: CliOptions, skills: PipiSkill[]): PipiRuntime {
	return new PipiRuntime({
		role: resolveRoleLoader(options),
		skills,
		toolMode: options.toolMode,
		tools: createWorkspaceTools({ mode: options.toolMode, root: process.cwd() }),
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
		sessionsRoot: options.sessionsRoot,
	});
}

async function openSession(runtime: PipiRuntime, options: CliOptions, repl: boolean) {
	const existing = await runtime.listSessions();
	const requestedId = options.newSession ? undefined : (options.sessionId ?? (repl ? "default" : undefined));
	const session = requestedId && existing.some((item) => item.id === requestedId)
		? await runtime.resumeSession(requestedId)
		: await runtime.createSession(requestedId);
	session.contextStore.replace(loadContext(options, session.sessionId));
	for (const item of options.context) session.setContext(item);
	saveContext(options, session.sessionId, session.listContext());
	return session;
}

async function promptAndPrint(
	session: Awaited<ReturnType<typeof openSession>>,
	prompt: string,
	options: CliOptions,
): Promise<void> {
	const response = await session.prompt(prompt);
	const text = assistantText(response);
	if (text) console.log(text);
	saveContext(options, session.sessionId, session.listContext());
	await maybeAutoCompact(session, options.autoCompactTokens);
}

async function maybeAutoCompact(
	session: Awaited<ReturnType<typeof openSession>>,
	threshold: number | undefined,
): Promise<void> {
	if (!threshold) return;
	const context = await session.session.buildContext();
	const estimatedTokens = estimateContextTokens(context.messages).tokens;
	if (estimatedTokens < threshold) return;
	try {
		await session.compact();
		console.log(`[compacted transcript branch for session ${session.sessionId}]`);
	} catch (error) {
		console.error(`[compact skipped] ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function runRepl(runtime: PipiRuntime, options: CliOptions, skills: PipiSkill[]): Promise<void> {
	const session = await openSession(runtime, options, true);
	console.log(`pipi session ${session.sessionId}. Type /help for commands, /exit to quit.`);
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		while (true) {
			const input = (await rl.question("> ")).trim();
			if (!input) continue;
			if (input.startsWith("/")) {
				try {
					const keepGoing = await handleReplCommand(input, runtime, session, options, skills);
					if (!keepGoing) break;
				} catch (error) {
					console.error(`[command error] ${error instanceof Error ? error.message : String(error)}`);
				}
				continue;
			}
			await promptAndPrint(session, input, options);
		}
	} finally {
		rl.close();
	}
}

async function handleReplCommand(
	input: string,
	runtime: PipiRuntime,
	session: Awaited<ReturnType<typeof openSession>>,
	options: CliOptions,
	skills: PipiSkill[],
): Promise<boolean> {
	const [command, ...args] = input.slice(1).split(/\s+/);
	if (command === "exit" || command === "quit") return false;
	if (command === "help") {
		console.log("Commands: /help, /exit, /sessions, /skills list, /context list, /context set <key> <value>, /context unset <key>, /compact");
		return true;
	}
	if (command === "sessions") {
		const sessions = await runtime.listSessions();
		for (const item of sessions) console.log(`${item.id}\t${item.createdAt}\t${item.path}`);
		return true;
	}
	if (command === "skills") {
		handleSkillsCommand(args, skills);
		return true;
	}
	if (command === "context") {
		handleContextCommand(args, session);
		saveContext(options, session.sessionId, session.listContext());
		return true;
	}
	if (command === "compact") {
		try {
			const result = await session.compact();
			console.log(`Compacted ${result.tokensBefore} transcript tokens.`);
		} catch (error) {
			console.error(`[compact skipped] ${error instanceof Error ? error.message : String(error)}`);
		}
		return true;
	}
	console.log(`Unknown command: /${command}`);
	return true;
}

function handleSkillsCommand(args: string[], skills: PipiSkill[]): void {
	if (args[0] !== "list") throw new Error("Usage: /skills list");
	if (skills.length === 0) {
		console.log("No skills loaded.");
		return;
	}
	for (const skill of skills) console.log(`${skill.name}: ${skill.description || "(no description)"}`);
}

function handleContextCommand(args: string[], session: Awaited<ReturnType<typeof openSession>>): void {
	const action = args[0];
	if (action === "list") {
		const items = session.listContext();
		if (items.length === 0) console.log("No session context is set.");
		for (const item of items) console.log(`${item.key}: ${item.content}`);
		return;
	}
	if (action === "set") {
		const key = args[1];
		const content = args.slice(2).join(" ");
		if (!key || !content) throw new Error("Usage: /context set <key> <value>");
		session.setContext({ key, content, source: "repl" });
		console.log(`Set context ${key}.`);
		return;
	}
	if (action === "unset") {
		const key = args[1];
		if (!key) throw new Error("Usage: /context unset <key>");
		console.log(session.unsetContext(key) ? `Unset context ${key}.` : `Context ${key} was not set.`);
		return;
	}
	throw new Error("Usage: /context list | /context set <key> <value> | /context unset <key>");
}

function runDoctor(options: CliOptions): void {
	const checks: Array<[string, boolean, string]> = [];
	try {
		resolveRoleLoader(options);
		checks.push(["role", true, options.rolePath ? `using ${resolve(options.rolePath)}` : "ROLE.md or built-in fallback is available"]);
	} catch (error) {
		checks.push(["role", false, error instanceof Error ? error.message : String(error)]);
	}
	try {
		checks.push(["model", true, process.env.LLMBOX_MODEL ?? resolveLlmboxDefaultModel()]);
	} catch (error) {
		checks.push(["model", false, error instanceof Error ? error.message : String(error)]);
	}
	try {
		resolveLlmboxApiKey();
		checks.push(["token", true, "llmbox token found"]);
	} catch (error) {
		checks.push(["token", false, error instanceof Error ? error.message : String(error)]);
	}
	checks.push(["bin", true, process.argv[1] ?? "pipi"]);
	for (const [name, ok, detail] of checks) console.log(`${ok ? "OK" : "FAIL"}\t${name}\t${detail}`);
	if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

async function main(argv: string[]): Promise<void> {
	const command = argv[0];
	const commandArgs = command === "doctor" ? argv.slice(1) : argv;
	const options = parseArgs(commandArgs);
	if (command === "doctor") {
		runDoctor(options);
		return;
	}
	const prompt = options.prompt ?? readStdinPrompt();
	const skills = loadSkills(options);
	const runtime = createRuntime(options, skills);
	if (!prompt && process.stdin.isTTY) {
		if (options.plain) {
			await runRepl(runtime, options, skills);
		} else {
			const session = await openSession(runtime, options, true);
			await runPipiTui({
				runtime,
				session,
				skills,
				toolMode: options.toolMode,
				modelName: options.model ?? process.env.LLMBOX_MODEL ?? "llmbox-default",
				cwd: process.cwd(),
				onContextChanged: () => saveContext(options, session.sessionId, session.listContext()),
			});
		}
		return;
	}
	if (!prompt) throw new Error("No prompt provided. Use `llmbox pipi -- -p \"...\"` or pipe stdin, e.g. `echo \"...\" | llmbox pipi`.");
	await promptAndPrint(await openSession(runtime, options, false), prompt, options);
}

main(process.argv.slice(2)).catch((error: unknown) => {
	console.error(`[pipi] ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
