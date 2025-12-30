/**
 * Utilities for detecting and locating git repositories on the local machine.
 *
 * When ingesting a private-share session, we need to find where the user
 * has the same repository on their machine. This module provides functions
 * to search for repositories by name.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { getCommonSearchPaths, pathExistsSync } from "./path-utils";

export interface RepoSearchResult {
	found: boolean;
	path: string | null;
	candidates: string[];
}

/**
 * Check if a directory is a git repository.
 */
async function isGitRepo(dirPath: string): Promise<boolean> {
	try {
		const gitDir = join(dirPath, ".git");
		const stats = await stat(gitDir);
		return stats.isDirectory();
	} catch {
		return false;
	}
}

/**
 * Search for a repository by name in common project directories.
 * Returns all matching directories that contain a .git folder.
 *
 * @param projectName - The name of the project/repo to search for
 * @param maxDepth - How deep to search in each directory (default: 3)
 */
export async function findRepositoryByName(
	projectName: string,
	maxDepth = 3,
): Promise<RepoSearchResult> {
	const searchPaths = getCommonSearchPaths();
	const candidates: string[] = [];

	for (const basePath of searchPaths) {
		if (!pathExistsSync(basePath)) {
			continue;
		}

		const found = await searchInDirectory(basePath, projectName, maxDepth, 0);
		candidates.push(...found);
	}

	// Remove duplicates
	const uniqueCandidates = [...new Set(candidates)];

	return {
		found: uniqueCandidates.length > 0,
		path: uniqueCandidates.length === 1 ? uniqueCandidates[0] : null,
		candidates: uniqueCandidates,
	};
}

/**
 * Recursively search for a directory matching the project name.
 */
async function searchInDirectory(
	basePath: string,
	projectName: string,
	maxDepth: number,
	currentDepth: number,
): Promise<string[]> {
	if (currentDepth > maxDepth) {
		return [];
	}

	const results: string[] = [];

	try {
		const entries = await readdir(basePath, { withFileTypes: true });

		for (const entry of entries) {
			// Skip hidden directories (except .git which we check separately)
			if (entry.name.startsWith(".")) {
				continue;
			}

			if (!entry.isDirectory()) {
				continue;
			}

			const fullPath = join(basePath, entry.name);

			// Check if this directory matches the project name
			if (entry.name === projectName) {
				// Verify it's a git repo
				if (await isGitRepo(fullPath)) {
					results.push(fullPath);
				}
			}

			// Continue searching deeper
			if (currentDepth < maxDepth) {
				const deeper = await searchInDirectory(
					fullPath,
					projectName,
					maxDepth,
					currentDepth + 1,
				);
				results.push(...deeper);
			}
		}
	} catch {
		// Ignore permission errors and other issues
	}

	return results;
}

/**
 * Verify that a user-provided path exists and is a git repository.
 */
export async function verifyRepoPath(
	path: string,
): Promise<{ valid: boolean; error?: string }> {
	try {
		const stats = await stat(path);
		if (!stats.isDirectory()) {
			return { valid: false, error: "Path is not a directory" };
		}

		if (!(await isGitRepo(path))) {
			return { valid: false, error: "Path is not a git repository" };
		}

		return { valid: true };
	} catch (error) {
		return {
			valid: false,
			error: `Path does not exist or is not accessible: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export interface PathResolutionResult {
	resolved: boolean;
	newPath: string | null;
	requiresUserInput: boolean;
	candidates: string[];
	error?: string;
}

/**
 * Attempt to resolve the project path for ingestion.
 * Returns information about whether we need user input.
 */
export async function resolveProjectPath(
	originalPath: string,
	projectName: string,
): Promise<PathResolutionResult> {
	// First, check if the original path exists
	if (pathExistsSync(originalPath)) {
		return {
			resolved: true,
			newPath: originalPath,
			requiresUserInput: false,
			candidates: [originalPath],
		};
	}

	// Search for the repo by name
	const searchResult = await findRepositoryByName(projectName);

	if (!searchResult.found) {
		return {
			resolved: false,
			newPath: null,
			requiresUserInput: true,
			candidates: [],
			error: `Could not find repository "${projectName}" on this machine`,
		};
	}

	if (searchResult.path) {
		// Exactly one match found
		return {
			resolved: true,
			newPath: searchResult.path,
			requiresUserInput: false,
			candidates: searchResult.candidates,
		};
	}

	// Multiple candidates found - need user to choose
	return {
		resolved: false,
		newPath: null,
		requiresUserInput: true,
		candidates: searchResult.candidates,
	};
}
