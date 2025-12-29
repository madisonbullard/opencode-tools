import { type Plugin, tool } from "@opencode-ai/plugin";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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

interface PrivateShareSnapshot {
	id: string;
	sessionID: string;
	createdAt: number;
	data: ShareData[];
}

const PRIVATE_SHARES_DIR = join(homedir(), ".opencode", "private-shares");

/**
 * List all available snapshots in the private shares directory
 */
async function listAvailableSnapshots(): Promise<string> {
	try {
		const files = await readdir(PRIVATE_SHARES_DIR);
		const jsonFiles = files.filter((f) => f.endsWith(".json"));

		if (jsonFiles.length === 0) {
			return "No snapshots found in " + PRIVATE_SHARES_DIR;
		}

		let result = `Available snapshots (${jsonFiles.length} total):\n\n`;

		for (const file of jsonFiles) {
			const shareId = file.replace(".json", "");
			try {
				const content = await readFile(join(PRIVATE_SHARES_DIR, file), "utf-8");
				const snapshot: PrivateShareSnapshot = JSON.parse(content);
				const sessionData = snapshot.data.find((d) => d.type === "session");
				const title =
					(sessionData?.data as { title?: string })?.title ?? "Unknown";
				const created = new Date(snapshot.createdAt).toLocaleString();
				const messageCount = snapshot.data.filter(
					(d) => d.type === "message",
				).length;

				result += `  ${shareId}\n`;
				result += `    Title: ${title}\n`;
				result += `    Created: ${created}\n`;
				result += `    Messages: ${messageCount}\n\n`;
			} catch {
				result += `  ${shareId} (unable to read details)\n\n`;
			}
		}

		result += `\nUse ingest-snapshot with a shareId to restore a snapshot.`;
		return result;
	} catch {
		return `No snapshots directory found at ${PRIVATE_SHARES_DIR}\nCreate a snapshot first using the private-share tool.`;
	}
}

export const PrivateSharePlugin: Plugin = async ({ client }) => {
	return {
		tool: {
			"private-share": tool({
				description:
					"Create a private share of the current session. Captures a snapshot of the session data and saves it locally for later sharing.",
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
			"ingest-snapshot": tool({
				description:
					"Ingest a previously saved private share snapshot. Creates a new session and injects the conversation history as context. Use 'list' as the shareId to see available snapshots.",
				args: {
					shareId: z
						.string()
						.describe(
							"The share ID of the snapshot to ingest, or 'list' to show available snapshots",
						),
				},
				async execute(args, _ctx) {
					const { shareId } = args;

					// Handle listing available snapshots
					if (shareId === "list") {
						return await listAvailableSnapshots();
					}

					// Read the snapshot file
					const filePath = join(PRIVATE_SHARES_DIR, `${shareId}.json`);
					let snapshotContent: string;
					try {
						snapshotContent = await readFile(filePath, "utf-8");
					} catch {
						// Try to list available snapshots to help the user
						const available = await listAvailableSnapshots();
						throw new Error(
							`Failed to read snapshot file: ${filePath}\n\n${available}`,
						);
					}

					const snapshot: PrivateShareSnapshot = JSON.parse(snapshotContent);

					// Extract data from the snapshot
					const sessionData = snapshot.data.find((d) => d.type === "session");
					const messageData = snapshot.data.filter((d) => d.type === "message");
					const partData = snapshot.data.filter((d) => d.type === "part");
					const diffData = snapshot.data.find((d) => d.type === "session_diff");
					const modelData = snapshot.data.find((d) => d.type === "model");

					if (!sessionData) {
						throw new Error("Snapshot does not contain session data");
					}

					const originalSession = sessionData.data as {
						id: string;
						title: string;
						directory: string;
						time: { created: number; updated: number };
					};

					// Create a new session
					const newSessionResponse = await client.session.create({
						body: {
							title: `[Restored] ${originalSession.title}`,
						},
					});

					if (newSessionResponse.error) {
						throw new Error(
							`Failed to create new session: ${JSON.stringify(newSessionResponse.error)}`,
						);
					}

					const newSession = newSessionResponse.data;
					if (!newSession?.id) {
						throw new Error(
							"Failed to create new session: no session ID returned",
						);
					}

					// Parse messages and parts
					const messages = messageData.map((m) => m.data) as Array<{
						id: string;
						role: "user" | "assistant";
						time: { created: number };
						model?: { providerID: string; modelID: string };
					}>;

					const parts = partData.map((p) => p.data) as Array<{
						id: string;
						messageID: string;
						type: string;
						text?: string;
						tool?: string;
						state?: { input?: unknown; output?: string; status?: string };
					}>;

					// Sort messages by creation time
					messages.sort((a, b) => a.time.created - b.time.created);

					// Build conversation history as context
					// We'll inject the full conversation as a synthetic context message
					let conversationContext = "=== RESTORED CONVERSATION HISTORY ===\n\n";
					conversationContext += `Original Session: ${originalSession.title}\n`;
					conversationContext += `Captured: ${new Date(snapshot.createdAt).toISOString()}\n\n`;

					for (const msg of messages) {
						const role = msg.role === "user" ? "USER" : "ASSISTANT";
						const time = new Date(msg.time.created).toISOString();
						const msgParts = parts.filter((p) => p.messageID === msg.id);

						conversationContext += `--- ${role} [${time}] ---\n`;

						for (const part of msgParts) {
							if (part.type === "text" && part.text) {
								conversationContext += `${part.text}\n`;
							} else if (part.type === "tool" && part.tool) {
								const status = part.state?.status ?? "unknown";
								conversationContext += `[Tool: ${part.tool} - ${status}]\n`;
								if (part.state?.output) {
									const outputPreview = part.state.output.slice(0, 500);
									conversationContext += `Output: ${outputPreview}${part.state.output.length > 500 ? "..." : ""}\n`;
								}
							}
						}
						conversationContext += "\n";
					}

					conversationContext += "=== END OF RESTORED HISTORY ===\n\n";
					conversationContext +=
						"The above is the conversation history from a previous session.\n\n";
					conversationContext += `IMPORTANT: This session may have been conducted on a different filesystem, so file paths may not be accurate. The current user may have the same codebases in a different location, so you can ask them for the correct path to the repo root, and go from there.\n\n`;
					conversationContext +=
						"You can reference this context to continue the conversation or answer questions about what was discussed.";

					// Get the first user message's model info for injection, or use a default
					const firstUserMsg = messages.find((m) => m.role === "user");
					const modelInfo = firstUserMsg?.model ?? {
						providerID: "anthropic",
						modelID: "claude-sonnet-4-20250514",
					};

					// Inject the conversation history as context using noReply
					const injectResponse = await client.session.prompt({
						path: { id: newSession.id },
						body: {
							noReply: true,
							model: modelInfo,
							parts: [
								{
									type: "text",
									text: conversationContext,
									synthetic: true, // Mark as synthetic/injected content
								},
							],
						},
					});

					if (injectResponse.error) {
						throw new Error(
							`Failed to inject conversation context: ${JSON.stringify(injectResponse.error)}`,
						);
					}

					let summary = `Snapshot ingested successfully!\n\n`;
					summary += `Original Session ID: ${snapshot.sessionID}\n`;
					summary += `New Session ID: ${newSession.id}\n`;
					summary += `Original Title: ${originalSession.title}\n`;
					summary += `Snapshot Created: ${new Date(snapshot.createdAt).toISOString()}\n\n`;

					summary += `\n=== Next Steps ===\n`;
					summary += `The conversation history has been injected into the new session as context.\n`;
					summary += `You can now continue the conversation or ask questions about what was discussed.\n`;
					summary += `Switch to session ${newSession.id} to continue.`;

					return summary;
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
