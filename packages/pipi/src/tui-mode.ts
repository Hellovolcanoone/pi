import { Input, matchesKey, ProcessTerminal, TUI, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { PipiRuntime } from "./runtime.ts";
import type { PipiSkill } from "./skills.ts";
import type { ToolMode } from "./workspace-tools.ts";

export interface PipiTuiOptions {
	runtime: PipiRuntime;
	session: {
		sessionId: string;
		prompt(text: string): Promise<{ content: Array<{ type: string; text?: string }>; stopReason?: string; errorMessage?: string }>;
		compact(): Promise<{ tokensBefore: number }>;
		listContext(): Array<{ key: string; content: string }>;
		setContext(options: { key: string; content: string; source?: string }): unknown;
		unsetContext(key: string): boolean;
	};
	skills: PipiSkill[];
	toolMode: ToolMode;
	modelName: string;
	cwd: string;
	onContextChanged(): void;
}

class PipiTuiView implements Component {
	private readonly input: Input;
	private lines: string[];
	private scrollOffset = 0;
	private status = "";
	private pending = false;

	constructor(input: Input, initialLines: string[]) {
		this.input = input;
		this.lines = initialLines;
	}

	setState(lines: string[], status: string, pending: boolean): void {
		this.lines = lines;
		this.status = status;
		this.pending = pending;
	}

	scrollPage(delta: number): void {
		const page = Math.max(1, process.stdout.rows - 4);
		this.scrollOffset = Math.max(0, Math.min(this.maxScroll(page), this.scrollOffset + delta * page));
	}

	scrollToBottom(): void {
		this.scrollOffset = 0;
	}

	isAtBottom(): boolean {
		return this.scrollOffset === 0;
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const inputLines = this.pending ? [fitLine("pipi › Waiting for response...", renderWidth)] : renderPipiInputLines(this.input, renderWidth);
		const reserved = 2 + inputLines.length;
		const historyRows = Math.max(1, process.stdout.rows - reserved);
		const start = Math.max(0, this.lines.length - historyRows - this.scrollOffset);
		const visible = this.lines.slice(start, start + historyRows);
		const scroll = this.scrollOffset > 0 ? ` | scroll ${this.scrollOffset}/${this.maxScroll(historyRows)}` : "";
		const separator = fitLine("─".repeat(renderWidth), renderWidth);
		return [
			...visible.map((line) => fitLine(line, renderWidth)),
			separator,
			fitLine(`${this.status}${scroll}`, renderWidth),
			...inputLines,
		];
	}

	private maxScroll(page: number): number {
		return Math.max(0, this.lines.length - page);
	}

	invalidate(): void {}
}

function fitLine(line: string, width: number): string {
	return truncateToWidth(line, Math.max(1, width), "");
}

export function renderPipiInputLines(input: Input, width: number): string[] {
	const prompt = "pipi › ";
	const defaultPromptWidth = 2;
	const inputWidth = Math.max(1, width - visibleWidth(prompt) + defaultPromptWidth);
	return input.render(inputWidth).map((line) => fitLine(line.replace(/^> /, prompt), width));
}

export async function runPipiTui(options: PipiTuiOptions): Promise<void> {
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);
	const input = new Input();
	const lines: string[] = [statusLine(options, false), "Type /help for commands, /exit to quit."];
	let isPending = false;
	let pendingIndex = -1;
	const view = new PipiTuiView(input, lines);
	tui.addChild(view);
	tui.setFocus(input);
	tui.addInputListener((data) => {
		if (matchesKey(data, "pageUp")) {
			view.scrollPage(1);
			redraw();
			return { consume: true };
		}
		if (matchesKey(data, "pageDown")) {
			view.scrollPage(-1);
			redraw();
			return { consume: true };
		}
		if (matchesKey(data, "end")) {
			view.scrollToBottom();
			redraw();
			return { consume: true };
		}
		return undefined;
	});

	function redraw(): void {
		view.setState(lines, statusLine(options, isPending), isPending);
		tui.requestRender(true);
	}

	async function runBusy(label: string, task: () => Promise<void>): Promise<void> {
		isPending = true;
		pendingIndex = lines.push(label) - 1;
		redraw();
		try {
			await task();
		} finally {
			removePendingLine(lines, pendingIndex, label);
			pendingIndex = -1;
			isPending = false;
			options.onContextChanged();
			redraw();
		}
	}

	async function submit(raw: string): Promise<void> {
		const text = raw.trim();
		if (isPending) {
			if (text === "/exit" || text === "/quit") {
				tui.stop();
				return;
			}
			lines.push("Request is still pending.");
			redraw();
			return;
		}
		input.setValue("");
		if (!text) {
			redraw();
			return;
		}
		const shouldFollow = view.isAtBottom();
		lines.push(`> ${text}`);
		if (shouldFollow) view.scrollToBottom();
		redraw();
		if (text === "/compact") {
			await runBusy("Compacting...", async () => {
				try {
					const result = await options.session.compact();
					lines.push(`Compacted ${result.tokensBefore} transcript tokens.`);
				} catch (error) {
					lines.push(`[compact skipped] ${error instanceof Error ? error.message : String(error)}`);
				}
			});
			return;
		}
		if (text.startsWith("/")) {
			const keepGoing = await handleCommand(text, options, lines, () => isPending);
			redraw();
			if (!keepGoing) {
				tui.stop();
				return;
			}
			return;
		}
		await runBusy("Thinking...", async () => {
			try {
				const response = await options.session.prompt(text);
				const answer = response.stopReason === "error" || response.stopReason === "aborted"
					? (response.errorMessage ?? `Assistant response ${response.stopReason}`)
					: response.content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
				appendLines(lines, answer || "(empty response)");
			} catch (error) {
				appendLines(lines, `[error] ${error instanceof Error ? error.message : String(error)}`);
			}
		});
	}

	input.onSubmit = (value: string) => {
		void submit(value);
	};

	process.once("SIGINT", () => {
		tui.stop();
	});
	tui.start();
	redraw();
	await new Promise<void>((resolve) => {
		process.once("exit", () => resolve());
	});
}

export function appendLines(lines: string[], text: string): void {
	const split = text.split("\n");
	for (const line of split.length ? split : [""]) lines.push(line || " ");
}

export function removePendingLine(lines: string[], index: number, label = "Thinking..."): void {
	if (index >= 0 && lines[index] === label) lines.splice(index, 1);
}

function statusLine(options: PipiTuiOptions, pending: boolean): string {
	return `pipi | model ${options.modelName} | session ${options.session.sessionId} | skills ${options.skills.length} | tools ${options.toolMode} | ${pending ? "pending" : "idle"} | ${options.cwd}`;
}

async function handleCommand(input: string, options: PipiTuiOptions, lines: string[], isBusy: () => boolean): Promise<boolean> {
	const [command, ...args] = input.slice(1).split(/\s+/);
	if (command === "exit" || command === "quit") return false;
	if (isBusy()) {
		lines.push("Request is still pending.");
		return true;
	}
	if (command === "help") {
		lines.push("Commands: /help, /exit, /sessions, /skills list, /context list, /context set <key> <value>, /context unset <key>, /compact");
		return true;
	}
	if (command === "sessions") {
		const sessions = await options.runtime.listSessions();
		if (sessions.length === 0) lines.push("No sessions found.");
		for (const session of sessions) lines.push(`${session.id}\t${session.createdAt}`);
		return true;
	}
	if (command === "skills") {
		if (args[0] !== "list") {
			lines.push("Usage: /skills list");
			return true;
		}
		if (options.skills.length === 0) lines.push("No skills loaded.");
		for (const skill of options.skills) lines.push(`${skill.name}: ${skill.description || "(no description)"}`);
		return true;
	}
	if (command === "context") {
		handleContext(args, options, lines);
		options.onContextChanged();
		return true;
	}
	if (command === "compact") {
		try {
			const result = await options.session.compact();
			lines.push(`Compacted ${result.tokensBefore} transcript tokens.`);
		} catch (error) {
			lines.push(`[compact skipped] ${error instanceof Error ? error.message : String(error)}`);
		}
		return true;
	}
	lines.push(`Unknown command: /${command}`);
	return true;
}

function handleContext(args: string[], options: PipiTuiOptions, lines: string[]): void {
	const action = args[0];
	if (action === "list") {
		const items = options.session.listContext();
		if (items.length === 0) lines.push("No session context is set.");
		for (const item of items) lines.push(`${item.key}: ${item.content}`);
		return;
	}
	if (action === "set") {
		const key = args[1];
		const content = args.slice(2).join(" ");
		if (!key || !content) {
			lines.push("Usage: /context set <key> <value>");
			return;
		}
		options.session.setContext({ key, content, source: "tui" });
		lines.push(`Set context ${key}.`);
		return;
	}
	if (action === "unset") {
		const key = args[1];
		if (!key) {
			lines.push("Usage: /context unset <key>");
			return;
		}
		lines.push(options.session.unsetContext(key) ? `Unset context ${key}.` : `Context ${key} was not set.`);
		return;
	}
	lines.push("Usage: /context list | /context set <key> <value> | /context unset <key>");
}
