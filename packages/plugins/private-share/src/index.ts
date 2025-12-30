import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	getPrivateSharesDir,
	ingestSession as ingestSessionScript,
	listSessions as listSessionsScript,
} from "@madisonbullard/scripts";
import { type Plugin, tool } from "@opencode-ai/plugin";

// Use the zod instance from the plugin to ensure version compatibility
const z = tool.schema;

/**
 * Data structure that mirrors what would be sent to a remote API.
 * This matches the format used by opencode's ShareNext.sync function.
 */
type ShareData =
	| { type: "session"; data: unknown }
	| { type: "message"; data: unknown }
	| { type: "part"; data: unknown }
	| { type: "session_diff"; data: unknown[] }
	| { type: "model"; data: ModelInfo[] };

interface ModelInfo {
	id: string;
	providerID: string;
	name: string;
}

interface PrivateShareSession {
	id: string;
	sessionID: string;
	createdAt: number;
	data: ShareData[];
}

const PRIVATE_SHARES_DIR = join(homedir(), ".opencode", "private-shares");

export const PrivateSharePlugin: Plugin = async ({ client }) => {
	return {
		tool: {
			"private-share": tool({
				description:
					"Create a private share of the current session. Captures the session data and saves it locally for later sharing.",
				args: {},
				async execute(_args, ctx) {
					const { sessionID } = ctx;

					// Fetch session info (v1 SDK uses path.id)
					const sessionResponse = await client.session.get({
						path: { id: sessionID },
					});
					if (sessionResponse.error) {
						throw new Error(
							`Failed to fetch session: ${JSON.stringify(sessionResponse.error)}`,
						);
					}
					const session = sessionResponse.data;

					// Fetch messages with parts
					const messagesResponse = await client.session.messages({
						path: { id: sessionID },
					});
					if (messagesResponse.error) {
						throw new Error(
							`Failed to fetch messages: ${JSON.stringify(messagesResponse.error)}`,
						);
					}
					const messagesWithParts = messagesResponse.data ?? [];

					// Fetch session diffs
					const diffResponse = await client.session.diff({
						path: { id: sessionID },
					});
					const diffs = diffResponse.data ?? [];

					// Extract unique models from user messages
					const modelSet = new Map<string, ModelInfo>();
					for (const { info } of messagesWithParts) {
						if (info.role === "user") {
							const userMsg = info as {
								model: { providerID: string; modelID: string };
							};
							const key = `${userMsg.model.providerID}:${userMsg.model.modelID}`;
							if (!modelSet.has(key)) {
								modelSet.set(key, {
									id: userMsg.model.modelID,
									providerID: userMsg.model.providerID,
									name: userMsg.model.modelID, // We don't have the display name, use modelID
								});
							}
						}
					}

					// Build the share data array in the same format as ShareNext
					const shareData: ShareData[] = [];

					// Add session info
					shareData.push({ type: "session", data: session });

					// Add all messages
					for (const { info } of messagesWithParts) {
						shareData.push({ type: "message", data: info });
					}

					// Add all parts
					for (const { parts } of messagesWithParts) {
						for (const part of parts) {
							shareData.push({ type: "part", data: part });
						}
					}

					// Add session diffs
					shareData.push({ type: "session_diff", data: diffs });

					// Add models
					shareData.push({
						type: "model",
						data: Array.from(modelSet.values()),
					});

					// Create the private share
					const sessionDate = new Date(session.time.created);
					const dateStr = sessionDate.toISOString().split("T")[0]; // YYYY-MM-DD
					const kebabTitle = toKebabCase(session.title || "untitled");
					const shareId = `${dateStr}-${kebabTitle}`;

					const privateShare: PrivateShareSession = {
						id: shareId,
						sessionID,
						createdAt: Date.now(),
						data: shareData,
					};

					// Ensure directory exists and write file
					await mkdir(PRIVATE_SHARES_DIR, { recursive: true });
					const filePath = join(PRIVATE_SHARES_DIR, `${shareId}.json`);
					await writeFile(filePath, JSON.stringify(privateShare, null, 2));

					return `Private share created successfully!\nShare ID: ${shareId}\nSaved to: ${filePath}`;
				},
			}),
			"ingest-session": tool({
				description:
					"Ingest a previously saved private share session. Creates a new session and injects the conversation history as context. Use 'list' as the shareId to see available sessions.",
				args: {
					shareId: z
						.string()
						.describe(
							"The share ID of the session to ingest, or 'list' to show available sessions",
						),
				},
				async execute(args, _ctx) {
					const { shareId } = args;

					// Handle listing available sessions
					if (shareId === "list") {
						const result = await listSessionsScript();
						if (result.sessions.length === 0) {
							return `No sessions found in ${getPrivateSharesDir()}\nCreate a private share first using the private-share tool.`;
						}

						let output = `Available sessions (${result.sessions.length} total):\n\n`;
						for (const session of result.sessions) {
							output += `  ${session.shareId}\n`;
							output += `    Title: ${session.title}\n`;
							output += `    Created: ${session.created}\n`;
							output += `    Messages: ${session.messageCount}\n\n`;
						}
						output += `\nUse ingest-session with a shareId to restore a session.`;
						return output;
					}

					// Ingest the session using the script
					try {
						const result = await ingestSessionScript(shareId);

						let summary = `Session ingested successfully!\n\n`;
						summary += `Session ID: ${result.sessionId}\n`;
						summary += `Title: ${result.sessionTitle}\n`;
						summary += `Messages: ${result.messageCount}\n`;
						summary += `Parts: ${result.partCount}\n`;
						summary += `Diffs: ${result.diffCount}\n\n`;
						summary += `The session "${result.sessionTitle}" should now appear in your opencode session list.\n`;

						return summary;
					} catch (error) {
						// If ingestion fails, try to list available sessions to help the user
						const available = await listSessionsScript();
						let errorMsg = `Failed to ingest session: ${error instanceof Error ? error.message : String(error)}\n\n`;

						if (available.sessions.length > 0) {
							errorMsg += `Available sessions:\n`;
							for (const session of available.sessions) {
								errorMsg += `  - ${session.shareId}: ${session.title}\n`;
							}
						}

						throw new Error(errorMsg);
					}
				},
			}),
		},
	};
};

/**
 * Convert a string to kebab-case
 */
function toKebabCase(str: string): string {
	return str
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-") // Replace non-alphanumeric chars with hyphens
		.replace(/^-+|-+$/g, "") // Remove leading/trailing hyphens
		.replace(/-+/g, "-"); // Collapse multiple hyphens
}

export default PrivateSharePlugin;
