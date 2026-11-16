# Fast marked-compatible Markdown parser

Entry for the make.fun competition **markdown-render-speed-02**.

`parse(markdown)` in `parse.js` returns exactly the HTML that
marked 18.1.3 produces with default options (GFM on), while running
faster than marked itself. `main.ts` is the grading driver: it reads
`cases.json` from the input directory, renders each case with
`parse()`, and writes `html.json` to the output directory.

## How it works

- **Block stage** — a single left-to-right scan builds block tokens
  (headings, paragraphs, lists, tables, fenced and indented code,
  blockquotes, raw HTML blocks, link reference definitions). Inline
  text is kept raw at this stage so every reference definition in the
  document is known before inline rendering starts.
- **Inline stage** — a scanner expands emphasis, strong, strikethrough,
  code spans, links, images, autolinks (including GFM bare URLs and
  emails), inline HTML, escapes and character references. Plain text
  is consumed in long runs with table-driven stop checks, and a
  length-preserving mask hides code spans, escapes and link spans from
  the delimiter searches.
- **Speed** — hand-written scanners replace the large regular
  expressions on hot paths, lazy line views avoid scanning text that
  failing matchers never reach, and small caches hold the indent
  dependent patterns used inside lists.

The parser is dependency-free: `parse.js` has no imports at all.
