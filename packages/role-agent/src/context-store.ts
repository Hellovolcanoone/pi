export type ContextScope = "session";

export interface ContextLimits {
	maxKeyChars: number;
	maxChars: number;
	maxTotalChars: number;
	maxItems: number;
}

export interface ContextItem {
	scope: ContextScope;
	key: string;
	content: string;
	source?: string;
	updatedBy?: string;
	createdAt: string;
	updatedAt: string;
}

export interface SetContextOptions {
	scope?: ContextScope;
	key: string;
	content: string;
	source?: string;
	updatedBy?: string;
}

export interface UnsetContextOptions {
	scope?: ContextScope;
	key: string;
}

export interface SessionContextStoreOptions {
	limits?: Partial<ContextLimits>;
	now?: () => string;
}

const DEFAULT_CONTEXT_LIMITS: ContextLimits = {
	maxKeyChars: 120,
	maxChars: 4000,
	maxTotalChars: 12000,
	maxItems: 20,
};

function normalizeScope(scope: ContextScope | undefined): ContextScope {
	if (scope === undefined || scope === "session") return "session";
	throw new Error("role-agent MVP only supports session context scope");
}

function normalizeKey(key: string, maxKeyChars: number): string {
	const normalized = key.trim();
	if (!normalized) throw new Error("Context key cannot be empty");
	if (normalized.length > maxKeyChars) {
		throw new Error(`Context key exceeds maxKeyChars limit of ${maxKeyChars}`);
	}
	return normalized;
}

function assertContentWithinLimit(content: string, maxChars: number): void {
	if (content.length > maxChars) {
		throw new Error(`Context content exceeds maxChars limit of ${maxChars}`);
	}
}

function injectedContextChars(item: ContextItem): number {
	return `- ${item.key}: ${item.content}`.length;
}

function totalInjectedContextChars(items: Iterable<ContextItem>): number {
	let total = 0;
	let count = 0;
	for (const item of items) {
		total += injectedContextChars(item);
		count += 1;
	}
	return total + Math.max(0, count - 1);
}

export class SessionContextStore {
	readonly limits: ContextLimits;
	private readonly now: () => string;
	private readonly items = new Map<string, ContextItem>();

	constructor(options: SessionContextStoreOptions = {}) {
		this.limits = { ...DEFAULT_CONTEXT_LIMITS, ...options.limits };
		this.now = options.now ?? (() => new Date().toISOString());
	}

	set(options: SetContextOptions): ContextItem {
		const scope = normalizeScope(options.scope);
		const key = normalizeKey(options.key, this.limits.maxKeyChars);
		assertContentWithinLimit(options.content, this.limits.maxChars);
		const existing = this.items.get(key);
		const timestamp = this.now();
		const item: ContextItem = {
			scope,
			key,
			content: options.content,
			source: options.source,
			updatedBy: options.updatedBy,
			createdAt: existing?.createdAt ?? timestamp,
			updatedAt: timestamp,
		};
		const nextItems = new Map(this.items);
		nextItems.set(key, item);
		if (!existing && nextItems.size > this.limits.maxItems) {
			throw new Error(`Session context exceeds maxItems limit of ${this.limits.maxItems}`);
		}
		const totalChars = totalInjectedContextChars(nextItems.values());
		if (totalChars > this.limits.maxTotalChars) {
			throw new Error(`Session context exceeds maxTotalChars limit of ${this.limits.maxTotalChars}`);
		}
		this.items.clear();
		for (const [itemKey, nextItem] of nextItems) this.items.set(itemKey, nextItem);
		return item;
	}

	unset(options: UnsetContextOptions): boolean {
		normalizeScope(options.scope);
		return this.items.delete(normalizeKey(options.key, this.limits.maxKeyChars));
	}

	list(): ContextItem[] {
		return [...this.items.values()].sort((a, b) => a.key.localeCompare(b.key));
	}

	get(key: string): ContextItem | undefined {
		return this.items.get(normalizeKey(key, this.limits.maxKeyChars));
	}

	clear(): void {
		this.items.clear();
	}
}
