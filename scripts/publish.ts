#!/usr/bin/env bun

/**
 * Interactive publish script for opencode-tools packages.
 * Automatically discovers publishable packages by scanning for package.json
 * files with "publishConfig": { "access": "public" }.
 *
 * Usage:
 *   bun scripts/publish.ts                    # Interactive version bump (defaults to patch)
 *   bun scripts/publish.ts --version 0.1.0   # Explicit version (no bump)
 *   bun scripts/publish.ts --patch / -p      # Patch bump
 *   bun scripts/publish.ts --minor / -m      # Minor bump
 *   bun scripts/publish.ts --major / -M      # Major bump
 *   bun scripts/publish.ts --dry-run         # Show what would be published without making changes
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { Glob } from "bun";

const ROOT_DIR = join(import.meta.dirname ?? ".", "..");

interface PackageJson {
	name: string;
	version: string;
	publishConfig?: { access?: string };
	dependencies?: Record<string, string>;
	[key: string]: unknown;
}

interface Package {
	name: string;
	path: string;
	dependencies: string[];
}

/**
 * Discover all publishable packages by scanning for package.json files
 * with publishConfig.access = "public"
 */
async function discoverPackages(): Promise<Package[]> {
	const glob = new Glob("**/package.json");
	const packages: Package[] = [];

	for await (const file of glob.scan({
		cwd: ROOT_DIR,
		absolute: true,
		onlyFiles: true,
	})) {
		// Skip node_modules and root package.json
		if (file.includes("node_modules")) continue;
		if (file === join(ROOT_DIR, "package.json")) continue;

		try {
			const content = await readFile(file, "utf-8");
			const pkg: PackageJson = JSON.parse(content);

			if (pkg.publishConfig?.access === "public" && pkg.name) {
				const pkgDir = dirname(file);
				packages.push({
					name: pkg.name,
					path: relative(ROOT_DIR, pkgDir),
					dependencies: Object.keys(pkg.dependencies ?? {}),
				});
			}
		} catch {
			// Skip files that can't be parsed
		}
	}

	return packages;
}

/**
 * Sort packages by dependencies so that dependencies are published first.
 * Uses topological sort to ensure correct publish order.
 */
function sortByDependencies(packages: Package[]): Package[] {
	const packageNames = new Set(packages.map((p) => p.name));
	const sorted: Package[] = [];
	const visited = new Set<string>();
	const visiting = new Set<string>();

	function visit(pkg: Package) {
		if (visited.has(pkg.name)) return;
		if (visiting.has(pkg.name)) {
			throw new Error(`Circular dependency detected: ${pkg.name}`);
		}

		visiting.add(pkg.name);

		// Visit dependencies first (only those in our package list)
		for (const dep of pkg.dependencies) {
			if (packageNames.has(dep)) {
				const depPkg = packages.find((p) => p.name === dep);
				if (depPkg) visit(depPkg);
			}
		}

		visiting.delete(pkg.name);
		visited.add(pkg.name);
		sorted.push(pkg);
	}

	for (const pkg of packages) {
		visit(pkg);
	}

	return sorted;
}

type BumpType = "major" | "minor" | "patch" | "none";

function bumpVersion(current: string, type: BumpType): string {
	if (type === "none") return current;

	const parts = current.split(".").map(Number);
	const major = parts[0] ?? 0;
	const minor = parts[1] ?? 0;
	const patch = parts[2] ?? 0;

	switch (type) {
		case "major":
			return `${major + 1}.0.0`;
		case "minor":
			return `${major}.${minor + 1}.0`;
		case "patch":
			return `${major}.${minor}.${patch + 1}`;
	}
}

async function readPackageJson(
	packagePath: string,
): Promise<{ version: string; [key: string]: unknown }> {
	const fullPath = join(ROOT_DIR, packagePath, "package.json");
	const content = await readFile(fullPath, "utf-8");
	return JSON.parse(content);
}

async function writePackageJson(
	packagePath: string,
	data: Record<string, unknown>,
): Promise<void> {
	const fullPath = join(ROOT_DIR, packagePath, "package.json");
	await writeFile(fullPath, JSON.stringify(data, null, "\t") + "\n");
}

async function prompt(message: string): Promise<string> {
	process.stdout.write(message);
	for await (const line of console) {
		return line;
	}
	return "";
}

async function selectBumpType(): Promise<BumpType> {
	console.log("\nSelect version bump type:");
	console.log("  1) patch (default)");
	console.log("  2) minor");
	console.log("  3) major");
	console.log("  4) none (keep current version)\n");

	const answer = await prompt("Enter choice [1-4]: ");

	switch (answer.trim()) {
		case "":
		case "1":
			return "patch";
		case "2":
			return "minor";
		case "3":
			return "major";
		case "4":
			return "none";
		default:
			console.log("Invalid choice, defaulting to patch");
			return "patch";
	}
}

function parseArgs(): { version?: string; bump?: BumpType; dryRun?: boolean } {
	const args = process.argv.slice(2);
	const result: { version?: string; bump?: BumpType; dryRun?: boolean } = {};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--version" && args[i + 1]) {
			result.version = args[++i];
		} else if (arg === "--patch" || arg === "-p") {
			result.bump = "patch";
		} else if (arg === "--minor" || arg === "-m") {
			result.bump = "minor";
		} else if (arg === "--major" || arg === "-M") {
			result.bump = "major";
		} else if (arg === "--dry-run" || arg === "-d") {
			result.dryRun = true;
		}
	}

	return result;
}

async function run() {
	const args = parseArgs();
	const isDryRun = args.dryRun ?? false;

	if (isDryRun) {
		console.log("[DRY RUN] No changes will be made\n");
	}

	// Discover and sort packages
	console.log("Discovering publishable packages...");
	const discoveredPackages = await discoverPackages();
	const packages = sortByDependencies(discoveredPackages);

	if (packages.length === 0) {
		console.error("No publishable packages found");
		console.error(
			'Packages must have "publishConfig": { "access": "public" } to be published',
		);
		process.exit(1);
	}

	console.log(`Found ${packages.length} publishable package(s):`);
	for (const pkg of packages) {
		console.log(`  - ${pkg.name} (${pkg.path})`);
	}

	// Get current version from first package
	const firstPackage = packages[0];
	if (!firstPackage) {
		console.error("No packages found");
		process.exit(1);
	}

	const currentPkg = await readPackageJson(firstPackage.path);
	const currentVersion = currentPkg.version;
	console.log(`\nCurrent version: ${currentVersion}`);

	// Determine new version
	let newVersion: string;

	if (args.version) {
		// Explicit version provided
		newVersion = args.version;
		console.log(`Using explicit version: ${newVersion}`);
	} else if (args.bump) {
		// Bump type provided via flag
		newVersion = bumpVersion(currentVersion, args.bump);
		console.log(`Bumping ${args.bump}: ${currentVersion} -> ${newVersion}`);
	} else if (isDryRun) {
		// In dry run without explicit bump, default to patch
		newVersion = bumpVersion(currentVersion, "patch");
		console.log(`Would bump patch: ${currentVersion} -> ${newVersion}`);
	} else {
		// Interactive mode
		const bumpType = await selectBumpType();
		newVersion = bumpVersion(currentVersion, bumpType);
		if (bumpType === "none") {
			console.log(`Keeping version: ${newVersion}`);
		} else {
			console.log(`Bumping ${bumpType}: ${currentVersion} -> ${newVersion}`);
		}
	}

	// Dry run summary
	if (isDryRun) {
		console.log(`\n${"=".repeat(50)}`);
		console.log("[DRY RUN] Summary of what would happen:");
		console.log("=".repeat(50));
		console.log(`\nVersion: ${currentVersion} -> ${newVersion}\n`);
		console.log("Packages to publish (in order):");
		for (const pkg of packages) {
			console.log(`  1. ${pkg.name}@${newVersion}`);
			console.log(`     - Update ${pkg.path}/package.json version`);
			console.log(`     - Run: bun run build`);
			console.log(`     - Run: npm publish`);
		}
		console.log(`\n${"=".repeat(50)}`);
		console.log("[DRY RUN] No changes were made");
		console.log("=".repeat(50));
		return;
	}

	// Confirm
	const confirm = await prompt(
		`\nPublish all packages at version ${newVersion}? [y/N]: `,
	);
	if (confirm.toLowerCase() !== "y") {
		console.log("Aborted.");
		process.exit(0);
	}

	// Update versions and publish each package
	for (const pkg of packages) {
		console.log(`\n${"=".repeat(50)}`);
		console.log(`Publishing ${pkg.name}...`);
		console.log("=".repeat(50));

		// Update version in package.json
		const pkgJson = await readPackageJson(pkg.path);
		pkgJson.version = newVersion;
		await writePackageJson(pkg.path, pkgJson);
		console.log(`Updated ${pkg.path}/package.json to version ${newVersion}`);

		// Build
		console.log("Building...");
		const buildResult = Bun.spawnSync(["bun", "run", "build"], {
			cwd: join(ROOT_DIR, pkg.path),
			stdio: ["inherit", "inherit", "inherit"],
		});
		if (buildResult.exitCode !== 0) {
			console.error(`Build failed for ${pkg.name}`);
			process.exit(1);
		}

		// Publish
		console.log("Publishing to npm...");
		const publishResult = Bun.spawnSync(["npm", "publish"], {
			cwd: join(ROOT_DIR, pkg.path),
			stdio: ["inherit", "inherit", "inherit"],
		});
		if (publishResult.exitCode !== 0) {
			console.error(`Publish failed for ${pkg.name}`);
			process.exit(1);
		}

		console.log(`Successfully published ${pkg.name}@${newVersion}`);
	}

	console.log(`\n${"=".repeat(50)}`);
	console.log("All packages published successfully!");
	console.log("=".repeat(50));
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
