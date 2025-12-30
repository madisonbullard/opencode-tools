export {
	findRepositoryByName,
	type PathResolutionResult,
	type RepoSearchResult,
	resolveProjectPath,
	verifyRepoPath,
} from "./detect-repo.js";
// Legacy exports for backwards compatibility with JSON-based shares
// These can be removed in a future major version
export {
	analyzeSession,
	getPrivateSharesDir,
	type IngestOptions,
	type IngestResult,
	ingestSession,
	type ListSessionsResult,
	listSessions,
	type SessionAnalysis,
	validateRemapPath,
} from "./ingest-session.js";
export {
	analyzePathRemapNeeds,
	extractOriginalPath,
	getCommonSearchPaths,
	getProjectName,
	isAbsolutePath,
	PATH_FIELDS,
	type PathRemapInfo,
	pathExistsSync,
	remapPaths,
} from "./path-utils.js";
export {
	type ArchiveAnalysis,
	analyzeArchive,
	collectSessionFiles,
	createSessionArchive,
	type ExtractArchiveOptions,
	type ExtractArchiveResult,
	extractSessionArchive,
	getSessionArchivesDir,
	listSessionArchives,
	type SessionArchiveInfo,
	type SessionFile,
	validateArchiveRemapPath,
} from "./session-archive.js";
