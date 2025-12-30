import {
	type ArchiveAnalysis,
	analyzeArchive,
	createSessionArchive,
	extractSessionArchive,
	getSessionArchivesDir,
	listSessionArchives,
	type SessionFile,
	validateArchiveRemapPath,
} from "@madisonbullard/opencode-scripts";
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";

// Use the zod instance from the plugin to ensure version compatibility
const z = tool.schema;

export const PrivateSharePlugin: Plugin = async (_ctx) => {
	return {
		tool: {
			"private-share": tool({
				description:
					"Create a private share of the current session. Scans the opencode data directories for files related to this session (messages, parts, diffs, snapshots) and creates a zip archive that can be shared and later ingested on another machine.",
				args: {},
				async execute(_args, ctx) {
					const { sessionID } = ctx;

					try {
						const { archivePath, archiveId, info } =
							await createSessionArchive(sessionID);

						let result = `Private share created successfully!\n`;
						result += `Archive ID: ${archiveId}\n`;
						result += `Saved to: ${archivePath}\n\n`;
						result += `Session: ${info.title}\n`;
						result += `Files included: ${info.files.length}\n`;
						result += `  - Session: ${info.files.filter((f: SessionFile) => f.type === "session").length}\n`;
						result += `  - Messages: ${info.files.filter((f: SessionFile) => f.type === "message").length}\n`;
						result += `  - Parts: ${info.files.filter((f: SessionFile) => f.type === "part").length}\n`;
						result += `  - Diffs: ${info.files.filter((f: SessionFile) => f.type === "session_diff").length}\n`;
						result += `  - Project: ${info.files.filter((f: SessionFile) => f.type === "project").length}\n`;
						result += `  - Snapshots: ${info.files.filter((f: SessionFile) => f.type === "snapshot").length}`;

						return result;
					} catch (error) {
						throw new Error(
							`Failed to create session archive: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				},
			}),
			"ingest-session": tool({
				description:
					"Ingest a previously saved session archive. Extracts the zip archive and places the session files in the appropriate opencode data directories. Use 'list' as the archiveId to see available archives. If the session was created on a different machine, you may need to provide the projectPath parameter to specify where the repository is located on this machine.",
				args: {
					shareId: z
						.string()
						.describe(
							"The archive ID of the session to ingest, or 'list' to show available archives",
						),
					projectPath: z
						.string()
						.optional()
						.describe(
							"Optional: The local path to the project repository. Required if the session was created on a different machine and the repository cannot be auto-detected.",
						),
					searchForRepo: z
						.boolean()
						.optional()
						.describe(
							"Optional: If true, search common directories for the repository by name. Defaults to true if projectPath is not provided.",
						),
				},
				async execute(args, _ctx) {
					const { shareId, projectPath, searchForRepo = true } = args;

					// Handle listing available archives
					if (shareId === "list") {
						const archives = await listSessionArchives();
						if (archives.length === 0) {
							return `No session archives found in ${getSessionArchivesDir()}\nCreate a private share first using the private-share tool.`;
						}

						let output = `Available session archives (${archives.length} total):\n\n`;
						for (const archive of archives) {
							output += `  ${archive.archiveId}\n`;
							output += `    Created: ${archive.created}\n`;
							output += `    Path: ${archive.archivePath}\n\n`;
						}
						output += `\nUse ingest-session with a shareId to restore an archive.`;
						return output;
					}

					// First, analyze the archive to check if path remapping is needed
					let analysis: ArchiveAnalysis;
					try {
						analysis = await analyzeArchive(shareId);
					} catch (error) {
						// If analysis fails, try to list available archives to help the user
						const available = await listSessionArchives();
						let errorMsg = `Failed to analyze archive: ${error instanceof Error ? error.message : String(error)}\n\n`;

						if (available.length > 0) {
							errorMsg += `Available archives:\n`;
							for (const archive of available) {
								errorMsg += `  - ${archive.archiveId}\n`;
							}
						}

						throw new Error(errorMsg);
					}

					// Determine the path to use for ingestion
					let remapToPath: string | undefined;

					if (projectPath) {
						// User provided an explicit path - validate it
						const validation = await validateArchiveRemapPath(projectPath);
						if (!validation.valid) {
							throw new Error(
								`Invalid project path "${projectPath}": ${validation.error}\n\n` +
									`Please provide a valid path to a git repository.`,
							);
						}
						remapToPath = projectPath;
					} else if (!analysis.pathResolution.resolved) {
						// Path doesn't exist and wasn't provided - need user input
						const { pathResolution, originalPath, projectName } = analysis;

						if (
							!searchForRepo ||
							(pathResolution.candidates.length === 0 &&
								pathResolution.requiresUserInput)
						) {
							// No candidates found - ask user to provide path
							let msg = `The session was created at:\n  ${originalPath}\n\n`;
							msg += `This path does not exist on this machine, and the repository "${projectName}" could not be found.\n\n`;
							msg += `Please call this tool again with the projectPath parameter set to the local path where the "${projectName}" repository is located.\n\n`;
							msg += `Example: ingest-session with shareId="${shareId}" and projectPath="/path/to/${projectName}"`;
							return msg;
						}

						if (pathResolution.candidates.length > 1) {
							// Multiple candidates found - ask user to choose
							let msg = `The session was created at:\n  ${originalPath}\n\n`;
							msg += `This path does not exist on this machine. Multiple possible locations for "${projectName}" were found:\n\n`;
							for (const candidate of pathResolution.candidates) {
								msg += `  - ${candidate}\n`;
							}
							msg += `\nPlease call this tool again with the projectPath parameter set to the correct location.\n\n`;
							msg += `Example: ingest-session with shareId="${shareId}" and projectPath="${pathResolution.candidates[0]}"`;
							return msg;
						}

						// Single candidate found - use it automatically
						if (pathResolution.newPath) {
							remapToPath = pathResolution.newPath;
						}
					}
					// If pathResolution.resolved is true, original path exists - no remapping needed

					// Extract the archive
					try {
						const result = await extractSessionArchive(shareId, {
							remapToPath,
						});

						let summary = `Session archive extracted successfully!\n\n`;
						summary += `Session ID: ${result.sessionId}\n`;
						summary += `Title: ${result.sessionTitle}\n`;
						summary += `Files extracted: ${result.fileCount}\n`;

						if (result.pathRemapped) {
							summary += `\nPath remapped:\n`;
							summary += `  From: ${result.originalPath}\n`;
							summary += `  To:   ${result.newPath}\n`;
						}

						summary += `\nThe session "${result.sessionTitle}" should now appear in your opencode session list.\n`;

						return summary;
					} catch (error) {
						// If extraction fails, provide helpful error message
						const available = await listSessionArchives();
						let errorMsg = `Failed to extract archive: ${error instanceof Error ? error.message : String(error)}\n\n`;

						if (available.length > 0) {
							errorMsg += `Available archives:\n`;
							for (const archive of available) {
								errorMsg += `  - ${archive.archiveId}\n`;
							}
						}

						throw new Error(errorMsg);
					}
				},
			}),
		},
	};
};

export default PrivateSharePlugin;
