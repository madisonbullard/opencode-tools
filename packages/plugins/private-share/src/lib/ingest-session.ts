/**
 * Script to ingest a session from a private-share JSON file and write the data
 * directly into the opencode storage folder structure.
 *
 * This creates native opencode session data from a private-share file,
 * allowing the session to appear in the session list and be fully navigable.
 *
 * Supports path remapping for sessions created on different machines.
 */

import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type PathResolutionResult,
	resolveProjectPath,
	verifyRepoPath,
} from "./detect-repo";
import { extractOriginalPath, getProjectName, remapPaths } from "./path-utils";

// Private shares directory
const PRIVATE_SHARES_DIR = join(homedir(), ".opencode", "private-shares");

// Storage directory for opencode data
const STORAGE_DIR = join(homedir(), ".local", "share", "opencode", "storage");

// Types matching the private-share file format
interface PrivateShareSession {
	id: string;
	sessionID: string;
	createdAt: number;
	data: ShareData[];
}

type ShareData =
	| { type: "session"; data: SessionData }
	| { type: "message"; data: MessageData }
	| { type: "part"; data: PartData }
	| { type: "session_diff"; data: DiffData[] }
	| { type: "model"; data: ModelInfo[] };

interface SessionData {
	id: string;
	version: string;
	projectID: string;
	directory: string;
	title: string;
	time: { created: number; updated: number };
	summary: { additions: number; deletions: number; files: number };
}

interface MessageData {
	id: string;
	sessionID: string;
	role: "user" | "assistant";
	time: { created: number; completed?: number };
	summary?: {
		title?: string;
		body?: string;
		diffs?: Array<{
			file: string;
			before: string;
			after: string;
			additions: number;
			deletions: number;
		}>;
	};
	parentID?: string;
	modelID?: string;
	providerID?: string;
	mode?: string;
	agent?: string;
	path?: { cwd: string; root: string };
	cost?: number;
	tokens?: {
		input: number;
		output: number;
		reasoning: number;
		cache: { read: number; write: number };
	};
	finish?: string;
	model?: { providerID: string; modelID: string };
}

interface PartData {
	id: string;
	sessionID: string;
	messageID: string;
	type: string;
	text?: string;
	tool?: string;
	state?: { input?: unknown; output?: string; status?: string };
	snapshot?: string;
	reason?: string;
	cost?: number;
	tokens?: {
		input: number;
		output: number;
		reasoning: number;
		cache: { read: number; write: number };
	};
	time?: { start: number; end: number };
}

interface DiffData {
	file: string;
	before: string;
	after: string;
	additions: number;
	deletions: number;
}

interface ModelInfo {
	id: string;
	providerID: string;
	name: string;
}

interface ProjectData {
	id: string;
	worktree: string;
	vcs: string;
	time: { created: number; updated: number };
}

export interface IngestResult {
	success: boolean;
	sessionId: string;
	sessionTitle: string;
	messageCount: number;
	partCount: number;
	diffCount: number;
	pathRemapped?: boolean;
	originalPath?: string;
	newPath?: string;
}

export interface IngestOptions {
	/**
	 * If provided, remap all paths from the original project path to this path.
	 * Use this when the session was created on a different machine.
	 */
	remapToPath?: string;
}

export interface SessionAnalysis {
	shareId: string;
	title: string;
	originalPath: string;
	projectName: string;
	pathResolution: PathResolutionResult;
}

export interface ListSessionsResult {
	sessions: Array<{
		shareId: string;
		title: string;
		created: string;
		messageCount: number;
	}>;
}

/**
 * Check if a file exists
 */
async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Ensure a directory exists, creating it if necessary
 */
async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

/**
 * Write JSON data to a file
 */
async function writeJson(path: string, data: unknown): Promise<void> {
	await writeFile(path, JSON.stringify(data, null, 2));
}

/**
 * Write project data if it doesn't exist
 */
async function writeProject(projectData: ProjectData): Promise<boolean> {
	const projectDir = join(STORAGE_DIR, "project");
	await ensureDir(projectDir);

	const projectFile = join(projectDir, `${projectData.id}.json`);
	if (await fileExists(projectFile)) {
		return false; // Already exists
	}

	await writeJson(projectFile, projectData);
	return true;
}

/**
 * Write session data to the appropriate location
 */
async function writeSession(session: SessionData): Promise<void> {
	const sessionDir = join(STORAGE_DIR, "session", session.projectID);
	await ensureDir(sessionDir);

	const sessionFile = join(sessionDir, `${session.id}.json`);
	await writeJson(sessionFile, session);
}

/**
 * Write message data to the appropriate location
 */
async function writeMessage(message: MessageData): Promise<void> {
	const messageDir = join(STORAGE_DIR, "message", message.sessionID);
	await ensureDir(messageDir);

	const messageFile = join(messageDir, `${message.id}.json`);
	await writeJson(messageFile, message);
}

/**
 * Write part data to the appropriate location
 */
async function writePart(part: PartData): Promise<void> {
	const partDir = join(STORAGE_DIR, "part", part.messageID);
	await ensureDir(partDir);

	const partFile = join(partDir, `${part.id}.json`);
	await writeJson(partFile, part);
}

/**
 * Write session diffs to the appropriate location
 */
async function writeSessionDiff(
	sessionID: string,
	diffs: DiffData[],
): Promise<void> {
	const diffDir = join(STORAGE_DIR, "session_diff");
	await ensureDir(diffDir);

	const diffFile = join(diffDir, `${sessionID}.json`);
	await writeJson(diffFile, diffs);
}

/**
 * Resolve a share ID or path to a full file path
 */
function resolveShareFilePath(arg: string): string {
	// If it looks like a path (contains / or ends with .json), use it directly
	if (arg.includes("/") || arg.endsWith(".json")) {
		return arg;
	}
	// Otherwise, treat it as a share ID
	return join(PRIVATE_SHARES_DIR, `${arg}.json`);
}

/**
 * Analyze a session to determine if path remapping is needed.
 * This should be called before ingestSession to check if user input is required.
 */
export async function analyzeSession(
	filePathOrShareId: string,
): Promise<SessionAnalysis> {
	const filePath = resolveShareFilePath(filePathOrShareId);
	const shareId = filePathOrShareId.includes("/")
		? (filePathOrShareId.split("/").pop()?.replace(".json", "") ??
			filePathOrShareId)
		: filePathOrShareId;

	// Read and parse the private-share file
	const content = await readFile(filePath, "utf-8");
	const privateShare: PrivateShareSession = JSON.parse(content);

	// Get session title
	const sessionEntry = privateShare.data.find((d) => d.type === "session") as
		| { type: "session"; data: SessionData }
		| undefined;
	const title = sessionEntry?.data?.title ?? "Unknown";

	// Extract original path
	const originalPath = extractOriginalPath(privateShare);
	if (!originalPath) {
		throw new Error("Could not determine original project path from session");
	}

	const projectName = getProjectName(originalPath);

	// Check if we can resolve the path
	const pathResolution = await resolveProjectPath(originalPath, projectName);

	return {
		shareId,
		title,
		originalPath,
		projectName,
		pathResolution,
	};
}

/**
 * Validate a user-provided path for remapping.
 */
export async function validateRemapPath(
	path: string,
): Promise<{ valid: boolean; error?: string }> {
	return verifyRepoPath(path);
}

/**
 * Main function to ingest a session
 */
export async function ingestSession(
	filePathOrShareId: string,
	options: IngestOptions = {},
): Promise<IngestResult> {
	const filePath = resolveShareFilePath(filePathOrShareId);

	// Read and parse the private-share file
	const content = await readFile(filePath, "utf-8");
	let privateShare: PrivateShareSession = JSON.parse(content);

	// Handle path remapping if needed
	const originalPath = extractOriginalPath(privateShare);
	let pathRemapped = false;
	let newPath: string | undefined;

	if (options.remapToPath && originalPath) {
		// Validate the target path
		const validation = await verifyRepoPath(options.remapToPath);
		if (!validation.valid) {
			throw new Error(
				`Invalid remap path: ${validation.error ?? "Path is not a valid git repository"}`,
			);
		}

		// Apply path remapping to the entire data structure
		privateShare = remapPaths(
			privateShare,
			originalPath,
			options.remapToPath,
		) as PrivateShareSession;
		pathRemapped = true;
		newPath = options.remapToPath;
	}

	// Extract data by type (after remapping)
	const sessionEntry = privateShare.data.find((d) => d.type === "session") as
		| { type: "session"; data: SessionData }
		| undefined;
	const messageEntries = privateShare.data.filter(
		(d) => d.type === "message",
	) as Array<{ type: "message"; data: MessageData }>;
	const partEntries = privateShare.data.filter(
		(d) => d.type === "part",
	) as Array<{
		type: "part";
		data: PartData;
	}>;
	const diffEntry = privateShare.data.find((d) => d.type === "session_diff") as
		| { type: "session_diff"; data: DiffData[] }
		| undefined;

	if (!sessionEntry) {
		throw new Error("File does not contain session data");
	}

	const session = {
		...sessionEntry.data,
		title: `[IMPORTED] ${sessionEntry.data.title}`,
	};

	// Create project data from session info
	const projectData: ProjectData = {
		id: session.projectID,
		worktree: session.directory,
		vcs: "git",
		time: {
			created: session.time.created,
			updated: session.time.updated,
		},
	};

	// Write all data
	await writeProject(projectData);
	await writeSession(session);

	for (const entry of messageEntries) {
		await writeMessage(entry.data);
	}

	for (const entry of partEntries) {
		await writePart(entry.data);
	}

	await writeSessionDiff(session.id, diffEntry?.data ?? []);

	return {
		success: true,
		sessionId: session.id,
		sessionTitle: session.title,
		messageCount: messageEntries.length,
		partCount: partEntries.length,
		diffCount: diffEntry?.data.length ?? 0,
		pathRemapped,
		originalPath: originalPath ?? undefined,
		newPath,
	};
}

/**
 * List all available sessions in the private shares directory
 */
export async function listSessions(): Promise<ListSessionsResult> {
	let files: string[];
	try {
		files = await readdir(PRIVATE_SHARES_DIR);
	} catch {
		return { sessions: [] };
	}

	const jsonFiles = files.filter((f) => f.endsWith(".json"));
	const sessions: ListSessionsResult["sessions"] = [];

	for (const file of jsonFiles) {
		const shareId = file.replace(".json", "");
		try {
			const content = await readFile(join(PRIVATE_SHARES_DIR, file), "utf-8");
			const privateShare: PrivateShareSession = JSON.parse(content);
			const sessionData = privateShare.data.find((d) => d.type === "session") as
				| { type: "session"; data: SessionData }
				| undefined;
			const title = sessionData?.data?.title ?? "Unknown";
			const created = new Date(privateShare.createdAt).toLocaleString();
			const messageCount = privateShare.data.filter(
				(d) => d.type === "message",
			).length;

			sessions.push({
				shareId,
				title,
				created,
				messageCount,
			});
		} catch {
			sessions.push({
				shareId,
				title: "Unknown",
				created: "Unknown",
				messageCount: 0,
			});
		}
	}

	return { sessions };
}

/**
 * Get the private shares directory path
 */
export function getPrivateSharesDir(): string {
	return PRIVATE_SHARES_DIR;
}
