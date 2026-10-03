import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { readPlatformFixture } from "./platform-fixtures";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const id = "11111111-1111-4111-8111-111111111111";
const url = `https://blog.example.com/media/${id}/clip.png`;
function open(page: string, api: any) {
  const dom = new JSDOM(
    readFileSync(`frontend/themes/firefly/admin/${page}.html`, "utf8"),
    {
      url: `https://blog.example.com/admin/${page === "index" ? "" : page + ".html"}`,
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const win = dom.window;
  win.eval(readFileSync("frontend/core/api.js", "utf8"));
  win.eval(readFileSync("frontend/core/vendor/marked.umd.js", "utf8"));
  win.eval(readFileSync("frontend/core/vendor/purify.min.js", "utf8"));
  win.eval(readFileSync("frontend/core/markdown.js", "utf8"));
  win.Mob.api = vi.fn(async (path: string, options: any) =>
    path === "/api/admin/session"
      ? { email: "admin@example.com" }
      : api(path, options),
  );
  win.Mob.bindDrops = vi.fn();
  win.confirm = vi.fn(() => true);
  const proto = win.HTMLDialogElement.prototype;
  proto.showModal = function () {
    this.setAttribute("open", "");
  };
  proto.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new win.Event("close"));
  };
  win.eval(readFileSync("frontend/themes/firefly/admin/ui.js", "utf8"));
  win.eval(
    readFileSync(
      `frontend/themes/firefly/admin/${page === "index" ? "editor" : page}.js`,
      "utf8",
    ),
  );
  return { dom, win, api: win.Mob.api };
}
function input(win: any, selector: string, value: string) {
  const el = win.document.querySelector(selector) as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
  return el;
}
const config = () =>
  JSON.parse(
    readPlatformFixture("frontend/themes/firefly/config/appearance.json"),
  );
const media = () => ({
  id,
  url,
  filename: "clip.png",
  title: "测试素材",
  description: "",
  tags: [],
  contentType: "image/png",
  size: 1024,
  categoryId: "gallery",
  isPublic: true,
  isListed: true,
});
const categories = {
  value: {
    items: [
      { id: "gallery", name: "图库" },
      { id: "article-images", name: "文章插图" },
    ],
  },
};
describe("Firefly-Mod admin workflows", () => {
  it("groups settings and keeps unknown fields while saving only manual media references", async () => {
    const value = config();
    value.extension = { custom: "保留" };
    value.hero.cover = url;
    const { dom, win, api } = open(
      "settings",
      async (_path: string, options: any) =>
        options
          ? { sha: "b", value: options.json.value, commitSha: "commit" }
          : {
              sha: "a",
              value,
              mediaIds: [id, "22222222-2222-4222-8222-222222222222"],
            },
    );
    await tick();
    expect(
      win.document.querySelectorAll("[data-section]:not([hidden])").length,
    ).toBeGreaterThan(0);
    expect(
      (win.document.getElementById("settings-refs") as HTMLInputElement).value,
    ).not.toContain(id);
    input(win, '[data-path="hero.eyebrow"]', "新的首屏");
    win.document.getElementById("settings-save")!.click();
    await tick();
    const request = api.mock.calls.find(
      ([, options]: any) => options?.method === "PUT",
    );
    expect(request[1].json).toMatchObject({
      sha: "a",
      value: { hero: { eyebrow: "新的首屏" }, extension: { custom: "保留" } },
      mediaIds: ["22222222-2222-4222-8222-222222222222"],
    });
    dom.window.close();
  });
  it("selects private images from the gallery and saves their stable URL", async () => {
    const value = config();
    const { dom, win, api } = open(
      "settings",
      async (path: string, options: any) =>
        path.startsWith("/api/admin/gallery?")
          ? { items: [media()], limit: 24, total: 1 }
          : options
            ? { sha: "b", value: options.json.value, commitSha: "commit" }
            : { sha: "a", value, mediaIds: [] },
    );
    await tick();
    const cover = win.document
      .querySelector('[data-path="hero.cover"]')!
      .closest("label")!;
    (cover.querySelector("button") as HTMLButtonElement).click();
    await tick();
    expect(
      win.document.querySelector(".picker-item img")!.getAttribute("src"),
    ).toBe(`/api/admin/media/${id}/file`);
    (win.document.querySelector(".picker-item") as HTMLButtonElement).click();
    await tick();
    expect(
      (
        win.document.querySelector(
          '[data-path="hero.cover"]',
        ) as HTMLInputElement
      ).value,
    ).toBe(url);
    win.document.getElementById("settings-save")!.click();
    await tick();
    expect(
      api.mock.calls.find(([, options]: any) => options?.method === "PUT")[1]
        .json.value.hero.cover,
    ).toBe(url);
    dom.window.close();
  });
  it("locks form edits while raw JSON is pending and keeps raw text after conflicts", async () => {
    const { dom, win } = open(
      "settings",
      async (_path: string, options: any) => {
        if (options)
          throw Object.assign(new Error("conflict"), {
            code: "CONFIG_CONFLICT",
          });
        return { sha: "a", value: config(), mediaIds: [] };
      },
    );
    await tick();
    const value = config();
    value.custom = "原始扩展";
    input(win, "#settings-json", JSON.stringify(value));
    expect((win.document.getElementById("settings-fields") as any).inert).toBe(
      true,
    );
    win.document.getElementById("settings-save")!.click();
    await tick();
    expect(
      (win.document.getElementById("settings-json") as HTMLTextAreaElement)
        .value,
    ).toContain("原始扩展");
    expect(win.document.getElementById("settings-note")!.textContent).toContain(
      "已保留",
    );
    dom.window.close();
  });
  it("preserves draft input when the article list cannot load", async () => {
    const { dom, win } = open("index", async () => {
      throw new Error("GitHub unavailable");
    });
    await tick();
    expect(win.document.getElementById("editor")!.hidden).toBe(false);
    input(win, "#title", "写一篇中文文章");
    expect(
      (win.document.getElementById("slug") as HTMLInputElement).value,
    ).toMatch(/^note-\d{8}-/);
    expect(win.document.getElementById("post-list")!.textContent).toContain(
      "GitHub unavailable",
    );
    dom.window.close();
  });
  it("keeps edits made during an in-flight save and updates the SHA for the next save", async () => {
    let finish: any;
    let saving = false;
    const { dom, win, api } = open(
      "index",
      async (_path: string, options: any) => {
        if (!options) return { items: [] };
        if (!saving) {
          saving = true;
          return new Promise((resolve) => {
            finish = resolve;
          });
        }
        return { post: { slug: "hello", sha: "second", status: "draft" } };
      },
    );
    await tick();
    input(win, "#title", "hello");
    input(win, "#markdown", "第一次正文");
    win.document.getElementById("save-draft")!.click();
    await tick();
    input(win, "#markdown", "保存时继续写");
    finish({ post: { slug: "hello", sha: "first", status: "draft" } });
    await tick();
    expect(
      (win.document.getElementById("markdown") as HTMLTextAreaElement).value,
    ).toBe("保存时继续写");
    expect(
      win.document.querySelector("[data-save-state]")!.textContent,
    ).toContain("未保存");
    win.document.getElementById("save-draft")!.click();
    await tick();
    expect(
      api.mock.calls.filter(
        ([, options]: any) => options?.method === "PUT",
      )[1][1].json,
    ).toMatchObject({ sha: "first", markdown: "保存时继续写" });
    dom.window.close();
  });
  it("replaces an upload placeholder in place after caret movement without assigning the cover", async () => {
    const { dom, win } = open("index", async () => ({ items: [] }));
    await tick();
    let complete: any;
    win.Mob.uploadTask = vi.fn(
      () => () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const box = input(win, "#markdown", "前后");
    box.setSelectionRange(1, 1);
    const accept = win.Mob.bindDrops.mock.calls[0][1];
    accept([new win.File(["png"], "clip.png", { type: "image/png" })]);
    expect(box.value).toContain("前![clip.png · 上传中]");
    box.setSelectionRange(box.value.length, box.value.length);
    complete(media());
    await tick();
    expect(box.value).toBe(`前![clip.png](${url})后`);
    expect(
      (win.document.getElementById("cover") as HTMLInputElement).value,
    ).toBe("");
    expect(
      new URL(
        win.document.querySelector("#preview img")!.getAttribute("src")!,
        win.location.origin,
      ).pathname,
    ).toBe(`/api/admin/media/${id}/file`);
    dom.window.close();
  });
  it("blocks saving a failed upload, retries the same task, and sanitizes Markdown preview", async () => {
    const { dom, win, api } = open(
      "index",
      async (_path: string, options: any) =>
        options
          ? { post: { sha: "new", slug: "hello", status: "draft" } }
          : { items: [] },
    );
    await tick();
    input(win, "#title", "hello");
    input(win, "#markdown", '<img src=x onerror="alert(1)">');
    const task = vi
      .fn()
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValueOnce(media());
    win.Mob.uploadTask = vi.fn(() => task);
    win.Mob.bindDrops.mock.calls[0][1]([
      new win.File(["png"], "clip.png", { type: "image/png" }),
    ]);
    await tick();
    win.document.getElementById("save-draft")!.click();
    await tick();
    expect(
      api.mock.calls.filter(([, options]: any) => options?.method === "PUT"),
    ).toHaveLength(0);
    (
      win.document.querySelector("#upload-queue button") as HTMLButtonElement
    ).click();
    await tick();
    expect(task).toHaveBeenCalledTimes(2);
    expect(win.Mob.uploadTask).toHaveBeenCalledTimes(1);
    expect(win.document.querySelector("#preview [onerror]")).toBeNull();
    dom.window.close();
  });
  it("batch category changes preserve publication flags and keep patches on conflict", async () => {
    const { dom, win, api } = open(
      "gallery",
      async (path: string, options: any) => {
        if (options)
          throw Object.assign(new Error("conflict"), {
            code: "CONFIG_CONFLICT",
          });
        return path.includes("categories")
          ? categories
          : { items: [media()], limit: 24, total: 1, sha: "a" };
      },
    );
    await tick();
    const all = win.document.getElementById(
      "gallery-select-all",
    ) as HTMLInputElement;
    all.checked = true;
    all.dispatchEvent(new win.Event("change"));
    const category = win.document.getElementById(
      "batch-category",
    ) as unknown as HTMLSelectElement;
    category.value = "article-images";
    win.document.getElementById("gallery-batch")!.click();
    expect(
      api.mock.calls.filter(([, options]: any) => options?.method === "PATCH"),
    ).toHaveLength(0);
    win.document.getElementById("gallery-save")!.click();
    await tick();
    expect(
      api.mock.calls.find(([, options]: any) => options?.method === "PATCH")[1]
        .json,
    ).toEqual({ sha: "a", items: [{ id, categoryId: "article-images" }] });
    expect(
      win.document
        .querySelector(".media-card")!
        .classList.contains("is-pending"),
    ).toBe(true);
    expect(win.document.getElementById("gallery-note")!.textContent).toContain(
      "已保留",
    );
    dom.window.close();
  });
  it("enforces gallery listing grants and preserves dialog edits when closing is cancelled", async () => {
    const item = { ...media(), isPublic: false, isListed: false };
    const { dom, win } = open("gallery", async (path: string) =>
      path.includes("categories")
        ? categories
        : { items: [item], limit: 24, total: 1, sha: "a" },
    );
    await tick();
    (
      win.document.querySelector(".media-card button") as HTMLButtonElement
    ).click();
    const checks = [
      ...win.document.querySelectorAll(".dialog-fields input[type=checkbox]"),
    ] as HTMLInputElement[];
    checks[1].checked = true;
    checks[1].dispatchEvent(new win.Event("change"));
    expect(checks[0].checked).toBe(true);
    checks[0].checked = false;
    checks[0].dispatchEvent(new win.Event("change"));
    expect(checks[1].checked).toBe(false);
    input(win, ".dialog-fields input", "未应用");
    win.confirm = vi.fn(() => false);
    (
      win.document.querySelector(".dialog-heading button") as HTMLButtonElement
    ).click();
    expect(win.document.querySelector("dialog")).not.toBeNull();
    expect(
      (win.document.querySelector(".dialog-fields input") as HTMLInputElement)
        .value,
    ).toBe("未应用");
    dom.window.close();
  });
  it("deletes with the current gallery SHA and keeps protected references visible", async () => {
    let blocked = true;
    const { dom, win, api } = open(
      "gallery",
      async (path: string, options: any) => {
        if (options?.method === "DELETE") {
          if (blocked)
            throw Object.assign(new Error("in use"), {
              code: "MEDIA_IN_USE",
              details: {
                articles: ["hello"],
                configs: ["config/site/settings.json"],
              },
            });
          return {};
        }
        return path.includes("categories")
          ? categories
          : {
              items: blocked ? [media()] : [],
              limit: 24,
              total: blocked ? 1 : 0,
              sha: "current",
            };
      },
    );
    await tick();
    (
      win.document.querySelector(".media-card button") as HTMLButtonElement
    ).click();
    const remove = win.document.querySelector(
      ".dialog-fields .danger",
    ) as HTMLButtonElement;
    remove.click();
    await tick();
    expect(win.document.querySelector("dialog")!.textContent).toContain(
      "hello",
    );
    expect(win.document.querySelector("dialog")!.textContent).toContain(
      "config/site/settings.json",
    );
    expect(remove.disabled).toBe(false);
    blocked = false;
    remove.click();
    await tick();
    expect(
      api.mock.calls.filter(
        ([, options]: any) => options?.method === "DELETE",
      )[1][1].json,
    ).toEqual({ sha: "current" });
    expect(win.document.querySelector("dialog")).toBeNull();
    dom.window.close();
  });
});
