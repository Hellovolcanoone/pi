import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface RoleDefinition {
	path: string;
	content: string;
	hash: string;
}

export interface RoleLoader {
	load(): Promise<RoleDefinition>;
}

export class FileRoleLoader implements RoleLoader {
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	async load(): Promise<RoleDefinition> {
		const content = await readFile(this.path, "utf8");
		return createRoleDefinition(this.path, content);
	}
}

export class StaticRoleLoader implements RoleLoader {
	private readonly role: RoleDefinition;

	constructor(content: string, path = "ROLE.md") {
		this.role = createRoleDefinition(path, content);
	}

	async load(): Promise<RoleDefinition> {
		return this.role;
	}
}

export function createRoleDefinition(path: string, content: string): RoleDefinition {
	return {
		path,
		content,
		hash: createHash("sha256").update(content).digest("hex"),
	};
}
