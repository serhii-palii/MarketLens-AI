// FILE: api/spikes/run-ladder.mjs
// Calls the spike Worker repeatedly per pipeline stage and page size and reports how many requests succeeded.
const baseUrl = process.argv[2];
const runs = Number(process.argv[3] ?? 15);

if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
  console.error(
    "Usage: npm run spike:ladder -w api -- <base-url> [runs] [sizes,comma,separated] [variants,comma,separated]",
  );
  process.exit(1);
}

const defaultSizes = ["100kb", "250kb", "400kb", "1000kb"];
const defaultVariants = [
  "h2-handlers",
  "h3-normalize",
  "h5-diff",
  "r1-strip",
  "r4-diff",
  "r5-trunc-diff",
  "r6-full",
];
const sizes = process.argv[4] ? process.argv[4].split(",") : defaultSizes;
const variants = process.argv[5] ? process.argv[5].split(",") : defaultVariants;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log(
  `Runs per cell: ${runs}. Each cell shows successful requests (non-200 codes in brackets).\n`,
);
console.log(
  ["stage".padEnd(15), ...sizes.map((size) => size.padEnd(14))].join(" "),
);

for (const variant of variants) {
  const cells = [];
  for (const size of sizes) {
    let ok = 0;
    const failures = {};
    for (let i = 0; i < runs; i += 1) {
      try {
        const response = await fetch(
          `${baseUrl}/spike/fixture?name=${size}&variant=${variant}`,
        );
        await response.arrayBuffer();
        if (response.status === 200) ok += 1;
        else failures[response.status] = (failures[response.status] ?? 0) + 1;
      } catch {
        failures.net = (failures.net ?? 0) + 1;
      }
      await pause(120);
    }
    const detail = Object.keys(failures).length
      ? ` [${Object.entries(failures)
          .map(([c, n]) => `${c}x${n}`)
          .join(",")}]`
      : "";
    cells.push(`${ok}/${runs}${detail}`.padEnd(14));
  }
  console.log([variant.padEnd(15), ...cells].join(" "));
}
console.log(
  "\n503 or 1102 means the Worker exceeded a resource limit on that request.",
);
