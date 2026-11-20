// FILE: api/spikes/run-ladder.mjs
// Calls the deployed spike Worker repeatedly per page size and reports how many requests finished successfully.
const baseUrl = process.argv[2];
const runs = Number(process.argv[3] ?? 25);

if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
  console.error("Usage: npm run spike:ladder -w api -- <base-url> [runs]");
  process.exit(1);
}

const sizes = ["50kb", "150kb", "400kb", "1000kb"];
const operations = ["extract", "diff"];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log(`Runs per case: ${runs}\n`);
console.log("size     operation  ok/total  statuses");

for (const size of sizes) {
  for (const operation of operations) {
    const statuses = {};
    let ok = 0;
    for (let i = 0; i < runs; i += 1) {
      try {
        const response = await fetch(`${baseUrl}/spike/fixture?name=${size}&op=${operation}`);
        statuses[response.status] = (statuses[response.status] ?? 0) + 1;
        if (response.status === 200) ok += 1;
        await response.arrayBuffer();
      } catch {
        statuses.network_error = (statuses.network_error ?? 0) + 1;
      }
      await pause(150);
    }
    const summary = Object.entries(statuses).map(([code, count]) => `${code}x${count}`).join(" ");
    console.log(`${size.padEnd(8)} ${operation.padEnd(10)} ${`${ok}/${runs}`.padEnd(9)} ${summary}`);
  }
}
console.log("\nA status of 1102 or 503 means the Worker exceeded a resource limit on that request.");
