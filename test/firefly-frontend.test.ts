import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { readPlatformFixture } from "./platform-fixtures";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function open(page: string) {
  const dom = new JSDOM(
    readFileSync(`frontend/themes/firefly/${page}.html`, "utf8"),
    {
      url: `https://blog.example.com/${page === "index" ? "" : page + ".html"}`,
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const win = dom.window;
  win.eval(readFileSync("frontend/core/api.js", "utf8"));
  win.eval(readFileSync("frontend/core/markdown.js", "utf8"));
  const preference = { matches: false, addEventListener: vi.fn() };
  win.matchMedia = vi.fn((query) =>
    query.includes("prefers")
      ? preference
      : { matches: true, addEventListener: vi.fn() },
  ) as any;
  win.HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as any;
  win.HTMLElement.prototype.scrollIntoView = vi.fn();
  win.scrollTo = vi.fn();
  win.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  win.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new win.Event("close"));
  };
  return { dom, win, preference };
}
describe("Firefly-Mod visitor experience", () => {
  it("moves the visitor theme picker into the mobile menu and restores it on desktop", async () => {
    const { dom, win } = open("index");
    Object.defineProperty(win, "innerWidth", { value: 390, writable: true });
    win.eval(
      readFileSync("frontend/themes/firefly/js/enhancements.js", "utf8"),
    );
    const picker = win.document.createElement("label");
    picker.className = "layout-picker";
    picker.innerHTML = "<select><option>Firefly-Mod</option></select>";
    (win.document.querySelector(".header-actions") as any).append(picker);
    await tick();
    expect(picker.parentElement!.id).toBe("mobile-menu");
    Object.defineProperty(win, "innerWidth", { value: 1440, writable: true });
    win.dispatchEvent(new win.Event("resize"));
    await tick();
    expect(picker.parentElement!.className).toBe("header-actions");
    dom.window.close();
  });
  it("syncs shortcut controls and reduced motion while making static scene buttons jump directly", async () => {
    const { dom, win, preference } = open("index");
    win.Mob.publishedPosts = vi.fn(async () => ({ items: [], total: 0 }));
    win.eval(readFileSync("frontend/themes/firefly/js/home.js", "utf8"));
    win.eval(
      readFileSync("frontend/themes/firefly/js/enhancements.js", "utf8"),
    );
    const controls = [
      ...win.document.querySelectorAll<HTMLButtonElement>(
        "[data-motion-toggle]",
      ),
    ];
    expect(controls).toHaveLength(2);
    controls[1].click();
    expect(
      win.document.documentElement.classList.contains("home-enhanced"),
    ).toBe(false);
    expect(controls.map((b) => b.getAttribute("aria-pressed"))).toEqual([
      "true",
      "true",
    ]);
    (win.document.querySelector("[data-scene]") as HTMLButtonElement).click();
    expect(win.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    expect(win.scrollTo).not.toHaveBeenCalled();
    preference.matches = true;
    win.document.dispatchEvent(
      new win.CustomEvent("mob:theme-config", {
        detail: { journey: { wishes: ["你好"] } },
      }),
    );
    expect(controls.every((b) => b.disabled)).toBe(true);
    dom.window.close();
  });
  it("keeps custom dialogue links intact, falls back for missing topics and blocks unsafe links", () => {
    const { dom, win } = open("index");
    win.Mob.publishedPosts = vi.fn(async () => ({ items: [], total: 0 }));
    const config = JSON.parse(
      readPlatformFixture("frontend/themes/firefly/config/appearance.json"),
    );
    config.dialogue.topics = {
      contact: ["联系文字", "https://custom.example.com", "定制联系"],
      reading: ["文字", "javascript:alert(1)", "危险链接"],
    };
    win.Mob.themeConfig = config;
    win.Mob.site = {
      socials: [{ label: "GitHub", url: "https://github.com/example" }],
    };
    win.eval(readFileSync("frontend/themes/firefly/js/home.js", "utf8"));
    const before = JSON.stringify(config);
    (
      win.document.querySelector('[data-topic="contact"]') as HTMLButtonElement
    ).click();
    expect(
      win.document.querySelector(".dialogue-link")!.getAttribute("href"),
    ).toBe("https://custom.example.com/");
    expect(JSON.stringify(config)).toBe(before);
    (
      win.document.querySelector('[data-topic="about"]') as HTMLButtonElement
    ).click();
    expect(
      win.document.querySelector(".dialogue-link")!.getAttribute("href"),
    ).toBe("https://blog.example.com/about.html");
    (
      win.document.querySelector('[data-topic="reading"]') as HTMLButtonElement
    ).click();
    expect(
      (win.document.querySelector(".dialogue-link") as HTMLElement).hidden,
    ).toBe(true);
    dom.window.close();
  });
  it("offers keyboard image browsing and restores focus after the lightbox closes", async () => {
    const { dom, win } = open("gallery");
    const root = win.document.getElementById("public-gallery")!;
    root.innerHTML =
      '<article class="media-card"><img src="/one.png" alt="第一张"><h2>第一张</h2></article><article class="media-card"><img src="/two.png" alt="第二张"><h2>第二张</h2></article>';
    win.eval(
      readFileSync("frontend/themes/firefly/js/enhancements.js", "utf8"),
    );
    const image = root.querySelector("img")!;
    image.focus();
    image.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    const dialog = win.document.querySelector("dialog")!;
    expect(dialog.querySelector("img")!.getAttribute("src")).toContain(
      "/one.png",
    );
    dialog.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(dialog.querySelector("img")!.getAttribute("src")).toContain(
      "/two.png",
    );
    (dialog.querySelector(".lightbox-close") as HTMLButtonElement).click();
    expect(win.document.querySelector("dialog")).toBeNull();
    expect(win.document.activeElement).toBe(image);
    dom.window.close();
  });
  it("sets the gallery title and navigation after public site settings arrive", () => {
    const { dom, win } = open("gallery");
    win.eval(
      readFileSync("frontend/themes/firefly/js/enhancements.js", "utf8"),
    );
    win.Mob.site = { title: "我的空间" };
    win.document.dispatchEvent(new win.CustomEvent("mob:site"));
    expect(win.document.title).toBe("图库 · 我的空间");
    expect(
      win.document
        .querySelector('.nav-pill a[href="/gallery.html"]')!
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      win.document
        .querySelector('.nav-pill a[href="/archive.html"]')!
        .hasAttribute("aria-current"),
    ).toBe(false);
    dom.window.close();
  });
  it("keeps public gallery contents and category after a failed page request", async () => {
    const { dom, win } = open("gallery");
    let fail = false;
    win.Mob.api = vi.fn(async (path) => {
      if (fail) throw new Error("unavailable");
      if (path.includes("categories"))
        return { value: { items: [{ id: "images", name: "图片" }] } };
      return {
        items: [
          {
            title: "当前图片",
            description: "保留",
            url: "/image.png",
            contentType: "image/png",
          },
        ],
        total: 48,
      };
    });
    win.eval(readFileSync("frontend/themes/firefly/js/gallery.js", "utf8"));
    await tick();
    fail = true;
    win.document.getElementById("public-next")!.click();
    await tick();
    expect(
      win.document.getElementById("public-gallery")!.textContent,
    ).toContain("当前图片");
    expect(
      win.document.getElementById("gallery-message")!.textContent,
    ).toContain("已保留");
    expect(
      [...win.document.querySelectorAll("button")].some(
        (b) => b.textContent === "重新读取" && !b.hidden,
      ),
    ).toBe(true);
    dom.window.close();
  });
});
