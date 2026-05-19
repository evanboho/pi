import { getPiUserAgent } from "./pi-user-agent.ts";

const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface LatestPiRelease {
	version: string;
	packageName?: string;
	note?: string;
	/** The `engines.node` range required by this release (e.g. `">=22.19.0"`). */
	minNodeVersion?: string;
}

interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	prerelease?: string;
}

function parsePackageVersion(version: string): ParsedVersion | undefined {
	const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
	if (!match) {
		return undefined;
	}
	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		prerelease: match[4],
	};
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = parsePackageVersion(leftVersion);
	const right = parsePackageVersion(rightVersion);
	if (!left || !right) {
		return undefined;
	}

	if (left.major !== right.major) return left.major - right.major;
	if (left.minor !== right.minor) return left.minor - right.minor;
	if (left.patch !== right.patch) return left.patch - right.patch;
	if (left.prerelease === right.prerelease) return 0;
	if (!left.prerelease) return 1;
	if (!right.prerelease) return -1;
	return left.prerelease.localeCompare(right.prerelease);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

/**
 * Returns true when `nodeVersion` satisfies a `>=X.Y.Z` engine range.
 * Handles the most common form used in `engines.node` fields.
 * Returns `true` (assume compatible) for ranges it cannot parse.
 */
export function satisfiesNodeRange(range: string, nodeVersion: string = process.versions.node): boolean {
	const match = range.trim().match(/^>=\s*v?(\d+\.\d+\.\d+)/);
	if (match) {
		const normalized = nodeVersion.replace(/^v/, "");
		return (comparePackageVersions(normalized, match[1]) ?? -1) >= 0;
	}
	// Cannot parse range - conservatively assume compatible.
	return true;
}

async function fetchPackageEngineRequirement(
	packageName: string,
	version: string,
	options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
	try {
		const encodedName = encodeURIComponent(packageName);
		const response = await fetch(`${NPM_REGISTRY_URL}/${encodedName}/${version}`, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
		});
		if (!response.ok) return undefined;
		const data = (await response.json()) as { engines?: { node?: unknown } };
		const nodeRange = data.engines?.node;
		return typeof nodeRange === "string" && nodeRange.trim() ? nodeRange.trim() : undefined;
	} catch {
		return undefined;
	}
}

export async function getLatestPiRelease(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_SKIP_VERSION_CHECK || process.env.PI_OFFLINE) return undefined;

	const response = await fetch(LATEST_VERSION_URL, {
		headers: {
			"User-Agent": getPiUserAgent(currentVersion),
			accept: "application/json",
		},
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		packageName?: unknown;
		version?: unknown;
		note?: unknown;
	};
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	const packageName =
		typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : undefined;
	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
	const release: LatestPiRelease = {
		version: data.version.trim(),
		packageName,
		...(note ? { note } : {}),
	};

	// When a newer version is available, check its Node engine requirement so
	// callers can detect whether the current Node can actually install it.
	if (packageName && isNewerPackageVersion(release.version, currentVersion)) {
		release.minNodeVersion = await fetchPackageEngineRequirement(packageName, release.version, options);
	}

	return release;
}

export async function getLatestPiVersion(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

export async function checkForNewPiVersion(currentVersion: string): Promise<LatestPiRelease | undefined> {
	try {
		const latestRelease = await getLatestPiRelease(currentVersion);
		if (!latestRelease || !isNewerPackageVersion(latestRelease.version, currentVersion)) return undefined;
		// Suppress the banner when the new version can't be installed on the current Node.
		if (latestRelease.minNodeVersion && !satisfiesNodeRange(latestRelease.minNodeVersion)) return undefined;
		return latestRelease;
	} catch {
		return undefined;
	}
}

/**
 * Like `checkForNewPiVersion` but returns the full `LatestPiRelease` so callers
 * can display a richer message when the update requires a Node upgrade.
 */
export async function checkForNewPiRelease(currentVersion: string): Promise<LatestPiRelease | undefined> {
	try {
		const release = await getLatestPiRelease(currentVersion);
		if (!release || !isNewerPackageVersion(release.version, currentVersion)) return undefined;
		return release;
	} catch {
		return undefined;
	}
}
