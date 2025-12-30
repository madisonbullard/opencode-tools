# opencode-tools

A collection of tools and plugins to complement [OpenCode](https://opencode.ai).

## Packages

### `@madisonbullard/opencode-private-share`

An OpenCode plugin that enables private session sharing and ingestion. This allows you to:

- **Create private shares**: Save your OpenCode sessions locally for later reference or sharing
- **Ingest sessions**: Restore previously saved sessions, even on different machines with automatic path remapping

#### Installation

```bash
npm install @madisonbullard/opencode-private-share
```

#### Configuration

Add the plugin to your OpenCode configuration:

```json
{
  "plugins": {
    "private-share": "@madisonbullard/opencode-private-share"
  }
}
```

#### Usage

The plugin provides two tools:

##### `private-share`

Creates a private share of your current session. The session data is saved locally to `~/.opencode/private-shares/`.

##### `ingest-session`

Restores a previously saved session. Use `list` as the `shareId` to see available sessions.

```
ingest-session shareId="list"                    # List available sessions
ingest-session shareId="2025-01-15-my-session"   # Ingest a specific session
```

If the session was created on a different machine, the plugin will attempt to auto-detect the repository location. If it cannot be found automatically, you can specify the path:

```
ingest-session shareId="2025-01-15-my-session" projectPath="/path/to/repo"
```

---

### `@madisonbullard/opencode-scripts`

Utility scripts used by the private-share plugin and potentially other tools. Provides:

- **Session ingestion**: Write session data directly into OpenCode's storage structure
- **Repository detection**: Find git repositories by name on the local machine
- **Path utilities**: Handle path remapping between different machines

#### Installation

```bash
npm install @madisonbullard/opencode-scripts
```

#### Exports

```typescript
// Main exports
import {
  ingestSession,
  analyzeSession,
  listSessions,
  validateRemapPath,
  getPrivateSharesDir,
} from "@madisonbullard/opencode-scripts";

// Repository detection
import {
  findRepositoryByName,
  resolveProjectPath,
  verifyRepoPath,
} from "@madisonbullard/opencode-scripts/detect-repo";

// Path utilities
import {
  remapPaths,
  extractOriginalPath,
  getProjectName,
} from "@madisonbullard/opencode-scripts/path-utils";
```

## Development

This is a monorepo managed with [Bun](https://bun.sh) workspaces and [Turborepo](https://turbo.build/repo).

### Prerequisites

- [Bun](https://bun.sh) v1.3.5 or later

### Setup

```bash
# Install dependencies
bun install

# Run type checking
bun typecheck

# Run linting
bun check
```

### Scripts

| Command         | Description                          |
| --------------- | ------------------------------------ |
| `bun check`     | Run Biome linter                     |
| `bun fix`       | Auto-fix linting issues              |
| `bun typecheck` | Run TypeScript type checking         |
| `bun publish`   | Publish packages (maintainers only)  |

### Project Structure

```
opencode-tools/
├── packages/
│   ├── plugins/
│   │   └── private-share/    # OpenCode plugin for private session sharing
│   └── scripts/              # Shared utility scripts
├── scripts/
│   └── publish.ts            # Publishing automation
├── biome.json                # Linter configuration
├── turbo.json                # Turborepo configuration
└── package.json              # Root package configuration
```

## License

MIT - see [LICENSE](LICENSE) for details.
