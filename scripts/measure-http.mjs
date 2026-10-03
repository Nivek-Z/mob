import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

// Read-only, manual production measurement. Not part of the offline test suite.
const [site, cover, output] = process.argv.slice(2);
if (!site || !cover || !output)
  throw new Error(
    "Usage: node scripts/measure-http.mjs https://your-site /media/id/filename /tmp/http.json",
  );
const origin = new URL(site).origin;
if (
  !/^https?:/.test(origin) ||
  !cover.startsWith("/media/") ||
  cover.startsWith("//")
)
  throw new Error("Use an HTTP(S) site and a stable media path.");
const paths = [
  "/",
  "/api/themes/firefly/config/appearance",
  "/api/posts",
  "/api/activity",
  "/themes/firefly/js/home.js",
  cover,
];
const args = [
  "--compressed",
  "--silent",
  "--show-error",
  "--max-time",
  "45",
  "--write-out",
  "%{json}\n",
];
for (let round = 0; round < 7; round++)
  for (const path of paths) args.push("--output", "/dev/null", origin + path);
const result = spawnSync("curl", args, {
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024,
});
if (result.status !== 0) throw new Error("curl failed: " + result.stderr);
const requests = result.stdout
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
if (
  requests.length !== 7 * paths.length ||
  requests.some((item) => item.http_code !== 200)
)
  throw new Error(
    "An incomplete or non-200 response makes this comparison invalid.",
  );
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const summary = paths.map((path, i) => {
  const samples = Array.from(
    { length: 5 },
    (_, round) => requests[(round + 2) * paths.length + i],
  );
  if (samples.some((item) => item.num_connects !== 0))
    throw new Error(
      "The measured samples did not reuse their connection; repeat the run.",
    );
  return {
    path,
    samples: samples.length,
    ttfbMs: median(samples.map((item) => item.time_starttransfer * 1000)),
    totalMs: median(samples.map((item) => item.time_total * 1000)),
    wireBytes: median(samples.map((item) => item.size_download)),
  };
});
writeFileSync(
  output,
  JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      site: origin,
      warmupRounds: 2,
      measuredRounds: 5,
      summary,
      requests,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify(summary, null, 2));
