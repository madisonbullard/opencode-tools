/**
 * Utilities for creating and extracting session archives.
 *
 * This module provides functions to:
 * 1. Scan the opencode data directories for files related to a session
 * 2. Create a zip archive of those files maintaining folder structure
 * 3. Extract archives and place files in the correct locations
 */

import {
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import {
	type PathResolutionResult,
	resolveProjectPath,
	verifyRepoPath,
} from "./detect-repo";
import { getProjectName, remapPaths } from "./path-utils";

// Base opencode data directory
const OPENCODE_DATA_DIR = join(homedir(), ".local", "share", "opencode");
const STORAGE_DIR = join(OPENCODE_DATA_DIR, "storage");
const SNAPSHOT_DIR = join(OPENCODE_DATA_DIR, "snapshot");

// Directory to store session archives
const SESSION_ARCHIVES_DIR = join(homedir(), ".opencode", "session-archives");

export interface SessionFile {
	/** Relative path from the opencode data directory */
	relativePath: string;
	/** Absolute path to the file */
	absolutePath: string;
	/** File type category */
	type:
		| "session"
		| "message"
		| "part"
		| "session_diff"
		| "project"
		| "snapshot";
}

export interface SessionArchiveInfo {
	sessionId: string;
	projectId: string;
	title: string;
	directory: string;
	files: SessionFile[];
}

interface SessionData {
	id: string;
	projectID: string;
	title: string;
	directory: string;
	time: { created: number; updated: number };
}

interface MessageData {
	id: string;
	sessionID: string;
}

/**
 * Check if a file exists
 */
async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read and parse a JSON file
 */
async function readJson<T>(path: string): Promise<T> {
	const content = await readFile(path, "utf-8");
	return JSON.parse(content);
}

/**
 * Find the session file for a given session ID across all project directories
 */
async function findSessionFile(
	sessionId: string,
): Promise<{ path: string; projectId: string } | null> {
	const sessionDir = join(STORAGE_DIR, "session");
	if (!(await fileExists(sessionDir))) {
		return null;
	}

	const projectDirs = await readdir(sessionDir);
	for (const projectId of projectDirs) {
		const sessionFile = join(sessionDir, projectId, `${sessionId}.json`);
		if (await fileExists(sessionFile)) {
			return { path: sessionFile, projectId };
		}
	}
	return null;
}

/**
 * Collect all files related to a session.
 * This includes:
 * - The session file itself
 * - All message files for the session
 * - All part files for those messages
 * - The session_diff file
 * - The project file
 * - The snapshot directory for the project (if it exists)
 */
export async function collectSessionFiles(
	sessionId: string,
): Promise<SessionArchiveInfo> {
	const files: SessionFile[] = [];

	// Find and read the session file
	const sessionFileInfo = await findSessionFile(sessionId);
	if (!sessionFileInfo) {
		throw new Error(`Session file not found for session ID: ${sessionId}`);
	}

	const sessionData = await readJson<SessionData>(sessionFileInfo.path);
	const projectId = sessionFileInfo.projectId;

	// Add session file
	files.push({
		relativePath: relative(OPENCODE_DATA_DIR, sessionFileInfo.path),
		absolutePath: sessionFileInfo.path,
		type: "session",
	});

	// Find message files for this session
	const messageDir = join(STORAGE_DIR, "message", sessionId);
	if (await fileExists(messageDir)) {
		const messageFiles = await readdir(messageDir);
		const messageIds: string[] = [];

		for (const msgFile of messageFiles) {
			if (!msgFile.endsWith(".json")) continue;

			const msgPath = join(messageDir, msgFile);
			files.push({
				relativePath: relative(OPENCODE_DATA_DIR, msgPath),
				absolutePath: msgPath,
				type: "message",
			});

			// Track message ID for part lookup
			const messageData = await readJson<MessageData>(msgPath);
			messageIds.push(messageData.id);
		}

		// Find part files for each message
		for (const messageId of messageIds) {
			const partDir = join(STORAGE_DIR, "part", messageId);
			if (await fileExists(partDir)) {
				const partFiles = await readdir(partDir);
				for (const partFile of partFiles) {
					if (!partFile.endsWith(".json")) continue;

					const partPath = join(partDir, partFile);
					files.push({
						relativePath: relative(OPENCODE_DATA_DIR, partPath),
						absolutePath: partPath,
						type: "part",
					});
				}
			}
		}
	}

	// Find session_diff file
	const sessionDiffFile = join(
		STORAGE_DIR,
		"session_diff",
		`${sessionId}.json`,
	);
	if (await fileExists(sessionDiffFile)) {
		files.push({
			relativePath: relative(OPENCODE_DATA_DIR, sessionDiffFile),
			absolutePath: sessionDiffFile,
			type: "session_diff",
		});
	}

	// Find project file
	const projectFile = join(STORAGE_DIR, "project", `${projectId}.json`);
	if (await fileExists(projectFile)) {
		files.push({
			relativePath: relative(OPENCODE_DATA_DIR, projectFile),
			absolutePath: projectFile,
			type: "project",
		});
	}

	// Find snapshot directory for this project
	const snapshotDir = join(SNAPSHOT_DIR, projectId);
	if (await fileExists(snapshotDir)) {
		// Recursively collect all files in the snapshot directory
		await collectSnapshotFiles(snapshotDir, files);
	}

	return {
		sessionId,
		projectId,
		title: sessionData.title,
		directory: sessionData.directory,
		files,
	};
}

/**
 * Recursively collect files from a snapshot directory
 */
async function collectSnapshotFiles(
	dir: string,
	files: SessionFile[],
): Promise<void> {
	const entries = await readdir(dir, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);

		if (entry.isDirectory()) {
			await collectSnapshotFiles(fullPath, files);
		} else if (entry.isFile()) {
			files.push({
				relativePath: relative(OPENCODE_DATA_DIR, fullPath),
				absolutePath: fullPath,
				type: "snapshot",
			});
		}
	}
}

/**
 * Create a zip archive of session files.
 * Returns the path to the created archive.
 */
export async function createSessionArchive(sessionId: string): Promise<{
	archivePath: string;
	archiveId: string;
	info: SessionArchiveInfo;
}> {
	// Collect all files
	const info = await collectSessionFiles(sessionId);

	// Create archive ID based on date and session title
	const dateStr = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
	const kebabTitle = toKebabCase(info.title || "untitled");
	const archiveId = `${dateStr}-${kebabTitle}`;

	// Create tmp directory for staging
	const tmpDir = join(tmpdir(), `opencode-archive-${Date.now()}`);
	await mkdir(tmpDir, { recursive: true });

	try {
		// Copy all files to tmp directory maintaining structure
		for (const file of info.files) {
			const destPath = join(tmpDir, file.relativePath);
			await mkdir(dirname(destPath), { recursive: true });
			const content = await readFile(file.absolutePath);
			await writeFile(destPath, content);
		}

		// Create the archives directory
		await mkdir(SESSION_ARCHIVES_DIR, { recursive: true });

		// Create zip archive using native zip command (available on macOS/Linux)
		const archivePath = join(SESSION_ARCHIVES_DIR, `${archiveId}.zip`);

		// Use Bun's native zip functionality or fall back to command line
		const { execSync } = await import("node:child_process");
		execSync(`cd "${tmpDir}" && zip -r "${archivePath}" .`, { stdio: "pipe" });

		return { archivePath, archiveId, info };
	} finally {
		// Clean up tmp directory
		await rm(tmpDir, { recursive: true, force: true });
	}
}

/**
 * Convert a string to kebab-case
 */
function toKebabCase(str: string): string {
	return str
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-");
}

/**
 * List available session archives
 */
export async function listSessionArchives(): Promise<
	Array<{
		archiveId: string;
		archivePath: string;
		created: string;
	}>
> {
	if (!(await fileExists(SESSION_ARCHIVES_DIR))) {
		return [];
	}

	const files = await readdir(SESSION_ARCHIVES_DIR);
	const archives: Array<{
		archiveId: string;
		archivePath: string;
		created: string;
	}> = [];

	for (const file of files) {
		if (!file.endsWith(".zip")) continue;

		const archiveId = file.replace(".zip", "");
		const archivePath = join(SESSION_ARCHIVES_DIR, file);
		const stats = await stat(archivePath);
		const created = stats.mtime.toLocaleString();

		archives.push({ archiveId, archivePath, created });
	}

	return archives;
}

/**
 * Get the session archives directory path
 */
export function getSessionArchivesDir(): string {
	return SESSION_ARCHIVES_DIR;
}

export interface ExtractArchiveOptions {
	/**
	 * If provided, remap all paths from the original project path to this path.
	 */
	remapToPath?: string;
}

export interface ExtractArchiveResult {
	success: boolean;
	sessionId: string;
	sessionTitle: string;
	fileCount: number;
	pathRemapped?: boolean;
	originalPath?: string;
	newPath?: string;
}

export interface ArchiveAnalysis {
	archiveId: string;
	sessionId: string;
	title: string;
	originalPath: string;
	projectName: string;
	pathResolution: PathResolutionResult;
}

/**
 * Analyze an archive to determine if path remapping is needed.
 */
export async function analyzeArchive(
	archiveIdOrPath: string,
): Promise<ArchiveAnalysis> {
	const archivePath = resolveArchivePath(archiveIdOrPath);
	const archiveId = basename(archivePath).replace(".zip", "");

	// Extract to temp directory to analyze
	const tmpDir = join(tmpdir(), `opencode-analyze-${Date.now()}`);
	await mkdir(tmpDir, { recursive: true });

	try {
		const { execSync } = await import("node:child_process");
		execSync(`unzip -q "${archivePath}" -d "${tmpDir}"`, { stdio: "pipe" });

		// Find and read the session file
		const sessionDir = join(tmpDir, "storage", "session");
		if (!(await fileExists(sessionDir))) {
			throw new Error("Invalid archive: missing storage/session directory");
		}

		const projectDirs = await readdir(sessionDir);
		if (projectDirs.length === 0) {
			throw new Error("Invalid archive: no session files found");
		}

		// Find first session file
		let sessionData: SessionData | null = null;
		let sessionId = "";

		for (const projectId of projectDirs) {
			const projectDir = join(sessionDir, projectId);
			const sessionFiles = await readdir(projectDir);
			for (const sessionFile of sessionFiles) {
				if (sessionFile.endsWith(".json")) {
					sessionData = await readJson<SessionData>(
						join(projectDir, sessionFile),
					);
					sessionId = sessionData.id;
					break;
				}
			}
			if (sessionData) break;
		}

		if (!sessionData) {
			throw new Error("Invalid archive: no session data found");
		}

		const originalPath = sessionData.directory;
		const projectName = getProjectName(originalPath);
		const pathResolution = await resolveProjectPath(originalPath, projectName);

		return {
			archiveId,
			sessionId,
			title: sessionData.title,
			originalPath,
			projectName,
			pathResolution,
		};
	} finally {
		await rm(tmpDir, { recursive: true, force: true });
	}
}

/**
 * Validate a user-provided path for remapping.
 */
export async function validateArchiveRemapPath(
	path: string,
): Promise<{ valid: boolean; error?: string }> {
	return verifyRepoPath(path);
}

/**
 * Extract a session archive and place files in the appropriate opencode directories.
 */
export async function extractSessionArchive(
	archiveIdOrPath: string,
	options: ExtractArchiveOptions = {},
): Promise<ExtractArchiveResult> {
	const archivePath = resolveArchivePath(archiveIdOrPath);

	// Extract to temp directory first
	const tmpDir = join(tmpdir(), `opencode-extract-${Date.now()}`);
	await mkdir(tmpDir, { recursive: true });

	try {
		const { execSync } = await import("node:child_process");
		execSync(`unzip -q "${archivePath}" -d "${tmpDir}"`, { stdio: "pipe" });

		// Find the session file to get session info
		const sessionDir = join(tmpDir, "storage", "session");
		let sessionData: SessionData | null = null;
		let sessionId = "";

		const projectDirs = await readdir(sessionDir);
		for (const projectId of projectDirs) {
			const projectDir = join(sessionDir, projectId);
			const sessionFiles = await readdir(projectDir);
			for (const sessionFile of sessionFiles) {
				if (sessionFile.endsWith(".json")) {
					sessionData = await readJson<SessionData>(
						join(projectDir, sessionFile),
					);
					sessionId = sessionData.id;
					break;
				}
			}
			if (sessionData) break;
		}

		if (!sessionData) {
			throw new Error("Invalid archive: no session data found");
		}

		const originalPath = sessionData.directory;
		let pathRemapped = false;
		let newPath: string | undefined;

		// Apply path remapping if needed
		if (options.remapToPath && originalPath) {
			const validation = await verifyRepoPath(options.remapToPath);
			if (!validation.valid) {
				throw new Error(
					`Invalid remap path: ${validation.error ?? "Path is not a valid git repository"}`,
				);
			}

			// Remap all JSON files in the extracted archive
			await remapAllJsonFiles(tmpDir, originalPath, options.remapToPath);
			pathRemapped = true;
			newPath = options.remapToPath;
		}

		// Mark session as imported and copy files to opencode data directory
		const storageDir = join(tmpDir, "storage");
		const snapshotDir = join(tmpDir, "snapshot");
		let fileCount = 0;

		// Copy storage files
		if (await fileExists(storageDir)) {
			fileCount += await copyDirRecursive(
				storageDir,
				STORAGE_DIR,
				(content, filePath) => {
					// Mark session as imported
					if (filePath.includes("/session/") && filePath.endsWith(".json")) {
						try {
							const data = JSON.parse(content);
							if (data.title && !data.title.startsWith("[IMPORTED]")) {
								data.title = `[IMPORTED] ${data.title}`;
							}
							return JSON.stringify(data, null, 2);
						} catch {
							return content;
						}
					}
					return content;
				},
			);
		}

		// Copy snapshot files
		if (await fileExists(snapshotDir)) {
			fileCount += await copyDirRecursive(snapshotDir, SNAPSHOT_DIR);
		}

		// Re-read session data to get the (potentially modified) title
		const finalSessionPath = join(
			STORAGE_DIR,
			"session",
			sessionData.projectID,
			`${sessionId}.json`,
		);
		let finalTitle = sessionData.title;
		if (await fileExists(finalSessionPath)) {
			const finalData = await readJson<SessionData>(finalSessionPath);
			finalTitle = finalData.title;
		}

		return {
			success: true,
			sessionId,
			sessionTitle: finalTitle,
			fileCount,
			pathRemapped,
			originalPath,
			newPath,
		};
	} finally {
		await rm(tmpDir, { recursive: true, force: true });
	}
}

/**
 * Recursively remap paths in all JSON files in a directory
 */
async function remapAllJsonFiles(
	dir: string,
	oldPath: string,
	newPath: string,
): Promise<void> {
	const entries = await readdir(dir, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);

		if (entry.isDirectory()) {
			await remapAllJsonFiles(fullPath, oldPath, newPath);
		} else if (entry.isFile() && entry.name.endsWith(".json")) {
			try {
				const content = await readFile(fullPath, "utf-8");
				const data = JSON.parse(content);
				const remapped = remapPaths(data, oldPath, newPath);
				await writeFile(fullPath, JSON.stringify(remapped, null, 2));
			} catch {
				// Skip files that can't be parsed as JSON
			}
		}
	}
}

/**
 * Recursively copy a directory.
 * Skips files that already exist at the destination to avoid permission errors
 * (e.g., git objects in snapshots are stored with read-only permissions).
 */
async function copyDirRecursive(
	srcDir: string,
	destDir: string,
	transform?: (content: string, filePath: string) => string,
): Promise<number> {
	let count = 0;
	const entries = await readdir(srcDir, { withFileTypes: true });

	for (const entry of entries) {
		const srcPath = join(srcDir, entry.name);
		const destPath = join(destDir, entry.name);

		if (entry.isDirectory()) {
			await mkdir(destPath, { recursive: true });
			count += await copyDirRecursive(srcPath, destPath, transform);
		} else if (entry.isFile()) {
			// Skip files that already exist to avoid permission errors
			// (git objects in snapshots are read-only and content-addressable,
			// so if they exist with the same path, they have the same content)
			if (await fileExists(destPath)) {
				count++;
				continue;
			}

			await mkdir(dirname(destPath), { recursive: true });

			if (transform && entry.name.endsWith(".json")) {
				const content = await readFile(srcPath, "utf-8");
				const transformed = transform(content, srcPath);
				await writeFile(destPath, transformed);
			} else {
				const content = await readFile(srcPath);
				await writeFile(destPath, content);
			}
			count++;
		}
	}

	return count;
}

/**
 * Resolve an archive ID or path to a full file path
 */
function resolveArchivePath(arg: string): string {
	if (arg.includes("/") || arg.endsWith(".zip")) {
		return arg;
	}
	return join(SESSION_ARCHIVES_DIR, `${arg}.zip`);
}
