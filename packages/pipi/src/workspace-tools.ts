import { spawn } from "node:child_process";
import { existsSync, realpathSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

export type ToolMode = "none" | "read" | "workspace";

export interface WorkspaceToolsOptions {
	root?: string;
	mode?: ToolMode;
	maxOutputChars?: number;
	timeoutMs?: number;
}

type WorkspaceToolDetails = { action: string; path?: string; command?: string; truncated?: boolean; requiresConfirmation?: boolean };

type WorkspaceToolResult = AgentToolResult<WorkspaceToolDetails>;

const readFileSchema = Type.Object({ path: Type.String() });
const listDirSchema = Type.Object({ path: Type.Optional(Type.String()) });
const searchFilesSchema = Type.Object({ query: Type.String(), path: Type.Optional(Type.String()) });
const runCommandSchema = Type.Object({ command: Type.String(), args: Type.Optional(Type.Array(Type.String())), cwd: Type.Optional(Type.String()) });
const writeFileSchema = Type.Object({ path: Type.String(), content: Type.String(), confirm: Type.Optional(Type.Boolean()) });

function textResult(text: string, details: WorkspaceToolDetails): WorkspaceToolResult {
	return { content: [{ type: "text", text }], details };
}

function isInside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

function assertInside(root: string, target: string): string {
	const resolved = resolve(root, target || ".");
	const realRoot = realpathSync(root);
	const realTarget = existsSync(resolved) ? realpathSync(resolved) : realpathSync(dirname(resolved));
	if (isInside(realRoot, realTarget)) return resolved;
	throw new Error(`Path is outside workspace: ${target}`);
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false };
	return { text: `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`, truncated: true };
}

function isDangerousCommand(command: string, args: string[]): boolean {
	const base = command.split("/").pop() ?? command;
	if (["sudo", "su", "rm", "rmdir", "chmod", "chown", "chgrp"].includes(base)) return true;
	if (base === "git" && ["reset", "clean", "checkout", "restore", "push"].some((arg) => args.includes(arg))) return true;
	if (["curl", "wget", "scp", "rsync"].includes(base) && args.some((arg) => /upload|put|delete|post/i.test(arg))) return true;
	return false;
}

function isInterpreterCommand(command: string, args: string[]): boolean {
	const base = command.split("/").pop() ?? command;
	if (["bash", "sh", "zsh", "fish"].includes(base) && args.some((arg) => arg === "-c" || arg === "-lc")) return true;
	if (["node", "python", "python3", "perl", "ruby"].includes(base) && args.some((arg) => arg === "-e" || arg === "-c")) return true;
	return false;
}

function isLikelyWriteCommand(command: string, args: string[]): boolean {
	const base = command.split("/").pop() ?? command;
	if (isInterpreterCommand(command, args)) return true;
	if (["npm", "pnpm", "yarn", "bun", "mkdir", "mv", "cp", "touch", "tee"].includes(base)) return true;
	if (base === "git" && ["add", "commit", "merge", "rebase", "tag"].some((arg) => args.includes(arg))) return true;
	if (base === "lark-cli" && args.some((arg) => /update|create|delete|move|copy|upload|send|publish/i.test(arg))) return true;
	return false;
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, maxOutputChars: number): Promise<WorkspaceToolResult> {
	return new Promise((resolvePromise) => {
		const child = spawn(command, args, { cwd, shell: false });
		let output = "";
		const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
		child.stdout.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolvePromise(textResult(error.message, { action: "run", command }));
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			const result = truncate(output || `(exit ${code}${signal ? ` signal ${signal}` : ""})`, maxOutputChars);
			resolvePromise(textResult(result.text, { action: "run", command, truncated: result.truncated }));
		});
	});
}

export function createWorkspaceTools(options: WorkspaceToolsOptions = {}): AgentTool[] {
	const root = resolve(options.root ?? process.cwd());
	const mode = options.mode ?? "workspace";
	if (mode === "none") return [];
	const maxOutputChars = options.maxOutputChars ?? 12000;
	const timeoutMs = options.timeoutMs ?? 120000;
	const tools: AgentTool[] = [
		{
			label: "Read File",
			name: "read_file",
			description: "Read a file inside the current workspace. Output is length-limited.",
			parameters: readFileSchema,
			execute: async (_id: string, raw: unknown) => {
				const params = raw as Static<typeof readFileSchema>;
				const path = assertInside(root, params.path);
				const result = truncate(readFileSync(path, "utf8"), maxOutputChars);
				return textResult(result.text, { action: "read", path, truncated: result.truncated });
			},
		},
		{
			label: "List Directory",
			name: "list_dir",
			description: "List files in a directory inside the current workspace.",
			parameters: listDirSchema,
			execute: async (_id: string, raw: unknown) => {
				const params = raw as Static<typeof listDirSchema>;
				const path = assertInside(root, params.path ?? ".");
				const rows = readdirSync(path).map((name) => {
					const stat = statSync(resolve(path, name));
					return `${stat.isDirectory() ? "dir " : "file"}\t${name}`;
				});
				const result = truncate(rows.join("\n"), maxOutputChars);
				return textResult(result.text, { action: "list", path, truncated: result.truncated });
			},
		},
		{
			label: "Search Files",
			name: "search_files",
			description: "Search file contents with rg inside the current workspace.",
			parameters: searchFilesSchema,
			execute: async (_id: string, raw: unknown) => {
				const params = raw as Static<typeof searchFilesSchema>;
				const cwd = assertInside(root, params.path ?? ".");
				return runProcess("rg", ["--line-number", "--", params.query, "."], cwd, timeoutMs, maxOutputChars);
			},
		},
		{
			label: "Run Command",
			name: "run_command",
			description: "Run a local command with argv inside the workspace. Dangerous commands are blocked; write-like commands require confirmation.",
			parameters: runCommandSchema,
			execute: async (_id: string, raw: unknown) => {
				const params = raw as Static<typeof runCommandSchema>;
				const args = params.args ?? [];
				if (isDangerousCommand(params.command, args)) throw new Error(`Blocked dangerous command: ${params.command}`);
				if (isLikelyWriteCommand(params.command, args)) {
						return textResult(`Confirmation required to run write-like command: ${params.command} ${args.join(" ")}`, {
							action: "run",
							command: params.command,
							requiresConfirmation: true,
						});
					}
				const cwd = assertInside(root, params.cwd ?? ".");
				return runProcess(params.command, args, cwd, timeoutMs, maxOutputChars);
			},
		},
	];
	if (mode === "workspace") {
		tools.push({
			label: "Write File",
			name: "write_file",
			description: "Prepare a workspace file write. This tool never writes directly; it returns a confirmation request for the user.",
			parameters: writeFileSchema,
			execute: async (_id: string, raw: unknown) => {
				const params = raw as Static<typeof writeFileSchema>;
				const path = assertInside(root, params.path);
				if (/(^|[/\\])(\.env|id_rsa|id_ed25519|credentials|token)/i.test(path)) throw new Error(`Refusing to write sensitive path: ${path}`);
				return textResult(`Confirmation required to write ${path}. Proposed content length: ${params.content.length} chars.`, {
					action: "write",
					path,
					requiresConfirmation: true,
				});
			},
		});
	}

	return tools;
}
