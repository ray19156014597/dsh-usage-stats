#!/usr/bin/env node

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const knownFlags = new Set(["--check", "--dry-run", "--no-enable", "--help"]);
const args = new Set(process.argv.slice(2));
for (const arg of args) {
	if (!knownFlags.has(arg)) {
		console.error(`Unknown option: ${arg}`);
		process.exit(2);
	}
}

if (args.has("--help")) {
	console.log(`dsh-usage-stats installer

Usage:
  npx --yes github:ray19156014597/dsh-usage-stats [options]

Options:
  --check      Verify the installed package and its profile wiring without changing them
  --dry-run    Print the resolved paths and planned changes
  --no-enable  Install files without editing the profile manifest or cordis.patch.yml
  --help       Show this help

Set DSH_HOME to override the default ~/.dsh location.

Two profile layouts are supported:
  * dsh >= 0.1.7 — the profile is a pnpm project: the plugin is installed into
    profiles/web/node_modules and registered as a bundle in profiles/web/package.json
    (dsh.profile.bundles). Its own cordis.patch.yml mounts it; the user patch stays clean.
  * dsh < 0.1.7 — the package is copied to profiles/node_modules and an insert entry is
    appended to profiles/web/cordis.patch.yml.`);
	process.exit(0);
}

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePackage = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const profileDir = join(dshHome, "profiles", "web");
const manifestPath = join(profileDir, "package.json");
const patchPath = join(profileDir, "cordis.patch.yml");
const legacyTarget = join(dshHome, "profiles", "node_modules", "dsh-usage-stats");
const bundleTarget = join(profileDir, "node_modules", "dsh-usage-stats");
const fileSpec = `file:${sourceRoot.replace(/\\/g, "/")}`;
const pluginLine = /^\s+name:\s*dsh-usage-stats\s*$/gm;
const patchBlock = `# dsh-usage-stats: token usage heatmap + DeepSeek balance
- insert:
    - id: usage-stats
      name: dsh-usage-stats
`;
const emptySequenceRoot = /^\[\](?:[ \t]+#.*)?$/;
/** The exact insert block this installer wrote before dsh 0.1.7 (plus its comment). */
const legacyInsertBlock = /(?:^#[^\n]*\n)*^- insert:\n[ \t]+- id: usage-stats\n[ \t]+name: dsh-usage-stats\n(?:[ \t]*\n)*/gm;

function meaningfulPatchLines(text) {
	return String(text).split(/\r?\n/).map((line, index) => ({
		index,
		indent: line.match(/^[ \t]*/)?.[0].length ?? 0,
		content: line.trim()
	})).filter(({ content }) => content !== "" && !content.startsWith("#") && content !== "---" && content !== "...");
}

/** Remove a YAML document whose only value is the empty root sequence `[]`. */
function withoutEmptySequenceRoot(text) {
	const meaningful = meaningfulPatchLines(text);
	if (meaningful.length === 0) return text;
	const rootIndent = Math.min(...meaningful.map(({ indent }) => indent));
	const emptyRoot = meaningful.find(({ indent, content }) => indent === rootIndent && emptySequenceRoot.test(content));
	if (emptyRoot === void 0) return text;
	const lines = String(text).split(/\r?\n/);
	const inlineComment = lines[emptyRoot.index].match(/^([ \t]*)\[\][ \t]+(#.*)$/);
	if (inlineComment === null) lines.splice(emptyRoot.index, 1);
	else lines[emptyRoot.index] = `${inlineComment[1]}${inlineComment[2]}`;
	return lines.filter((line) => line.trim() !== "...").join("\n").trimEnd();
}

/** Detect the exact invalid shape produced by older installers: `[]` plus list entries. */
function assertNoEmptyRootConflict(text) {
	const meaningful = meaningfulPatchLines(text);
	if (meaningful.length < 2) return;
	const rootIndent = Math.min(...meaningful.map(({ indent }) => indent));
	const roots = meaningful.filter(({ indent }) => indent === rootIndent);
	if (roots.some(({ content }) => emptySequenceRoot.test(content)) && roots.length > 1) {
		throw new Error(`invalid YAML in ${patchPath}: empty root sequence [] cannot be combined with patch entries; rerun the installer to repair it`);
	}
}

/** Preserve existing YAML/comments while adding exactly one plugin patch entry. */
function enablePluginInPatch(text) {
	const base = withoutEmptySequenceRoot(text);
	if ([...base.matchAll(pluginLine)].length > 0) return base;
	return base.trim() === "" ? patchBlock : `${base.trimEnd()}\n\n${patchBlock}`;
}

/**
 * dsh 0.1.7+ mounts the plugin through its own bundle patch. A leftover insert in
 * the user patch would mount the same entry id twice, so drop exactly the block
 * this installer used to write.
 */
function stripLegacyInsert(text) {
	if (!pluginLine.test(text)) return text;
	pluginLine.lastIndex = 0;
	const stripped = text.replace(legacyInsertBlock, "");
	if ([...stripped.matchAll(pluginLine)].length > 0) {
		console.warn(`Warning: ${patchPath} still lists dsh-usage-stats in a shape this installer does not rewrite; remove that insert manually (the bundle patch mounts it already).`);
		return text;
	}
	return stripped.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

async function readOptional(path) {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

/** dsh 0.1.7+ profile manifests carry an ordered dsh.profile.bundles list. */
async function readManifest() {
	const raw = await readOptional(manifestPath);
	if (raw === null) return null;
	let manifest;
	try {
		manifest = JSON.parse(raw);
	} catch (error) {
		throw new Error(`${manifestPath} is not valid JSON: ${error.message}`);
	}
	if (!Array.isArray(manifest?.dsh?.profile?.bundles)) return null;
	return manifest;
}

function enablePluginInManifest(manifest) {
	manifest.dependencies = { ...(manifest.dependencies ?? {}), [sourcePackage.name]: fileSpec };
	const bundles = manifest.dsh.profile.bundles;
	if (!bundles.includes(sourcePackage.name)) bundles.push(sourcePackage.name);
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function verify(modern) {
	const target = modern ? bundleTarget : legacyTarget;
	const installedRaw = await readOptional(join(target, "package.json"));
	if (installedRaw === null) throw new Error(`package is not installed at ${target}`);
	const installed = JSON.parse(installedRaw);
	if (installed.name !== sourcePackage.name || installed.version !== sourcePackage.version) {
		throw new Error(`installed package is ${installed.name ?? "unknown"}@${installed.version ?? "unknown"}; expected ${sourcePackage.name}@${sourcePackage.version}`);
	}
	if (modern) {
		const manifest = await readManifest();
		if (manifest === null) throw new Error(`${manifestPath} does not declare dsh.profile.bundles`);
		if (enable) {
			const bundled = manifest.dsh.profile.bundles.filter((name) => name === sourcePackage.name).length;
			if (bundled !== 1) throw new Error(`expected exactly one ${sourcePackage.name} entry in dsh.profile.bundles; found ${bundled}`);
			if (manifest.dependencies?.[sourcePackage.name] !== fileSpec) {
				throw new Error(`expected dependencies["${sourcePackage.name}"] to be ${fileSpec}; found ${manifest.dependencies?.[sourcePackage.name] ?? "nothing"}`);
			}
			const patch = await readOptional(patchPath);
			if (patch !== null && pluginLine.test(patch)) {
				throw new Error(`${patchPath} still inserts dsh-usage-stats; the bundle patch already mounts it`);
			}
			pluginLine.lastIndex = 0;
		}
	} else if (enable) {
		const patch = await readOptional(patchPath);
		const count = patch === null ? 0 : [...patch.matchAll(pluginLine)].length;
		if (count !== 1) throw new Error(`expected exactly one dsh-usage-stats entry in ${patchPath}; found ${count}`);
		assertNoEmptyRootConflict(patch);
	}
	console.log(`Verified ${sourcePackage.name}@${sourcePackage.version}`);
	console.log(`  package: ${target}`);
	console.log(`  layout:  ${modern ? "profile bundle (dsh >= 0.1.7)" : "legacy insert (dsh < 0.1.7)"}`);
	if (modern) console.log(`  bundle:  ${manifestPath}`);
	else if (!args.has("--no-enable")) console.log(`  patch:   ${patchPath}`);
}

const enable = !args.has("--no-enable");
const manifest = await readManifest();
const modern = manifest !== null;
const target = modern ? bundleTarget : legacyTarget;

if (args.has("--dry-run")) {
	console.log(`Would install ${sourcePackage.name}@${sourcePackage.version}`);
	console.log(`  layout:  ${modern ? "profile bundle (dsh >= 0.1.7)" : "legacy insert (dsh < 0.1.7)"}`);
	console.log(`  package: ${target}`);
	console.log(`  bundle:  ${modern && enable ? manifestPath : "unchanged"}`);
	console.log(`  patch:   ${!modern && enable ? patchPath : "unchanged"}`);
	process.exit(0);
}

if (args.has("--check")) {
	await verify(modern);
	process.exit(0);
}

await mkdir(target, { recursive: true });
for (const entry of ["lib", "cordis.patch.yml", "package.json", "README.md", "LICENSE", "SECURITY.md"]) {
	await cp(join(sourceRoot, entry), join(target, entry), { recursive: true, force: true });
}
await mkdir(join(target, "scripts"), { recursive: true });
await cp(fileURLToPath(import.meta.url), join(target, "scripts", "install.mjs"), { force: true });

if (enable && modern) {
	const next = enablePluginInManifest(manifest);
	await writeFile(manifestPath, next, "utf8");
	const currentPatch = await readOptional(patchPath);
	if (currentPatch !== null) {
		const cleaned = stripLegacyInsert(currentPatch);
		if (cleaned !== currentPatch) await writeFile(patchPath, cleaned, "utf8");
	}
} else if (enable) {
	await mkdir(dirname(patchPath), { recursive: true });
	const current = await readOptional(patchPath) ?? "";
	const enabledPatch = enablePluginInPatch(current);
	if (enabledPatch !== current) await writeFile(patchPath, enabledPatch, "utf8");
}

await verify(modern);
console.log("Installation complete. Restart dsh web, then hard-refresh the browser.");
console.log("Balance is optional: configure DEEPSEEK_API_KEY in <DSH_HOME>/.credentials.yaml.");
