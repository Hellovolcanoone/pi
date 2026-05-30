import type { Model } from "@earendil-works/pi-ai";
import {
	AgentHarness,
	InMemorySessionRepo,
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

export interface RoleAgentRuntimeOptions {
	role: RoleLoader | string;
	model: Model<any>;
	cwd?: string;
	baseSystemPrompt?: string;
	contextStoreOptions?: SessionContextStoreOptions;
	tools?: AgentTool[];
	activeToolNames?: string[];
	streamOptions?: AgentHarnessStreamOptions;
	getApiKeyAndHeaders?: AgentHarnessOptions["getApiKeyAndHeaders"];
	thinkingLevel?: ThinkingLevel;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
}

export interface RoleSessionRuntime {
	sessionId: string;
	session: Session;
	contextStore: SessionContextStore;
	harness: AgentHarness;
	prompt(text: string): ReturnType<AgentHarness["prompt"]>;
	compact(customInstructions?: string): ReturnType<AgentHarness["compact"]>;
	setContext(options: { key: string; content: string; source?: string; updatedBy?: string }): ContextItem;
	listContext(): ContextItem[];
	unsetContext(key: string): boolean;
	buildSystemPrompt(): Promise<string>;
}

export class RoleAgentRuntime {
	private readonly roleLoader: RoleLoader;
	private readonly options: Omit<RoleAgentRuntimeOptions, "role">;
	private readonly sessionIds = new Set<string>();
	private nextSessionNumber = 0;

	constructor(options: RoleAgentRuntimeOptions) {
		this.roleLoader = typeof options.role === "string" ? new StaticRoleLoader(options.role) : options.role;
		this.options = options;
	}

	async createSession(sessionId = this.createSessionId()): Promise<RoleSessionRuntime> {
		if (this.sessionIds.has(sessionId)) {
			throw new Error(`Role agent session already exists: ${sessionId}`);
		}
		this.sessionIds.add(sessionId);
		const contextStore = new SessionContextStore(this.options.contextStoreOptions);
		const session = await new InMemorySessionRepo().create({ id: sessionId });
		const env = new NodeExecutionEnv({ cwd: this.options.cwd ?? process.cwd() });
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
		return new DefaultRoleSessionRuntime(sessionId, session, contextStore, harness, () => this.buildSystemPrompt(contextStore));
	}

	private async buildSystemPrompt(contextStore: SessionContextStore): Promise<string> {
		const role = await this.roleLoader.load();
		return buildRoleSystemPrompt({
			baseSystemPrompt: this.options.baseSystemPrompt,
			role,
			sessionContext: contextStore.list(),
		});
	}

	private createSessionId(): string {
		this.nextSessionNumber += 1;
		return `role-session-${this.nextSessionNumber}`;
	}
}

class DefaultRoleSessionRuntime implements RoleSessionRuntime {
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
