export {
	findRepositoryByName,
	type PathResolutionResult,
	type RepoSearchResult,
	resolveProjectPath,
	verifyRepoPath,
} from "./detect-repo.js";
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
