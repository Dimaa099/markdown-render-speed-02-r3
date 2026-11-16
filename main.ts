// Driver for the markdown-render-speed-02 entry.
// The harness runs `node main.ts`: read every case from the input
// directory's cases.json (an array of {id, markdown}), render each
// case on its own with parse() from ./parse.js, and write the HTML
// strings, in order, as JSON to the output directory's html.json.
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR override /input and /output
// when running outside the grading container.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as { id: string; markdown: string }[];
const html: string[] = [];
for (const entry of cases) {
  html.push(parse(entry.markdown));
}
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
