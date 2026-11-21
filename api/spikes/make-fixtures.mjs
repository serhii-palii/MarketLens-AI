// FILE: api/spikes/make-fixtures.mjs
// Generates synthetic marketing-style pages (plus edited copies) for the CPU spike.
import { mkdirSync, writeFileSync } from "node:fs";

const outDir = new URL("./fixtures/", import.meta.url);
mkdirSync(outDir, { recursive: true });

function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const vocabulary =
  "platform pipeline revenue growth teams workflow automation analytics integration security pricing plan enterprise customers insights reporting dashboard onboarding support scale performance data campaign leads conversion attribution forecast partners ecosystem compliance reliability uptime roadmap release feature capability simple powerful flexible modern trusted global".split(
    " ",
  );

function sentence(rand) {
  const length = 8 + Math.floor(rand() * 10);
  const words = Array.from(
    { length },
    () => vocabulary[Math.floor(rand() * vocabulary.length)],
  );
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

function paragraph(rand) {
  const count = 2 + Math.floor(rand() * 3);
  return Array.from({ length: count }, () => sentence(rand)).join(" ");
}

function noiseScript(rand, bytes) {
  let out = "";
  while (out.length < bytes)
    out += `var _${Math.floor(rand() * 1e9).toString(16)}=function(a,b){return a*${Math.floor(rand() * 999)}+b;};`;
  return out;
}

function noiseCss(rand, bytes) {
  let out = "";
  while (out.length < bytes)
    out += `.c${Math.floor(rand() * 1e6).toString(36)}{margin:${Math.floor(rand() * 40)}px;padding:${Math.floor(rand() * 20)}px;color:#${Math.floor(
      rand() * 0xffffff,
    )
      .toString(16)
      .padStart(6, "0")}}`;
  return out;
}

const escapeHtml = (v) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function renderPage(blocks, rand, targetBytes) {
  const textBytes = blocks.reduce((sum, b) => sum + b.text.length + 20, 0);
  const noiseBudget = Math.max(2000, targetBytes - textBytes - 12000);
  const navLinks = Array.from(
    { length: 60 },
    (_, i) => `<li><a href="/nav/${i}">Navigation item ${i}</a></li>`,
  ).join("");
  const footerLinks = Array.from(
    { length: 100 },
    (_, i) => `<a href="/footer/${i}">Footer link ${i}</a>`,
  ).join(" ");
  const body = blocks
    .map((b) =>
      b.kind === "h"
        ? `<h2 class="h" data-id="${Math.floor(rand() * 1e9)}">${escapeHtml(b.text)}</h2>`
        : `<p class="t" data-id="${Math.floor(rand() * 1e9)}">${escapeHtml(b.text)}</p>`,
    )
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture Platform | Pricing and Plans</title>
<meta name="description" content="Synthetic fixture page for measuring extraction cost."><link rel="canonical" href="https://example.test/pricing">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Fixture"}</script>
<style>${noiseCss(rand, noiseBudget * 0.3)}</style></head><body>
<nav><ul>${navLinks}</ul></nav><main><h1>Fixture Platform</h1>
${body}
</main><footer>${footerLinks}</footer>
<script>${noiseScript(rand, noiseBudget * 0.7)}</script></body></html>`;
}

const expected = {};

for (const kb of [50, 100, 150, 250, 400, 1000]) {
  const rand = mulberry32(kb);
  const targetBytes = kb * 1024;
  const blocks = [];
  let textBytes = 0;
  let index = 0;
  while (textBytes < targetBytes * 0.45) {
    const block =
      index % 8 === 0
        ? {
            kind: "h",
            text: `Section ${index / 8 + 1}: ${sentence(rand)}`.replace(
              /\.$/,
              "",
            ),
          }
        : { kind: "p", text: paragraph(rand) };
    blocks.push(block);
    textBytes += block.text.length + 20;
    index += 1;
  }

  // Edited copy: ~3% of paragraphs revised, 5 removed, 5 added.
  const edited = [];
  let revised = 0;
  blocks.forEach((b, i) => {
    if (b.kind === "p" && i % 33 === 5) {
      edited.push({
        kind: "p",
        text:
          b.text.replace(/^[A-Za-z]+/, "Updated") + " New price $59 per month.",
      });
      revised += 1;
    } else edited.push(b);
  });
  const removedIdx = new Set();
  for (let i = 0; removedIdx.size < 5 && i < edited.length; i += 1)
    if (edited[i].kind === "p" && i % 97 === 11) removedIdx.add(i);
  const finalEdited = edited.filter((_, i) => !removedIdx.has(i));
  for (let i = 0; i < 5; i += 1)
    finalEdited.splice(10 + i * 7, 0, {
      kind: "p",
      text: `Added announcement ${i}: ${paragraph(rand)}`,
    });

  const name = `${kb}kb`;
  writeFileSync(
    new URL(`${name}.html`, outDir),
    renderPage(blocks, mulberry32(kb + 1), targetBytes),
  );
  writeFileSync(
    new URL(`${name}-edited.html`, outDir),
    renderPage(finalEdited, mulberry32(kb + 2), targetBytes),
  );
  writeFileSync(
    new URL(`${name}.txt`, outDir),
    blocks.map((b) => b.text).join("\n"),
  );
  expected[name] = {
    added: revised + 5,
    removed: revised + removedIdx.size,
    paragraphs: blocks.length,
  };
}

writeFileSync(
  new URL("expected.json", outDir),
  JSON.stringify(expected, null, 2),
);
console.log("Fixtures written:", Object.keys(expected).join(", "));
