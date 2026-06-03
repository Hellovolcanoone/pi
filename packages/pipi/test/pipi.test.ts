import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider, type UserMessage } from "@earendil-works/pi-ai";
import type { SessionBeforeCompactResult } from "@earendil-works/pi-agent-core";
import { Input, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import {
	createLlmboxGetApiKeyAndHeaders,
	createLlmboxHeaders,
	createLlmboxModel,
	readLlmboxCachedToken,
	resolveLlmboxApiKey,
	resolveLlmboxDefaultModel,
	PipiRuntime,
	SessionContextStore,
	createWorkspaceTools,
} from "../src/index.ts";
import { appendLines, removePendingLine, renderPipiInputLines } from "../src/tui-mode.ts";

const registrations: Array<{ unregister(): void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

describe("PipiRuntime", () => {
	it("creates workspace tools with read and command execution", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipi-tools-"));
		try {
			writeFileSync(join(dir, "sample.txt"), "hello tools");
			const tools = createWorkspaceTools({ root: dir, mode: "workspace" });
			const read = tools.find((tool) => tool.name === "read_file")!;
			const run = tools.find((tool) => tool.name === "run_command")!;
			const write = tools.find((tool) => tool.name === "write_file")!;

			await expect(read.execute("read", { path: "sample.txt" })).resolves.toMatchObject({
				content: [{ type: "text", text: "hello tools" }],
			});
			await expect(run.execute("run", { command: "pwd", args: [] })).resolves.toMatchObject({
				details: { action: "run", command: "pwd" },
			});
			await expect(run.execute("danger", { command: "rm", args: ["-rf", "."] })).rejects.toThrow("Blocked dangerous command");
			await expect(run.execute("touch", { command: "touch", args: ["x.txt"] })).resolves.toMatchObject({
				details: { requiresConfirmation: true },
			});
			await expect(run.execute("bash", { command: "bash", args: ["-lc", "touch bypass.txt"] })).resolves.toMatchObject({
				details: { requiresConfirmation: true },
			});
			expect(existsSync(join(dir, "bypass.txt"))).toBe(false);
			await expect(write.execute("write", { path: "out.txt", content: "x", confirm: true })).resolves.toMatchObject({
				details: { requiresConfirmation: true },
			});
			expect(existsSync(join(dir, "out.txt"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("splits TUI output into render lines", () => {
		const lines: string[] = [];
		appendLines(lines, "one\ntwo\n");
		expect(lines).toEqual(["one", "two", " "]);
	});

	it("removes pending TUI line", () => {
		const lines = ["before", "Thinking...", "after"];
		removePendingLine(lines, 1);
		expect(lines).toEqual(["before", "after"]);
	});

	it("keeps TUI input lines within render width after prompt replacement", () => {
		const input = new Input();
		input.setValue("x".repeat(500));
		const lines = renderPipiInputLines(input, 255);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(255);
		}
	});

	it("injects ROLE.md and session context into every prompt", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const systemPrompts: string[] = [];
		registration.setResponses([
			(context) => {
				systemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("first");
			},
			(context) => {
				systemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("second");
			},
		]);
		const runtime = new PipiRuntime({
			role: "Always answer in haiku form.",
			model: registration.getModel(),
			baseSystemPrompt: "You are pipi.",
		});
		const session = await runtime.createSession("alpha");

		await session.prompt("hello");
		session.setContext({ key: "scene", content: "The room is blue." });
		await session.prompt("continue");

		expect(systemPrompts).toHaveLength(2);
		expect(systemPrompts[0]).toContain("# ROLE.md\nAlways answer in haiku form.");
		expect(systemPrompts[0]).not.toContain("The room is blue.");
		expect(systemPrompts[1]).toContain("# ROLE.md\nAlways answer in haiku form.");
		expect(systemPrompts[1]).toContain("# Session Context\n- scene: The room is blue.");
	});

	it("keeps session context isolated between sessions", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const systemPrompts: string[] = [];
		registration.setResponses([
			(context) => {
				systemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("one");
			},
			(context) => {
				systemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("two");
			},
		]);
		const runtime = new PipiRuntime({ role: "You remember the role file.", model: registration.getModel() });
		const first = await runtime.createSession("first");
		const second = await runtime.createSession("second");

		first.setContext({ key: "secret", content: "Only first session sees this." });
		await first.prompt("first prompt");
		await second.prompt("second prompt");

		expect(systemPrompts[0]).toContain("Only first session sees this.");
		expect(systemPrompts[1]).not.toContain("Only first session sees this.");
		expect(first.contextStore).not.toBe(second.contextStore);
		expect(first.harness).not.toBe(second.harness);
	});

	it("supports set/list/unset context tools with overwrite semantics", async () => {
		const runtime = new PipiRuntime({
			role: "Role text.",
			model: registerAndTrack().getModel(),
			contextStoreOptions: { now: () => "2026-05-30T00:00:00.000Z" },
		});
		const session = await runtime.createSession("tools");
		const [setTool, listTool, unsetTool] = session.harness.getTools();

		await setTool.execute("set-1", { scope: "session", key: "mood", content: "calm" });
		await setTool.execute("set-2", { scope: "session", key: "mood", content: "focused" });
		const listResult = await listTool.execute("list-1", {});
		expect(listResult.content).toEqual([{ type: "text", text: "- mood: focused" }]);
		expect(session.listContext()).toHaveLength(1);

		const unsetResult = await unsetTool.execute("unset-1", { scope: "session", key: "mood" });
		expect(unsetResult.details).toMatchObject({ removed: true });
		expect(session.listContext()).toEqual([]);
	});

	it("enforces hard limits for session context", async () => {
		const runtime = new PipiRuntime({
			role: "Role text.",
			model: registerAndTrack().getModel(),
			contextStoreOptions: { limits: { maxKeyChars: 10, maxChars: 5, maxTotalChars: 40, maxItems: 3 } },
		});
		const session = await runtime.createSession("limits");

		expect(() => session.setContext({ key: "too-long", content: "123456" })).toThrow("maxChars");
		expect(() => session.setContext({ key: "x".repeat(11), content: "1" })).toThrow("maxKeyChars");
		session.setContext({ key: "one", content: "1234" });
		session.setContext({ key: "two", content: "1234" });
		session.setContext({ key: "three", content: "1" });
		expect(() => session.setContext({ key: "four", content: "1" })).toThrow("maxItems");
		session.unsetContext("three");
		expect(() => session.setContext({ key: "two", content: "123456" })).toThrow("maxChars");
		session.setContext({ key: "two", content: "12345" });
		expect(() => session.setContext({ key: "one", content: "123456" })).toThrow("maxChars");
		expect(() => session.setContext({ key: "tenletters", content: "12345" })).toThrow("maxTotalChars");
		expect(session.listContext().map((item) => [item.key, item.content])).toEqual([
			["one", "1234"],
			["two", "12345"],
		]);
	});

	it("rejects duplicate in-process session ids", async () => {
		const runtime = new PipiRuntime({ role: "Role text.", model: registerAndTrack().getModel() });

		await runtime.createSession("duplicate");
		await expect(runtime.createSession("duplicate")).rejects.toThrow("already exists");
	});

	it("creates unique generated session ids across runtime instances", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipi-sessions-"));
		try {
			const first = new PipiRuntime({ role: "Role text.", model: registerAndTrack().getModel(), sessionsRoot: dir });
			const second = new PipiRuntime({ role: "Role text.", model: registerAndTrack().getModel(), sessionsRoot: dir });
			const a = await first.createSession();
			const b = await second.createSession();

			expect(a.sessionId).not.toBe(b.sessionId);
			expect(await first.listSessions()).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resumes explicit persistent sessions instead of creating duplicates", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipi-resume-"));
		try {
			const first = new PipiRuntime({ role: "Role text.", model: registerAndTrack().getModel(), sessionsRoot: dir });
			const created = await first.createSession("same");
			created.setContext({ key: "scene", content: "first" });

			const second = new PipiRuntime({ role: "Role text.", model: registerAndTrack().getModel(), sessionsRoot: dir });
			const resumed = await second.resumeSession("same");

			expect(resumed.sessionId).toBe("same");
			expect(await second.listSessions()).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("creates llmbox model and auth config from env/cache", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipi-llmbox-"));
		try {
			const defaultsPath = join(dir, "default-models.json");
			const tokenPath = join(dir, "accesstoken");
			writeFileSync(defaultsPath, JSON.stringify({ pipi: "gpt-5.5[1m]" }));
			writeFileSync(tokenPath, `${Math.floor(Date.now() / 1000)}\nraw-token\n`);

			const modelId = resolveLlmboxDefaultModel("pipi", defaultsPath);
			const model = createLlmboxModel({ modelId, projectRoot: "/repo", repoInfo: { branch: "main" } });
			expect(model.id).toBe("gpt-5.5");
			expect(model.name).toBe("gpt-5.5[1m]");
			expect(model.api).toBe("openai-responses");
			expect(model.provider).toBe("llmbox");
			expect(model.baseUrl).toBe("https://llmbox.bytedance.net/v1");
			expect(model.reasoning).toBe(false);
			expect(createLlmboxModel({ modelId: "gpt-5.5", reasoning: true }).reasoning).toBe(true);
			expect(model.contextWindow).toBe(1_000_000);
			expect(model.headers).toMatchObject({
				"x-source": "caijing-pay-aicoding",
				"x-project-root": "/repo",
				"x-repo-info": JSON.stringify({ branch: "main" }),
			});
			expect(readLlmboxCachedToken(tokenPath)).toBe("at-raw-token");
			expect(resolveLlmboxApiKey({ env: { LLMGW_OPENAI_API_KEY: "env-token" } })).toBe("at-env-token");
			const getAuth = createLlmboxGetApiKeyAndHeaders({
				apiKey: "explicit-token",
				extraHeaders: { "x-extra": "1" },
			});
			await expect(getAuth(model)).resolves.toEqual({
				apiKey: "at-explicit-token",
				headers: { "x-source": "caijing-pay-aicoding", "x-extra": "1" },
			});
			expect(createLlmboxHeaders({ source: "custom" })).toEqual({ "x-source": "custom" });
			expect(() => resolveLlmboxDefaultModel("pipi", join(dir, "missing.json"))).toThrow(
				"Run llmbox switch pipi first",
			);
			writeFileSync(defaultsPath, "not json");
			expect(() => resolveLlmboxDefaultModel("pipi", defaultsPath)).toThrow(
				"Run llmbox switch pipi first",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("injects no-skills disclosure", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let systemPrompt = "";
		registration.setResponses([
			(context) => {
				systemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("ok");
			},
		]);
		const runtime = new PipiRuntime({ role: "Role text.", model: registration.getModel() });

		await (await runtime.createSession("no-skills")).prompt("hello");

		expect(systemPrompt).toContain("No skills are currently loaded");
	});

	it("injects instruction-only skills", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let systemPrompt = "";
		registration.setResponses([
			(context) => {
				systemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("ok");
			},
		]);
		const runtime = new PipiRuntime({
			role: "Role text.",
			model: registration.getModel(),
			skills: [{ name: "project-mgr", description: "Manage delivery", content: "Track risks.", filePath: "/tmp/SKILL.md" }],
		});

		await (await runtime.createSession("skills")).prompt("hello");

		expect(systemPrompt).toContain("# Enabled Skills");
		expect(systemPrompt).toContain("## project-mgr");
		expect(systemPrompt).toContain("instruction-only skills");
		expect(systemPrompt).toContain("Track risks.");
	});

	it("manual compaction does not include ROLE.md or session context in compaction input", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			fauxAssistantMessage("first response"),
			(context) => {
				expect(context.systemPrompt).toContain("Never mention the silver lantern rule.");
				expect(context.systemPrompt).toContain("- scene: The archive is locked.");
				return fauxAssistantMessage("after compact");
			},
		]);
		const runtime = new PipiRuntime({
			role: "Never mention the silver lantern rule.",
			model: registration.getModel(),
			getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
		});
		const session = await runtime.createSession("compact");
		session.setContext({ key: "scene", content: "The archive is locked." });
		await session.prompt("start");
		for (let i = 0; i < 120; i++) {
			await session.harness.appendMessage(createTestUserMessage(`history ${i}: ${"x".repeat(1000)}`));
		}
		let compactionBranchText = "";
		session.harness.on("session_before_compact", (event): SessionBeforeCompactResult => {
			compactionBranchText = JSON.stringify(event.branchEntries);
			return {
				compaction: {
					summary: "Summarized transcript only.",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
				},
			};
		});

		await session.compact();
		await session.prompt("what is still true?");

		expect(compactionBranchText).not.toContain("silver lantern");
		expect(compactionBranchText).not.toContain("archive is locked");
	});
});

function createTestUserMessage(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function registerAndTrack() {
	const registration = registerFauxProvider();
	registrations.push(registration);
	return registration;
}
