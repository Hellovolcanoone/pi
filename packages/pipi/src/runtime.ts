import type { Model } from "@earendil-works/pi-ai";
import {
	AgentHarness,
	InMemorySessionRepo,
	JsonlSessionRepo,
	NodeExecutionEnv,
	Session,
	type AgentHarnessOptions,
	type AgentHarnessStreamOptions,
	type AgentTool,
	type QueueMode,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core/node";
import { SessionContextStore, type ContextItem, type SessionContextStoreOptions } from "./context-store.ts";
import { createContextTools } from "./context-tools.ts";
import { buildRoleSystemPrompt } from "./prompt-builder.ts";
import { type RoleDefinition, type RoleLoader, StaticRoleLoader } from "./role-loader.ts";
import type { PipiSkill } from "./skills.ts";
import type { ToolMode } from "./workspace-tools.ts";

export interface PipiRuntimeOptions {
	role: RoleLoader | string;
	model: Model<any>;
	cwd?: string;
	sessionsRoot?: string;
	baseSystemPrompt?: string;
	contextStoreOptions?: SessionContextStoreOptions;
	skills?: PipiSkill[];
	toolMode?: ToolMode;
	tools?: AgentTool[];
	activeToolNames?: string[];
	streamOptions?: AgentHarnessStreamOptions;
	getApiKeyAndHeaders?: AgentHarnessOptions["getApiKeyAndHeaders"];
	thinkingLevel?: ThinkingLevel;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
}

export interface PipiSessionRuntime {
	sessionId: string;
	session: Session;
	contextStore: SessionContextStore;
	harness: AgentHarness;
	getContext(): Promise<ContextItem[]>;
	prompt(text: string): ReturnType<AgentHarness["prompt"]>;
	compact(customInstructions?: string): ReturnType<AgentHarness["compact"]>;
	setContext(options: { key: string; content: string; source?: string; updatedBy?: string }): ContextItem;
	listContext(): ContextItem[];
	unsetContext(key: string): boolean;
	buildSystemPrompt(): Promise<string>;
}

export class PipiRuntime {
	private readonly roleLoader: RoleLoader;
	private readonly options: Omit<PipiRuntimeOptions, "role">;
	private readonly sessionIds = new Set<string>();

	constructor(options: PipiRuntimeOptions) {
		this.roleLoader = typeof options.role === "string" ? new StaticRoleLoader(options.role) : options.role;
		this.options = options;
	}

	async createSession(sessionId?: string): Promise<PipiSessionRuntime> {
		const env = new NodeExecutionEnv({ cwd: this.options.cwd ?? process.cwd() });
		if (sessionId) this.claimSessionId(sessionId);
		const repo = this.options.sessionsRoot
			? new JsonlSessionRepo({ fs: env, sessionsRoot: this.options.sessionsRoot })
			: undefined;
		if (sessionId && repo) {
			const existing = await repo.list({ cwd: env.cwd });
			if (existing.some((session) => session.id === sessionId)) {
				throw new Error(`pipi session already exists: ${sessionId}`);
			}
		}
		const session = repo
			? await repo.create({
					...(sessionId ? { id: sessionId } : {}),
					cwd: env.cwd,
				})
			: await new InMemorySessionRepo().create(sessionId ? { id: sessionId } : {});
		const metadata = await session.getMetadata();
		if (!sessionId) this.claimSessionId(metadata.id);
		return this.createSessionRuntime(metadata.id, session, env);
	}

	async resumeSession(sessionId: string): Promise<PipiSessionRuntime> {
		if (!this.options.sessionsRoot) throw new Error("resumeSession requires sessionsRoot");
		this.claimSessionId(sessionId);
		const env = new NodeExecutionEnv({ cwd: this.options.cwd ?? process.cwd() });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: this.options.sessionsRoot });
		const sessions = await repo.list({ cwd: env.cwd });
		const metadata = sessions.find((session) => session.id === sessionId);
		if (!metadata) throw new Error(`pipi session not found: ${sessionId}`);
		return this.createSessionRuntime(sessionId, await repo.open(metadata), env);
	}

	async listSessions(): Promise<Array<{ id: string; createdAt: string; path: string }>> {
		if (!this.options.sessionsRoot) return [];
		const env = new NodeExecutionEnv({ cwd: this.options.cwd ?? process.cwd() });
		const sessions = await new JsonlSessionRepo({ fs: env, sessionsRoot: this.options.sessionsRoot }).list({ cwd: env.cwd });
		return sessions.map((session) => ({ id: session.id, createdAt: session.createdAt, path: session.path }));
	}

	private claimSessionId(sessionId: string): void {
		if (this.sessionIds.has(sessionId)) {
			throw new Error(`pipi session already exists: ${sessionId}`);
		}
		this.sessionIds.add(sessionId);
	}

	private createSessionRuntime(sessionId: string, session: Session, env: NodeExecutionEnv): PipiSessionRuntime {
		const contextStore = new SessionContextStore(this.options.contextStoreOptions);
		const tools = [...createContextTools(contextStore), ...(this.options.tools ?? [])];
		const harness = new AgentHarness({
			env,
			session,
			model: this.options.model,
			tools,
			activeToolNames: this.options.activeToolNames ?? tools.map((tool) => tool.name),
			streamOptions: this.options.streamOptions,
			getApiKeyAndHeaders: this.options.getApiKeyAndHeaders,
			thinkingLevel: this.options.thinkingLevel,
			steeringMode: this.options.steeringMode,
			followUpMode: this.options.followUpMode,
			systemPrompt: async () => this.buildSystemPrompt(contextStore),
		});
		return new DefaultPipiSessionRuntime(sessionId, session, contextStore, harness, () => this.buildSystemPrompt(contextStore));
	}

	private async buildSystemPrompt(contextStore: SessionContextStore): Promise<string> {
		const role = await this.roleLoader.load();
		return buildRoleSystemPrompt({
			baseSystemPrompt: this.options.baseSystemPrompt,
			role,
			sessionContext: contextStore.list(),
			skills: this.options.skills ?? [],
			toolMode: this.options.toolMode ?? "workspace",
		});
	}

}

class DefaultPipiSessionRuntime implements PipiSessionRuntime {
	readonly sessionId: string;
	readonly session: Session;
	readonly contextStore: SessionContextStore;
	readonly harness: AgentHarness;
	private readonly promptBuilder: () => Promise<string>;

	constructor(
		sessionId: string,
		session: Session,
		contextStore: SessionContextStore,
		harness: AgentHarness,
		promptBuilder: () => Promise<string>,
	) {
		this.sessionId = sessionId;
		this.session = session;
		this.contextStore = contextStore;
		this.harness = harness;
		this.promptBuilder = promptBuilder;
	}

	async getContext(): Promise<ContextItem[]> {
		return this.contextStore.list();
	}

	prompt(text: string): ReturnType<AgentHarness["prompt"]> {
		return this.harness.prompt(text);
	}

	compact(customInstructions?: string): ReturnType<AgentHarness["compact"]> {
		return this.harness.compact(customInstructions);
	}

	setContext(options: { key: string; content: string; source?: string; updatedBy?: string }): ContextItem {
		return this.contextStore.set({ scope: "session", ...options });
	}

	listContext(): ContextItem[] {
		return this.contextStore.list();
	}

	unsetContext(key: string): boolean {
		return this.contextStore.unset({ scope: "session", key });
	}

	buildSystemPrompt(): Promise<string> {
		return this.promptBuilder();
	}
}
