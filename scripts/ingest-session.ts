#!/usr/bin/env bun
/**
 * Script to ingest a session from a private-share JSON file and write the data
 * directly into the opencode storage folder structure.
 *
 * Usage:
 *   bun run ingest-session.ts <path-to-file.json>
 *   bun run ingest-session.ts --list
 *   bun run ingest-session.ts <share-id>
 *
 * This creates native opencode session data from a private-share file,
 * allowing the session to appear in the session list and be fully navigable.
 */

import { mkdir, readdir, readFile, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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
async function writeProject(projectData: ProjectData): Promise<void> {
	const projectDir = join(STORAGE_DIR, "project");
	await ensureDir(projectDir);

	const projectFile = join(projectDir, `${projectData.id}.json`);
	if (await fileExists(projectFile)) {
		console.log(`  Project ${projectData.id} already exists, skipping`);
		return;
	}

	await writeJson(projectFile, projectData);
	console.log(`  Created project: ${projectFile}`);
}

/**
 * Write session data to the appropriate location
 */
async function writeSession(session: SessionData): Promise<void> {
	const sessionDir = join(STORAGE_DIR, "session", session.projectID);
	await ensureDir(sessionDir);

	const sessionFile = join(sessionDir, `${session.id}.json`);
	await writeJson(sessionFile, session);
	console.log(`  Created session: ${sessionFile}`);
}

/**
 * Write message data to the appropriate location
 */
async function writeMessage(message: MessageData): Promise<void> {
	const messageDir = join(STORAGE_DIR, "message", message.sessionID);
	await ensureDir(messageDir);

	const messageFile = join(messageDir, `${message.id}.json`);
	await writeJson(messageFile, message);
	console.log(`  Created message: ${messageFile}`);
}

/**
 * Write part data to the appropriate location
 */
async function writePart(part: PartData): Promise<void> {
	const partDir = join(STORAGE_DIR, "part", part.messageID);
	await ensureDir(partDir);

	const partFile = join(partDir, `${part.id}.json`);
	await writeJson(partFile, part);
	console.log(`  Created part: ${partFile}`);
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
	console.log(`  Created session_diff: ${diffFile}`);
}

/**
 * Main function to ingest a session
 */
async function ingestSession(filePath: string): Promise<void> {
	console.log(`\nIngesting session from: ${filePath}\n`);

	// Read and parse the private-share file
	const content = await readFile(filePath, "utf-8");
	const privateShare: PrivateShareSession = JSON.parse(content);

	console.log(`Share ID: ${privateShare.id}`);
	console.log(`Session ID: ${privateShare.sessionID}`);
	console.log(`Created: ${new Date(privateShare.createdAt).toISOString()}\n`);

	// Extract data by type
	const sessionEntry = privateShare.data.find((d) => d.type === "session") as
		| { type: "session"; data: SessionData }
		| undefined;
	const messageEntries = privateShare.data.filter(
		(d) => d.type === "message",
	) as Array<{ type: "message"; data: MessageData }>;
	const partEntries = privateShare.data.filter(
		(d) => d.type === "part",
	) as Array<{ type: "part"; data: PartData }>;
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

	// Summary of what we'll write
	console.log(`Data to ingest:`);
	console.log(`  - 1 session (${session.title})`);
	console.log(`  - ${messageEntries.length} messages`);
	console.log(`  - ${partEntries.length} parts`);
	console.log(
		`  - ${diffEntry?.data.length ?? 0} diffs${diffEntry?.data.length ? "" : " (empty)"}\n`,
	);

	// Write all data
	console.log("Writing project data...");
	await writeProject(projectData);

	console.log("\nWriting session data...");
	await writeSession(session);

	console.log("\nWriting message data...");
	for (const entry of messageEntries) {
		await writeMessage(entry.data);
	}

	console.log("\nWriting part data...");
	for (const entry of partEntries) {
		await writePart(entry.data);
	}

	console.log("\nWriting session diffs...");
	await writeSessionDiff(session.id, diffEntry?.data ?? []);

	console.log(`\n✓ Session ingested successfully!`);
	console.log(
		`\nThe session "${session.title}" should now appear in your opencode session list.`,
	);
	console.log(`Session ID: ${session.id}`);
}

/**
 * List all available sessions in the private shares directory
 */
async function listSessions(): Promise<void> {
	console.log(`\nAvailable sessions in ${PRIVATE_SHARES_DIR}:\n`);

	let files: string[];
	try {
		files = await readdir(PRIVATE_SHARES_DIR);
	} catch {
		console.error(`No private shares directory found at ${PRIVATE_SHARES_DIR}`);
		console.error("Create a private share first using the private-share tool.");
		process.exit(1);
	}

	const jsonFiles = files.filter((f) => f.endsWith(".json"));
	if (jsonFiles.length === 0) {
		console.log("No sessions found.");
		return;
	}

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

			console.log(`  ${shareId}`);
			console.log(`    Title: ${title}`);
			console.log(`    Created: ${created}`);
			console.log(`    Messages: ${messageCount}\n`);
		} catch {
			console.log(`  ${shareId} (unable to read details)\n`);
		}
	}

	console.log("Usage: bun run ingest-session.ts <share-id>");
}

/**
 * Resolve a share ID or path to a full file path
 */
function resolveFilePath(arg: string): string {
	// If it looks like a path (contains / or ends with .json), use it directly
	if (arg.includes("/") || arg.endsWith(".json")) {
		return arg;
	}
	// Otherwise, treat it as a share ID
	return join(PRIVATE_SHARES_DIR, `${arg}.json`);
}

function printUsage(): void {
	console.log("Usage: bun run ingest-session.ts <path-or-share-id>");
	console.log("       bun run ingest-session.ts --list");
	console.log("\nOptions:");
	console.log("  --list, -l    List available sessions");
	console.log("  --help, -h    Show this help message");
	console.log("\nExamples:");
	console.log("  bun run ingest-session.ts mjroi47q-2nflpsvb");
	console.log(
		"  bun run ingest-session.ts ~/.opencode/private-shares/mjroi47q-2nflpsvb.json",
	);
}

// CLI entry point
const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
	printUsage();
	process.exit(args.length === 0 ? 1 : 0);
}

if (args.includes("--list") || args.includes("-l")) {
	listSessions().catch((error: Error) => {
		console.error("\nError listing sessions:", error.message);
		process.exit(1);
	});
} else {
	const arg = args[0];
	if (typeof arg !== "string") {
		console.error("\nError ingesting session: No argument passed.");
		process.exit(1);
	}
	const filePath = resolveFilePath(arg);
	ingestSession(filePath).catch((error: Error) => {
		console.error("\nError ingesting session:", error.message);
		process.exit(1);
	});
}
