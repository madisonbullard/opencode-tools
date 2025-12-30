#!/usr/bin/env bun

/**
 * Interactive publish script for @madisonbullard packages.
 *
 * Usage:
 *   bun scripts/publish.ts                    # Interactive version bump (defaults to patch)
 *   bun scripts/publish.ts --version 0.1.0   # Explicit version (no bump)
 *   bun scripts/publish.ts --patch / -p      # Patch bump
 *   bun scripts/publish.ts --minor / -m      # Minor bump
 *   bun scripts/publish.ts --major / -M      # Major bump
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT_DIR = join(import.meta.dirname ?? ".", "..");

// Packages in publish order (dependencies first)
const PACKAGES = [
	{ name: "@madisonbullard/scripts", path: "packages/scripts" },
	{
		name: "@madisonbullard/private-share",
		path: "packages/plugins/private-share",
	},
];

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

function parseArgs(): { version?: string; bump?: BumpType } {
	const args = process.argv.slice(2);
	const result: { version?: string; bump?: BumpType } = {};

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
		}
	}

	return result;
}

async function run() {
	const args = parseArgs();

	// Get current version from first package
	const firstPackage = PACKAGES[0];
	if (!firstPackage) {
		console.error("No packages configured");
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

	// Confirm
	const confirm = await prompt(
		`\nPublish all packages at version ${newVersion}? [y/N]: `,
	);
	if (confirm.toLowerCase() !== "y") {
		console.log("Aborted.");
		process.exit(0);
	}

	// Update versions and publish each package
	for (const pkg of PACKAGES) {
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
