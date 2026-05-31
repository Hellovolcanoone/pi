import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export interface PipiSkill {
	name: string;
	description: string;
	content: string;
	filePath: string;
}

export function loadSkillPath(path: string): PipiSkill[] {
	const resolved = resolve(path);
	if (!existsSync(resolved)) throw new Error(`Skill path not found: ${resolved}`);
	const stat = statSync(resolved);
	if (stat.isFile()) return [loadSkillFile(resolved)];
	if (stat.isDirectory()) return loadSkillDirectory(resolved);
	throw new Error(`Unsupported skill path: ${resolved}`);
}

export function loadSkillDirectory(path: string): PipiSkill[] {
	const skillFile = join(path, "SKILL.md");
	if (existsSync(skillFile)) return [loadSkillFile(skillFile)];
	const skills: PipiSkill[] = [];
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const nested = join(path, entry.name, "SKILL.md");
		if (existsSync(nested)) skills.push(loadSkillFile(nested));
	}
	return skills;
}

export function loadSkillFile(path: string): PipiSkill {
	const content = readFileSync(path, "utf8");
	const parsed = parseSkillMarkdown(content);
	return {
		name: parsed.name ?? basename(resolve(path), ".md"),
		description: parsed.description ?? "",
		content: parsed.body.trim(),
		filePath: resolve(path),
	};
}

export function mergeSkills(skills: PipiSkill[]): PipiSkill[] {
	const byName = new Map<string, PipiSkill>();
	for (const skill of skills) {
		if (byName.has(skill.name)) throw new Error(`Duplicate skill name: ${skill.name}`);
		byName.set(skill.name, skill);
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function parseSkillMarkdown(content: string): { name?: string; description?: string; body: string } {
	if (!content.startsWith("---\n")) return { body: content };
	const end = content.indexOf("\n---", 4);
	if (end === -1) return { body: content };
	const frontmatter = content.slice(4, end).trim();
	const body = content.slice(end + 4);
	const result: { name?: string; description?: string; body: string } = { body };
	for (const line of frontmatter.split("\n")) {
		const separator = line.indexOf(":");
		if (separator <= 0) continue;
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim().replace(/^['\"]|['\"]$/g, "");
		if (key === "name") result.name = value;
		if (key === "description") result.description = value;
	}
	return result;
}
