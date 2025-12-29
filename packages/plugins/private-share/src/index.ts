import { type Plugin, tool } from "@opencode-ai/plugin";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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

interface PrivateShareSnapshot {
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
					"Create a private share of the current session. Captures a snapshot of the session data and saves it locally for later sharing.",
				args: {},
				async execute(_, ctx) {
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

					// Create the snapshot
					const shareId = generateId();
					const snapshot: PrivateShareSnapshot = {
						id: shareId,
						sessionID,
						createdAt: Date.now(),
						data: shareData,
					};

					// Ensure directory exists and write file
					await mkdir(PRIVATE_SHARES_DIR, { recursive: true });
					const filePath = join(PRIVATE_SHARES_DIR, `${shareId}.json`);
					await writeFile(filePath, JSON.stringify(snapshot, null, 2));

					return `Private share created successfully!\nShare ID: ${shareId}\nSaved to: ${filePath}`;
				},
			}),
		},
	};
};

/**
 * Generate a simple unique ID (similar to ulid but simpler)
 */
function generateId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 10);
	return `${timestamp}-${random}`;
}

export default PrivateSharePlugin;
