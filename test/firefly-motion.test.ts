import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

/** Fixed viewport/geometry: measures script work, not browser FPS or paint time. */
function replay() {
  const dom = new JSDOM(
    readFileSync("frontend/themes/firefly/index.html", "utf8"),
    {
      url: "https://blog.example.com/",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const win = dom.window;
  const desktop = { matches: true, addEventListener: vi.fn() };
  win.matchMedia = vi.fn((query) =>
    query.includes("prefers")
      ? { matches: false, addEventListener: vi.fn() }
      : desktop,
  ) as any;
  win.Mob = {
    escapeHtml: String,
    publishedPosts: async () => ({ items: [], total: 0 }),
    themeConfig: { motion: { enabled: true, rain: true } },
  };
  let rainFrames = 0,
    rainSegments = 0;
  win.HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    setTransform() {},
    clearRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {
      rainSegments++;
    },
    stroke() {
      rainFrames++;
    },
  })) as any;
  Object.defineProperty(win, "innerHeight", { value: 900 });
  let scrollPosition = 0;
  Object.defineProperty(win, "scrollY", { get: () => scrollPosition });
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  win.requestAnimationFrame = (callback) => {
    frames.set(++sequence, callback);
    return sequence;
  };
  win.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  let geometryReads = 0;
  let styleAssignments = 0;
  for (const property of ["opacity", "transform", "filter"]) {
    const descriptor = Object.getOwnPropertyDescriptor(
      win.CSSStyleDeclaration.prototype,
      property,
    )!;
    Object.defineProperty(win.CSSStyleDeclaration.prototype, property, {
      ...descriptor,
      set(value) {
        styleAssignments++;
        descriptor.set!.call(this, value);
      },
    });
  }
  for (const [selector, top, height] of [
    [".hero-scroll", 0, 4000],
    [".blinds-scroll", 5000, 3000],
    [".story-scroll", 8500, 6000],
  ] as const) {
    const node = win.document.querySelector<HTMLElement>(selector)!;
    node.getBoundingClientRect = () => ({ top: top - win.scrollY }) as DOMRect;
    Object.defineProperty(node, "offsetHeight", {
      get() {
        geometryReads++;
        return height;
      },
    });
  }
  [...win.document.querySelectorAll(".story-scene")].forEach((node, i) =>
    Object.defineProperty(node, "offsetLeft", { value: i * 1348 }),
  );
  function frame() {
    const pending = [...frames];
    frames.clear();
    pending.forEach(([, callback]) => callback(sequence * 16.67));
  }
  win.eval(
    readFileSync(
      process.env.MOB_PERF_SOURCE ?? "frontend/themes/firefly/js/home.js",
      "utf8",
    ),
  );
  frame();
  const observer = new win.MutationObserver(() => {});
  observer.observe(win.document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["style"],
  });
  const selectors = [
    ".mosaic-tile",
    ".mosaic-frame",
    ".hero-identity",
    ".hero-contact",
    ".hero-backdrop",
    ".hero-shade",
    ".hero-quick",
    ".hero-bottom",
    ".hero-rain",
    ".blind-left",
    ".blind-right",
    ".blinds-headline",
    ".blinds-foreground",
    ".story-track",
  ];
  const hash = createHash("sha256");
  function snapshot() {
    return selectors
      .flatMap((selector) =>
        [...win.document.querySelectorAll<HTMLElement>(selector)].map(
          (node) => [node.style.cssText, node.inert ?? false],
        ),
      )
      .concat([
        [
          win.document.querySelector(".story-counter")!.textContent ?? "",
          false,
        ],
      ]);
  }
  const cases = [];
  for (const [name, position] of [
    ["hero", 1100],
    ["hero-rain", 2200],
    ["guide", 4500],
    ["blinds", 5600],
    ["story", 10000],
    ["footer", 17000],
  ] as const) {
    scrollPosition = position;
    win.dispatchEvent(new win.Event("scroll"));
    for (let i = 0; i < 100; i++) frame();
    observer.takeRecords();
    geometryReads = 0;
    styleAssignments = 0;
    rainFrames = 0;
    rainSegments = 0;
    let writes = 0;
    for (let i = 0; i < 120; i++) {
      scrollPosition = position + i;
      win.dispatchEvent(new win.Event("scroll"));
      frame();
      writes += observer.takeRecords().length;
      hash.update(JSON.stringify(snapshot()));
    }
    cases.push({
      name,
      frames: 120,
      styleAssignments,
      styleMutations: writes,
      geometryReads,
      rainFrames,
      rainSegments,
    });
  }
  const beforeResize = snapshot();
  win.dispatchEvent(new win.Event("resize"));
  frame();
  expect(snapshot()).toEqual(beforeResize);
  win.document.dispatchEvent(new win.CustomEvent("mob:motion"));
  frame();
  expect(snapshot()).toEqual(beforeResize);
  expect(win.document.querySelectorAll(".mosaic-tile")).toHaveLength(24);
  expect(win.document.querySelectorAll(".story-scene")).toHaveLength(5);
  observer.disconnect();
  dom.window.close();
  return { visualDigest: hash.digest("hex"), cases };
}
describe("Firefly-Mod motion performance", () => {
  it("replays all 720 visible animation states without changing their transforms, opacity, blur or interaction state", () => {
    const result = replay();
    if (process.env.MOB_PERF_OUTPUT)
      writeFileSync(
        process.env.MOB_PERF_OUTPUT,
        JSON.stringify(result, null, 2),
      );
    // Recorded from the original implementation before removing redundant work.
    expect(result.visualDigest).toBe(
      "33c962b77baf1439c5d70d1e3656dfbafc1156630aa88f5647648ea45646b207",
    );
    expect(
      result.cases.find((item) => item.name === "hero-rain"),
    ).toMatchObject({ rainFrames: 120, rainSegments: 4320 });
    if (!process.env.MOB_PERF_SOURCE) {
      expect(
        result.cases.find((item) => item.name === "story")!.styleAssignments,
      ).toBe(119);
      expect(
        result.cases.find((item) => item.name === "footer")!.styleAssignments,
      ).toBe(0);
      expect(result.cases.every((item) => item.geometryReads === 0)).toBe(true);
    }
  });
});
