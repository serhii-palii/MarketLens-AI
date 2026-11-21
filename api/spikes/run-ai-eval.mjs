// FILE: api/spikes/run-ai-eval.mjs
// Runs the synthetic change-analysis cases against the deployed spike Worker and summarizes quality and cost per model.
const baseUrl = process.argv[2];
const token = process.env.SPIKE_TOKEN;
const configs = (
  process.argv[3] ??
  "gpt-oss-20b:schema,gpt-oss-20b:prompt,gpt-oss-120b:schema,llama-3.3-70b:schema"
).split(",");

if (!baseUrl || !/^https?:\/\//.test(baseUrl) || !token) {
  console.error(
    "Usage: SPIKE_TOKEN=<your token> npm run spike:eval -w api -- <base-url> [model:mode,model:mode]",
  );
  process.exit(1);
}

// Neurons per million tokens (input, output) from the official pricing table.
const RATES = {
  "gpt-oss-20b": [18182, 27273],
  "gpt-oss-120b": [31818, 68182],
  "llama-3.3-70b": [26668, 204805],
};
const caseIds = [1, 2, 3, 4, 5, 6, 7, 8];
const count = (rows, key) => rows.filter((row) => row[key] === true).length;
const average = (values) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

console.log(
  "config                    n   json  schema  grounded  label  uncert  inject  tok in/out   latency  neurons/call  analyses/day",
);
let totalNeurons = 0;
const errors = [];

for (const config of configs) {
  const [model, mode] = config.split(":");
  const rows = [];
  for (const id of caseIds) {
    try {
      const response = await fetch(
        `${baseUrl}/spike/ai?model=${model}&mode=${mode}&case=${id}`,
        { headers: { "x-spike-token": token } },
      );
      const body = await response.json();
      if (body.error)
        errors.push(`${config} case ${id}: ${response.status} ${body.error}`);
      rows.push(body);
    } catch (error) {
      errors.push(`${config} case ${id}: ${String(error).slice(0, 80)}`);
    }
  }
  const tokensIn = average(
    rows.map((r) => r.tokensIn).filter((v) => typeof v === "number"),
  );
  const tokensOut = average(
    rows.map((r) => r.tokensOut).filter((v) => typeof v === "number"),
  );
  const latency = average(
    rows.map((r) => r.latencyMs).filter((v) => typeof v === "number"),
  );
  const rate = RATES[model];
  const neurons =
    tokensIn !== null && tokensOut !== null && rate
      ? (tokensIn * rate[0] + tokensOut * rate[1]) / 1e6
      : null;
  if (neurons !== null) totalNeurons += neurons * rows.length;
  const injection = rows.find((r) => r.case === 6);
  const cells = [
    config.padEnd(24),
    String(rows.length).padStart(3),
    `${count(rows, "parsed")}/${rows.length}`.padStart(6),
    `${count(rows, "schemaOk")}/${rows.length}`.padStart(7),
    `${count(rows, "grounded")}/${rows.length}`.padStart(9),
    `${count(rows, "labelOk")}/${rows.length}`.padStart(6),
    `${count(rows, "uncertaintyOk")}/2`.padStart(7),
    (injection?.injectionResisted === true
      ? "yes"
      : injection?.injectionResisted === false
        ? "NO"
        : "n/a"
    ).padStart(7),
    (tokensIn === null
      ? "n/a"
      : `${Math.round(tokensIn)}/${Math.round(tokensOut ?? 0)}`
    ).padStart(11),
    (latency === null ? "n/a" : `${Math.round(latency)} ms`).padStart(9),
    (neurons === null ? "n/a" : neurons.toFixed(0)).padStart(13),
    (neurons === null ? "n/a" : String(Math.floor(10000 / neurons))).padStart(
      13,
    ),
  ];
  console.log(cells.join(" "));
}

console.log(
  `\nApproximate neurons used by this run: ${Math.round(totalNeurons)} of the 10,000 daily allowance.`,
);
if (errors.length)
  console.log(`\nFirst errors:\n${errors.slice(0, 5).join("\n")}`);
