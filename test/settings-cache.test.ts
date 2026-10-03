import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { SettingsService, SITE_PATH, THEMES_PATH } from "../src/settings";
import type { GitHubClient } from "../src/github";
import type { Env } from "../src/types";
import { FakeR2Bucket } from "./fake-r2";
import { readPlatformFixture } from "./platform-fixtures";

const id = "12345678-1234-4234-8234-123456789abc";
const other = "22345678-1234-4234-8234-123456789abc";
const path = "frontend/themes/firefly/config/appearance.json";
const key = ".mob/settings/public-references.json";
function setup() {
  const bucket = new FakeR2Bucket();
  const env = {
    MEDIA: bucket.asBucket(),
    SITE_ORIGIN: "https://blog.example.com",
    GITHUB_OWNER: "owner",
    GITHUB_REPO: "blog",
    GITHUB_BRANCH: "main",
    POSTS_DIRECTORY: "content/posts",
  } as Env;
  let head = "a".repeat(40);
  const files = new Map([
    [THEMES_PATH, readPlatformFixture(THEMES_PATH)],
    [
      "frontend/themes/firefly/theme.json",
      readFileSync("frontend/themes/firefly/theme.json", "utf8"),
    ],
    [
      "frontend/themes/paper/theme.json",
      readFileSync("frontend/themes/paper/theme.json", "utf8"),
    ],
    [
      path,
      JSON.stringify({
        cover: "/media/" + id + "/image.png",
        other: "/media/" + other + "/other.png",
      }),
    ],
    [
      path.replace(".json", ".references.json"),
      JSON.stringify({ mediaIds: [id] }),
    ],
  ]);
  const github = {
    readHead: vi.fn(async () => head),
    readTree: vi.fn(async () =>
      [...files.keys()].map((path) => ({ path, sha: path })),
    ),
    readBlob: vi.fn(async (sha: string) => files.get(sha)!),
    readBlobs: vi.fn(
      async (shas: string[]) =>
        new Map(shas.map((sha) => [sha, files.get(sha)!])),
    ),
    readFile: vi.fn(async (path: string) =>
      files.has(path)
        ? { sha: "b".repeat(40), content: files.get(path)! }
        : null,
    ),
  };
  const settings = new SettingsService(env, github as unknown as GitHubClient);
  return {
    bucket,
    env,
    files,
    github,
    settings,
    changeHead: () => {
      head = "b".repeat(40);
    },
  };
}
describe("public configuration reference snapshot cache", () => {
  it("reduces a warm lookup to live HEAD and reuses the same index for different media IDs", async () => {
    const { settings, github } = setup();
    expect(await settings.usage(id, true)).toEqual([
      path,
      path.replace(".json", ".references.json"),
    ]);
    const cold =
      github.readHead.mock.calls.length +
      github.readTree.mock.calls.length +
      github.readBlob.mock.calls.length +
      github.readBlobs.mock.calls.length;
    expect(cold).toBe(5);
    const treeReads = github.readTree.mock.calls.length;
    expect(await settings.usage(other, true)).toEqual([path]);
    expect(
      await settings.usage("32345678-1234-4234-8234-123456789abc", true),
    ).toEqual([]);
    expect(github.readHead).toHaveBeenCalledTimes(3);
    expect(github.readTree).toHaveBeenCalledTimes(treeReads);
  });
  it("rebuilds on a new HEAD and immediately withdraws removed or disabled references", async () => {
    const { settings, files, changeHead } = setup();
    expect(await settings.usage(id, true)).not.toHaveLength(0);
    const registry = JSON.parse(files.get(THEMES_PATH)!);
    registry.defaultTheme = "paper";
    registry.themes[0].enabled = false;
    files.set(THEMES_PATH, JSON.stringify(registry));
    changeHead();
    expect(await settings.usage(id, true)).toEqual([]);
    expect(await settings.usage(id)).toEqual([
      path,
      path.replace(".json", ".references.json"),
    ]);
  });
  it("fails closed when live HEAD cannot be read, even with a usable cache", async () => {
    const { settings, github } = setup();
    await settings.usage(id, true);
    github.readHead.mockRejectedValueOnce(new Error("upstream unavailable"));
    await expect(settings.usage(id, true)).rejects.toThrow(
      "upstream unavailable",
    );
  });
  it.each(["GITHUB_REPO", "GITHUB_BRANCH", "SITE_ORIGIN"] as const)(
    "never reuses another %s namespace",
    async (field) => {
      const { settings, env, github } = setup();
      await settings.usage(id, true);
      env[field] =
        field === "SITE_ORIGIN" ? "https://other.example.com" : "other";
      await settings.usage(id, true);
      expect(github.readTree).toHaveBeenCalledTimes(2);
    },
  );
  it("includes common reference sidecars and never relies on a public cache for deletion checks", async () => {
    const { settings, files, github } = setup();
    files.set(
      SITE_PATH.replace(".json", ".references.json"),
      JSON.stringify({ mediaIds: [id] }),
    );
    expect(await settings.usage(id, true)).toContain(
      SITE_PATH.replace(".json", ".references.json"),
    );
    await settings.usage(id, true);
    expect(github.readTree).toHaveBeenCalledTimes(1);
    await settings.usage(id);
    expect(github.readTree).toHaveBeenCalledTimes(2);
  });
  it.each([
    "invalid-json",
    "invalid-id",
    "invalid-path",
    "wrong-head",
    "oversized",
  ])("rebuilds a %s cache", async (kind) => {
    const { settings, bucket, github } = setup();
    await settings.usage(id, true);
    const data = await (await bucket.get(key))!.json<any>();
    if (kind === "invalid-id") data.refs[0][0] = "bad";
    if (kind === "invalid-path")
      data.refs[0][1] = ["config/cloudflare/settings.json"];
    if (kind === "wrong-head") data.head = "c".repeat(40);
    await bucket.put(
      key,
      kind === "invalid-json"
        ? "{"
        : kind === "oversized"
          ? "x".repeat(2 * 1024 * 1024 + 1)
          : JSON.stringify(data),
    );
    expect(await settings.usage(id, true)).toContain(path);
    expect(github.readTree).toHaveBeenCalledTimes(2);
  });
  it("continues reading GitHub when cache reads or writes fail", async () => {
    const { settings, bucket } = setup();
    vi.spyOn(bucket, "get").mockRejectedValue(new Error("R2 get unavailable"));
    vi.spyOn(bucket, "put").mockRejectedValue(new Error("R2 put unavailable"));
    expect(await settings.usage(id, true)).toContain(path);
  });
  it("reads an admin theme document once while returning its SHA and explicit references", async () => {
    const { settings, github } = setup();
    const result = await settings.readTheme("firefly", "appearance", true);
    expect(result).toMatchObject({
      sha: "b".repeat(40),
      mediaIds: [id],
      declaration: { id: "appearance" },
    });
    expect(
      github.readFile.mock.calls.filter(([file]) => file === path),
    ).toHaveLength(1);
  });
});
