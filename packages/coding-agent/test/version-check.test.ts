import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewPiRelease,
	checkForNewPiVersion,
	comparePackageVersions,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
	satisfiesNodeRange,
} from "../src/utils/version-check.ts";

const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
const originalOffline = process.env.PI_OFFLINE;

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.PI_SKIP_VERSION_CHECK;
	} else {
		process.env.PI_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
	if (originalOffline === undefined) {
		delete process.env.PI_OFFLINE;
	} else {
		process.env.PI_OFFLINE = originalOffline;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("satisfies node engine ranges", () => {
		expect(satisfiesNodeRange(">=22.19.0", "22.19.0")).toBe(true);
		expect(satisfiesNodeRange(">=22.19.0", "22.18.0")).toBe(false);
		expect(satisfiesNodeRange(">=22.19.0", "23.0.0")).toBe(true);
		expect(satisfiesNodeRange(">=20.6.0", "22.18.0")).toBe(true);
		expect(satisfiesNodeRange(">=22.19.0 <24", "22.18.0")).toBe(false);
		// Unparseable ranges default to compatible.
		expect(satisfiesNodeRange("*", "22.18.0")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toEqual({ version: "1.2.3" });
	});

	it("suppresses update when new version requires a newer Node", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (String(url).includes("registry.npmjs.org")) {
				return Response.json({ engines: { node: ">=99.0.0" } });
			}
			return Response.json({ version: "1.2.3", packageName: "@earendil-works/pi-coding-agent" });
		});
		vi.stubGlobal("fetch", fetchMock);

		// checkForNewPiVersion hides incompatible updates.
		await expect(checkForNewPiVersion("1.2.2")).resolves.toBeUndefined();
		// checkForNewPiRelease still surfaces them for richer UI messages.
		const release = await checkForNewPiRelease("1.2.2");
		expect(release).toMatchObject({ version: "1.2.3", minNodeVersion: ">=99.0.0" });
	});

	it("allows update when new version is compatible with current Node", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (String(url).includes("registry.npmjs.org")) {
				return Response.json({ engines: { node: ">=0.0.1" } });
			}
			return Response.json({ version: "1.2.3", packageName: "@earendil-works/pi-coding-agent" });
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.2")).resolves.toMatchObject({ version: "1.2.3" });
	});

	it("uses the pi.dev version check api with a pi user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://pi.dev/api/latest-version",
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^pi\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("returns the active package metadata from the version check api", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (String(url).includes("registry.npmjs.org")) {
				return Response.json({});
			}
			return Response.json({ packageName: "@new-scope/pi", version: "1.2.4" });
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toMatchObject({
			packageName: "@new-scope/pi",
			version: "1.2.4",
		});
	});

	it("returns update notes from the version check api", async () => {
		const fetchMock = vi.fn(async () => Response.json({ note: " **Read this** ", version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({ note: "**Read this**", version: "1.2.4" });
	});

	it("skips api calls when version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
