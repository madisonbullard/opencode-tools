/**
 * Utilities for detecting and remapping paths in private-share JSON files.
 *
 * When a session is shared between machines, the original project path
 * (e.g., /Users/alice/projects/repo) needs to be remapped to the ingesting
 * user's local path (e.g., /home/bob/code/repo).
 */

import { accessSync } from "node:fs";
import { basename } from "node:path";

/**
 * Fields that may contain absolute paths in a private-share JSON.
 * These need to be remapped when ingesting on a different machine.
 */
export const PATH_FIELDS = [
	"directory", // session.data.directory
	"worktree", // project.worktree
	"cwd", // message.path.cwd, part.state.input.workdir
	"root", // message.path.root
	"filePath", // tool inputs
] as const;

/**
 * Extract the original project directory from a private-share JSON.
 * This looks for the session.data.directory field which contains the
 * absolute path where the session was originally created.
 */
export function extractOriginalPath(privateShareData: unknown): string | null {
	if (!privateShareData || typeof privateShareData !== "object") {
		return null;
	}

	const data = privateShareData as { data?: unknown[] };
	if (!Array.isArray(data.data)) {
		return null;
	}

	// Find the session entry
	const sessionEntry = data.data.find(
		(entry: unknown) =>
			entry &&
			typeof entry === "object" &&
			(entry as { type?: string }).type === "session",
	) as { type: "session"; data?: { directory?: string } } | undefined;

	return sessionEntry?.data?.directory ?? null;
}

/**
 * Extract the project name from a path.
 * E.g., "/Users/alice/projects/my-repo" -> "my-repo"
 */
export function getProjectName(projectPath: string): string {
	return basename(projectPath);
}

/**
 * Recursively replace all occurrences of oldPath with newPath in an object.
 * This handles nested objects and arrays, and looks for paths in:
 * - String values that start with oldPath
 * - Known path fields (directory, worktree, cwd, root, filePath)
 */
export function remapPaths(
	obj: unknown,
	oldPath: string,
	newPath: string,
): unknown {
	if (obj === null || obj === undefined) {
		return obj;
	}

	if (typeof obj === "string") {
		// Replace if the string starts with the old path
		if (obj.startsWith(oldPath)) {
			return obj.replace(oldPath, newPath);
		}
		return obj;
	}

	if (Array.isArray(obj)) {
		return obj.map((item) => remapPaths(item, oldPath, newPath));
	}

	if (typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			result[key] = remapPaths(value, oldPath, newPath);
		}
		return result;
	}

	return obj;
}

/**
 * Validate that a path looks like an absolute path.
 */
export function isAbsolutePath(path: string): boolean {
	return path.startsWith("/") || /^[A-Za-z]:[/\\]/.test(path);
}

/**
 * Get a list of common directories to search for git repositories.
 */
export function getCommonSearchPaths(): string[] {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	if (!home) return [];

	return [
		`${home}/Documents/Projects`,
		`${home}/Projects`,
		`${home}/projects`,
		`${home}/repos`,
		`${home}/Repos`,
		`${home}/code`,
		`${home}/Code`,
		`${home}/src`,
		`${home}/dev`,
		`${home}/Development`,
		`${home}/workspace`,
		`${home}/Workspace`,
		`${home}/git`,
		`${home}/GitHub`,
		`${home}/gitlab`,
		home, // Also search home directory root
	];
}

export interface PathRemapInfo {
	originalPath: string;
	projectName: string;
	requiresRemap: boolean;
}

/**
 * Analyze a private-share file and determine if path remapping is needed.
 */
export function analyzePathRemapNeeds(
	privateShareData: unknown,
): PathRemapInfo | null {
	const originalPath = extractOriginalPath(privateShareData);
	if (!originalPath) {
		return null;
	}

	const projectName = getProjectName(originalPath);

	// Check if the original path exists on this machine
	const requiresRemap = !pathExistsSync(originalPath);

	return {
		originalPath,
		projectName,
		requiresRemap,
	};
}

/**
 * Synchronous check if a path exists (for quick validation).
 */
export function pathExistsSync(path: string): boolean {
	try {
		accessSync(path);
		return true;
	} catch {
		return false;
	}
}
