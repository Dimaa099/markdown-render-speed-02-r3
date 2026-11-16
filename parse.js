// parse.js — fast Markdown to HTML, byte-identical to marked 18.1.3
// with default options (GFM enabled).
//
// Approach: two stages.
//   Stage A (blocks): one left-to-right scan producing block tokens.
//     Inline source stays as raw strings on tokens, so reference
//     definitions are collected for the whole document before any
//     inline rendering happens (a use may precede its definition).
//   Stage B (render): walk block tokens, expanding inline markup.
// Both stages use hand scanners for hot paths; regexes are kept only
// where they are the clearest expression of marked's own rules.
// No imports, no shared state between parse() calls.

const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;
const ESC_RE_KEEP = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ESC_TEST_KEEP = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;

function escHtml(s, encodeAll) {
  if (encodeAll) {
    return ESC_TEST.test(s) ? s.replace(ESC_RE, (c) => ESC_MAP[c]) : s;
  }
  return ESC_TEST_KEEP.test(s) ? s.replace(ESC_RE_KEEP, (c) => ESC_MAP[c]) : s;
}

const NUMREF_RE = /&#(?:\d{1,7}|[Xx][A-Fa-f0-9]{1,6});/;
const NUMREF_OR_AMP_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function decodeNumRefs(s) {
  if (s.indexOf("&") === -1) return s;
  if (!NUMREF_RE.test(s)) return s;
  return s.replace(NUMREF_OR_AMP_RE, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return "&amp;";
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "\uFFFD";
    if (cp === 38) return "&amp;";
    return String.fromCodePoint(cp);
  });
}

function cleanHref(href) {
  try {
    return encodeURI(href).replace(/%25/g, "%");
  } catch {
    return null;
  }
}

function tailRun(s, ch) {
  let n = 0;
  for (let i = s.length - 1; i >= 0 && s[i] === ch; i--) n++;
  return n;
}

function bracketBalance(s, openCh, closeCh) {
  if (s.indexOf(openCh) === -1 && s.indexOf(closeCh) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") i++;
    else if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

function normLabel(label) {
  return label.trim().replace(/\s+/g, " ").toLowerCase().toUpperCase().toLowerCase();
}

const BACKSLASH_PUNCT_RE = /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g;

function stripEscapes(s) {
  return s.replace(BACKSLASH_PUNCT_RE, "$1");
}

function expandPrefixTabs(prefix, offset) {
  let out = "";
  let col = offset;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] === "\t") {
      const step = 4 - (col % 4);
      out += " ".repeat(step);
      col += step;
    } else {
      out += prefix[i];
      col++;
    }
  }
  return out;
}

function expandEveryTab(s, offset) {
  if (s.indexOf("\t") === -1) return s;
  let out = "";
  let col = offset;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\t") {
      const step = 4 - (col % 4);
      out += " ".repeat(step);
      col += step;
    } else {
      out += c;
      col++;
    }
  }
  return out;
}

function trimEndBlanks(raw) {
  const parts = raw.split("\n");
  let last = parts.length - 1;
  while (last >= 0 && /^[ \t]*$/.test(parts[last])) last--;
  if (parts.length - last <= 2) return raw;
  return parts.slice(0, last + 1).join("\n");
}

const BLOCK_TAGS_STR =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";

const BLOCK_TAG_HEAD_RE = new RegExp("^(?:" + BLOCK_TAGS_STR + ")(?=[ \\t]|\\n|/?>|$)");
const HTML_BLOCK_HEAD_RE = new RegExp(
  "^ {0,3}(?:</?(?:" + BLOCK_TAGS_STR + ")(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)",
  "i"
);
const BLANK_RE = /^[ \t]*$/;

// ---- inline patterns ----
const INNER_BR = "\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]";
const LABEL_IN = "\\[(?:" + INNER_BR + "|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]";
const LABEL_PAT =
  "(?:" + LABEL_IN + "|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?";
const TITLE_PAT =
  "(?:\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\\\n]|\\n(?!\\n))*'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\))";
const HREF_PAT = "<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))";
const LINK_RE = new RegExp(
  "^(!?)\\[(" + LABEL_PAT + ")\\]\\([ \\t\\n]*(" + HREF_PAT + ")(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(" + TITLE_PAT + "))?[ \\t\\n]*\\)"
);
const REFLABEL_PAT =
  "(?:[^\\[\\]\\\\`]*(?:" + LABEL_IN + "|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?";
const REFTEXT_PAT = "(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}";
const REFLINK_RE = new RegExp("^(!?)\\[(" + REFLABEL_PAT + ")\\]\\[(" + REFTEXT_PAT + ")\\]");
const NOLINK_RE = new RegExp("^(!?)\\[(" + REFTEXT_PAT + ")\\](?:\\[\\])?");
const REFLINK_SCAN_RE = new RegExp(
  "(?:!?)\\[(?:" + REFLABEL_PAT + ")\\]\\[(?:" + REFTEXT_PAT + ")\\]|(?:!?)\\[(?:" + REFTEXT_PAT + ")\\](?:\\[\\])?",
  "g"
);
const SKIP_SPAN_RE =
  /\[(?:[^\[\]`]|(`+)[^`]+\1(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(`+)[^`]+\3(?!`)|<(?! )[^<>]*?>/g;
const MASK_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const ESCAPE_RE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const CODESPAN_RE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const BR_RE = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const AUTOLINK_RE =
  /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const TAG_RE =
  /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const A_OPEN_RE = /^<a /i;
const A_CLOSE_RE = /^<\/a>/i;
const PRE_OPEN_RE = /^<(pre|code|kbd|script)(\s|>)/i;
const PRE_CLOSE_RE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const PUNCT = "[\\p{P}\\p{S}]";
const PUNCT_GFM = "(?!~)[\\p{P}\\p{S}]";
const EM_LEFT_RE = new RegExp(
  "^(?:\\*+(?:((?!\\*)" + PUNCT_GFM + ")|([^\\s*]))?)|^_+(?:((?!_)" + PUNCT_GFM + ")|([^\\s_]))?",
  "u"
);
const PUNCT_OR_SPACE_RE = /^(?![*_])[\s\p{P}\p{S}]/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;
const NPS = "[^\\s\\p{P}\\p{S}]";
const PS = "[\\s\\p{P}\\p{S}]";
const NPS_A = "(?:[^\\s\\p{P}\\p{S}]|~)";
const PS_A = "(?!~)[\\s\\p{P}\\p{S}]";
const EM_RIGHT_AST_RE = new RegExp(
  "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])" +
    "|(?!\\*)" + PUNCT_GFM + "(\\*+)(?=[\\s]|$)" +
    "|" + NPS_A + "(\\*+)(?!\\*)(?=" + PS_A + "|$)" +
    "|(?!\\*)" + PS_A + "(\\*+)(?=" + NPS_A + ")" +
    "|[\\s](\\*+)(?!\\*)(?=" + PUNCT_GFM + ")" +
    "|(?!\\*)" + PUNCT_GFM + "(\\*+)(?!\\*)(?=" + PUNCT_GFM + ")" +
    "|" + NPS_A + "(\\*+)(?=" + NPS_A + ")",
  "gu"
);
const EM_RIGHT_UND_RE = new RegExp(
  "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])" +
    "|(?!_)" + PUNCT + "(_+)(?=[\\s]|$)" +
    "|" + NPS + "(_+)(?!_)(?=" + PS + "|$)" +
    "|(?!_)" + PS + "(_+)(?=" + NPS + ")" +
    "|[\\s](_+)(?!_)(?=" + PUNCT + ")" +
    "|(?!_)" + PUNCT + "(_+)(?!_)(?=" + PUNCT + ")",
  "gu"
);
const DEL_LEFT_RE = new RegExp("^~~?(?:((?!~)" + PUNCT + ")|([^\\s~]))", "u");
const DEL_RIGHT_RE = new RegExp(
  "^[^~]+(?=[^~])|(?!~)" + PUNCT + "(~~?)(?=[\\s]|$)|" +
    NPS + "(~~?)(?!~)(?=" + PS + "|$)|(?!~)" + PS + "(~~?)(?=" + NPS + ")" +
    "|[\\s](~~?)(?!~)(?=" + PUNCT + ")|(?!~)" + PUNCT + "(~~?)(?!~)(?=" + PUNCT + ")" +
    "|" + NPS + "(~~?)(?=" + NPS + ")",
  "gu"
);
const EMAIL_LOCAL_PAT = "[a-zA-Z0-9._+-]+";
const EMAIL_DOMAIN_PAT = "[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])";
const PROTO_PAT = "(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP])";
const URL_RE = new RegExp(
  "^(?:mailto:" + EMAIL_LOCAL_PAT + "@" + EMAIL_DOMAIN_PAT +
    "|xmpp:" + EMAIL_LOCAL_PAT + "@" + EMAIL_DOMAIN_PAT + "(?:\\/[a-zA-Z0-9@.]+)?|((" +
    PROTO_PAT + "):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|(" +
    EMAIL_LOCAL_PAT + ")@(" + "[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])))"
);
const BACKPEDAL_RE = /^(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const DELIM_RUN_RE = /(?:\*+|_+|~+)/g;

function lastCloserMap(masked) {
  const last = { "*": -1, _: -1, "~": -1 };
  DELIM_RUN_RE.lastIndex = 0;
  let m;
  while ((m = DELIM_RUN_RE.exec(masked)) !== null) {
    const i = m.index;
    const prev = i === 0 ? "\n" : masked.charAt(i - 1);
    if (prev !== " " && prev !== "\t" && prev !== "\n" && prev !== "\r" && prev !== "\f") {
      last[m[0].charAt(0)] = i;
    }
  }
  return last;
}

function hasRealLink(text, refs) {
  if (text.indexOf("[") === -1) return false;
  SKIP_SPAN_RE.lastIndex = 0;
  let m;
  while ((m = SKIP_SPAN_RE.exec(text)) !== null) {
    if (LINK_RE.test(m[0]) && text.charAt(m.index - 1) !== "!") return true;
    if (m[0].length === 0) SKIP_SPAN_RE.lastIndex++;
  }
  REFLINK_SCAN_RE.lastIndex = 0;
  while ((m = REFLINK_SCAN_RE.exec(text)) !== null) {
    const s = m[0];
    const r = s.lastIndexOf("[");
    const known = Object.prototype.hasOwnProperty.call(refs, normLabel(s.slice(r + 1, -1)));
    if (s.charAt(0) !== "!" && known) {
      if (!(r > 1 && hasRealLink(s.slice(1, r - 1), refs))) return true;
    }
    if (m[0].length === 0) REFLINK_SCAN_RE.lastIndex++;
  }
  return false;
}

function makeMask(text, refs) {
  let t = text;
  if (t.indexOf("[") !== -1) {
    const maskOne = (s) => {
      const o = s.lastIndexOf("[");
      if (!Object.prototype.hasOwnProperty.call(refs, normLabel(s.slice(o + 1, -1)))) return s;
      if (o > 1 && s.charAt(0) !== "!") {
        const inner = s.slice(1, o - 1);
        if (hasRealLink(inner, refs)) {
          return "[" + inner.replace(REFLINK_SCAN_RE, maskOne) + "][" + "a".repeat(s.length - o - 2) + "]";
        }
      }
      return "[" + "a".repeat(s.length - 2) + "]";
    };
    t = t.replace(REFLINK_SCAN_RE, maskOne);
  }
  t = t.replace(MASK_RE, (whole, run, esc) => {
    if (esc !== undefined) return "+".repeat(whole.length);
    if (run !== undefined) {
      return run + whole.slice(run.length, whole.length - run.length).replace(/`/g, "+") + run;
    }
    return whole;
  });
  t = t.replace(SKIP_SPAN_RE, (whole) => "[" + "a".repeat(Math.max(0, whole.length - 2)) + "]");
  return t;
}

function codeSpanAt(src) {
  const m = CODESPAN_RE.exec(src);
  if (!m) return null;
  let text = m[2].replace(/\n/g, " ");
  if (/[^ ]/.test(text) && text.charAt(0) === " " && text.charAt(text.length - 1) === " ") {
    text = text.slice(1, -1);
  }
  return { raw: m[0], text };
}

function tagEatsBracket(src, label, offset) {
  if (label.indexOf("<") === -1) return false;
  for (let s = 0; s < label.length; s++) {
    const ch = label[s];
    if (ch === "\\") { s++; continue; }
    if (ch === "`") {
      const m = CODESPAN_RE.exec(label.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (ch !== "<") continue;
    const m = TAG_RE.exec(src.slice(offset + s)) || AUTOLINK_RE.exec(src.slice(offset + s));
    if (m) {
      if (m[0].length > label.length - s) return true;
      s += m[0].length - 1;
    }
  }
  return false;
}

function buildLink(label, href, title, raw, isImage, ctx) {
  const keepInLink = ctx.inLink;
  const keepEmitted = ctx.linkEmitted;
  const keepRaw = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const tokens = lexInline(label, ctx);
  const emitted = ctx.linkEmitted;
  ctx.linkEmitted = keepEmitted;
  ctx.inLink = keepInLink;
  if (!isImage) {
    if (emitted) {
      ctx.inRawBlock = keepRaw;
      return null;
    }
    ctx.linkEmitted = true;
  }
  return { k: isImage ? "image" : "link", raw, href, title: title ? title : null, text: label, tokens };
}

function tryInlineLink(src, ctx) {
  const m = LINK_RE.exec(src);
  if (!m) return null;
  const isImage = m[1] === "!";
  const label = m[2];
  if (tagEatsBracket(src, label, isImage ? 2 : 1)) return null;
  let raw = m[0];
  let href = m[3];
  let title = m[4];
  const cap = href.trim();
  if (cap.charAt(0) === "<") {
    if (cap.charAt(cap.length - 1) !== ">") return null;
    if (tailRun(cap.slice(0, -1), "\\") % 2 === 1) return null;
  } else {
    const bal = bracketBalance(href, "(", ")");
    if (bal === -2) return null;
    if (bal > -1) {
      const cut = (isImage ? 5 : 4) + label.length + bal;
      raw = raw.substring(0, cut).trim();
      href = href.substring(0, bal);
      title = undefined;
    }
  }
  if (tailRun(raw.slice(0, -1), "\\") % 2 === 1) return null;
  let hrefText = href.trim();
  if (hrefText.charAt(0) === "<") hrefText = hrefText.slice(1, -1);
  const titleText = title ? title.slice(1, -1) : "";
  return buildLink(label, stripEscapes(hrefText), stripEscapes(titleText), raw, isImage, ctx);
}

function tryRefLink(src, ctx) {
  let m = REFLINK_RE.exec(src);
  let label, keySrc, isImage;
  if (m) {
    isImage = m[1] === "!";
    label = m[2];
    keySrc = m[3] ? m[3] : m[2];
  } else {
    m = NOLINK_RE.exec(src);
    if (!m) return null;
    isImage = m[1] === "!";
    label = m[2];
    keySrc = m[2];
  }
  if (tagEatsBracket(src, label, isImage ? 2 : 1)) return null;
  const entry = ctx.refs[normLabel(keySrc)];
  if (!entry) {
    return { k: "text", raw: src.charAt(0), text: src.charAt(0), rawBlock: false };
  }
  return buildLink(label, entry.href, entry.title, m[0], isImage, ctx);
}

function tryTagTok(src, ctx) {
  const m = TAG_RE.exec(src);
  if (!m) return null;
  const raw = m[0];
  if (!ctx.inLink && A_OPEN_RE.test(raw)) ctx.inLink = true;
  else if (ctx.inLink && A_CLOSE_RE.test(raw)) ctx.inLink = false;
  if (!ctx.inRawBlock && PRE_OPEN_RE.test(raw)) ctx.inRawBlock = true;
  else if (ctx.inRawBlock && PRE_CLOSE_RE.test(raw)) ctx.inRawBlock = false;
  return { k: "html", raw };
}

function tryEmphasis(rem, masked, offset, prevChar, ctx, closers) {
  const m = EM_LEFT_RE.exec(rem);
  if (!m) return null;
  if (!m[1] && !m[2] && !m[3] && !m[4]) return null;
  const delim = rem.charAt(0);
  const prevIsDelim = prevChar === delim;
  let l = offset;
  while (l > 0 && masked.charAt(l - 1) === delim) l--;
  let p = "";
  if (l > 0) {
    const before = masked.slice(Math.max(0, l - 2), l);
    const cps = [...before];
    p = cps.length ? cps[cps.length - 1] : "";
  }
  const h = p === "*" || p === "_" || (p !== "" && PUNCT_OR_SPACE_RE.test(p));
  let n = prevChar;
  if (l < offset) n = p;
  const u = l < offset ? h : n !== "" && PUNCT_OR_SPACE_RE.test(n);
  if (m[4] && n !== "" && ALNUM_RE.test(n)) return null;
  const d = m[1] || m[3] || "";
  if (!(d === "" || n === "" || u)) return null;
  const runLen = [...m[0]].length - 1;
  let open = runLen;
  let extra = 0;
  const y = offset - l + runLen;
  const midWord = p.trim() !== "" && (d !== "" || (delim === "*" && !h));
  const lastCloser = closers[delim];
  const afterOpen = offset + runLen;
  if (lastCloser < afterOpen) return null;
  const rest = masked.slice(afterOpen);
  const limit = lastCloser - afterOpen;
  const search = delim === "*" ? EM_RIGHT_AST_RE : EM_RIGHT_UND_RE;
  search.lastIndex = 0;
  let s;
  while ((s = search.exec(rest)) !== null) {
    if (s.index > limit) break;
    const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
    if (!g) continue;
    let b = [...g].length;
    if (s[3] || s[4]) { open += b; continue; }
    if (s[5] || s[6] || midWord) {
      if (prevIsDelim && (s[5] || s[6])) break;
      if (y % 3 !== 0 && (y + b) % 3 === 0) { extra += b; continue; }
    }
    open -= b;
    if (open > 0) continue;
    b = Math.min(b, b + open + extra);
    const firstLen = [...s[0]][0].length;
    const raw = rem.slice(0, runLen + s.index + firstLen + b);
    if (Math.min(runLen, b) % 2 === 1) {
      const inner = raw.slice(1, -1);
      return { k: "em", raw, tokens: lexInline(inner, ctx) };
    }
    const inner = raw.slice(2, -2);
    return { k: "strong", raw, tokens: lexInline(inner, ctx) };
  }
  return null;
}

function tryStrike(rem, masked, offset, prevChar, ctx, closers) {
  const m = DEL_LEFT_RE.exec(rem);
  if (!m) return null;
  const punctAfter = m[1] || "";
  if (!(punctAfter === "" || prevChar === "" || PUNCT_OR_SPACE_RE.test(prevChar))) return null;
  const runLen = [...m[0]].length - 1;
  let open = runLen;
  const lastCloser = closers["~"];
  const afterOpen = offset + runLen;
  if (lastCloser < afterOpen) return null;
  const rest = masked.slice(afterOpen);
  const limit = lastCloser - afterOpen;
  DEL_RIGHT_RE.lastIndex = 0;
  let s;
  while ((s = DEL_RIGHT_RE.exec(rest)) !== null) {
    if (s.index > limit) break;
    const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
    if (!g) continue;
    let len = [...g].length;
    if (len !== runLen) continue;
    if (s[3] || s[4]) { open += len; continue; }
    open -= len;
    if (open > 0) continue;
    len = Math.min(len, len + open);
    const firstLen = [...s[0]][0].length;
    const raw = rem.slice(0, runLen + s.index + firstLen + len);
    const inner = raw.slice(runLen, raw.length - runLen);
    return { k: "del", raw, tokens: lexInline(inner, ctx) };
  }
  return null;
}

function tryAngleAutolink(rem) {
  const m = AUTOLINK_RE.exec(rem);
  if (!m) return null;
  const text = m[1];
  const isEmail = !/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(text);
  return {
    k: "link", raw: m[0], href: isEmail ? "mailto:" + text : text, title: null, text,
    autolink: true, tokens: [{ k: "text", raw: text, text, rawBlock: false }],
  };
}

function tryBareUrl(rem) {
  const m = URL_RE.exec(rem);
  if (!m) return null;
  if (m[3] !== undefined) {
    return {
      k: "link", raw: m[0], href: "mailto:" + m[0], title: null, text: m[0],
      autolink: true, tokens: [{ k: "text", raw: m[0], text: m[0], rawBlock: false }],
    };
  }
  let text = m[0];
  let prev;
  do {
    prev = text;
    const bp = BACKPEDAL_RE.exec(text);
    text = bp ? bp[0] : "";
  } while (prev !== text);
  if (text === "") return null;
  return {
    k: "link", raw: text, href: m[1] === "www." ? "http://" + text : text, title: null, text,
    autolink: true, tokens: [{ k: "text", raw: text, text, rawBlock: false }],
  };
}

const LOCAL_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-";
const LOCAL_TABLE = (() => {
  const t = new Uint8Array(128);
  for (let k = 0; k < LOCAL_CHARS.length; k++) t[LOCAL_CHARS.charCodeAt(k)] = 1;
  return t;
})();

function emailBegins(rem, i) {
  const at = rem.indexOf("@", i);
  if (at === -1 || at === i) return false;
  for (let j = i; j < at; j++) {
    const code = rem.charCodeAt(j);
    if (code >= 128 || LOCAL_TABLE[code] === 0) return false;
  }
  return true;
}

const STOP_TABLE = (() => {
  const t = new Uint8Array(128);
  for (const ch of ["\\", "<", "!", "[", "`", "*", "~", "_"]) t[ch.charCodeAt(0)] = 1;
  return t;
})();

function alnumCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function protoBegins(rem, i) {
  const c = rem.charAt(i);
  if (c === "h" || c === "H") {
    if (
      (rem.charAt(i + 1) === "t" || rem.charAt(i + 1) === "T") &&
      (rem.charAt(i + 2) === "t" || rem.charAt(i + 2) === "T") &&
      (rem.charAt(i + 3) === "p" || rem.charAt(i + 3) === "P")
    ) {
      let j = i + 4;
      if (rem.charAt(j) === "s" || rem.charAt(j) === "S") j++;
      return rem.charAt(j) === ":" && rem.charAt(j + 1) === "/" && rem.charAt(j + 2) === "/";
    }
    return false;
  }
  if (c === "f" || c === "F") {
    return (
      (rem.charAt(i + 1) === "t" || rem.charAt(i + 1) === "T") &&
      (rem.charAt(i + 2) === "p" || rem.charAt(i + 2) === "P") &&
      rem.charAt(i + 3) === ":" && rem.charAt(i + 4) === "/" && rem.charAt(i + 5) === "/"
    );
  }
  return false;
}

function scanText(rem, ctx) {
  const n = rem.length;
  let i;
  const c0 = rem.charAt(0);
  if (c0 === "`" || c0 === "~") {
    i = 1;
    while (i < n && rem.charAt(i) === c0) i++;
  } else {
    i = 1;
  }
  const unitEnd = i;
  let prevCode = rem.charCodeAt(i - 1);
  while (i < n) {
    const code = rem.charCodeAt(i);
    if (code < 128 && STOP_TABLE[code] === 1) break;
    if (code === 32) {
      let sp = 0;
      while (rem.charAt(i + sp) === " ") sp++;
      if (sp >= 2 && rem.charAt(i + sp) === "\n") {
        if (prevCode !== 32 || i === unitEnd) break;
        prevCode = 32;
        i++;
        continue;
      }
    } else if (code === 104 || code === 72 || code === 102 || code === 70) {
      if (protoBegins(rem, i)) break;
    } else if (code === 119 && rem.startsWith("www.", i)) {
      const prev = rem.charAt(i - 1);
      if (
        prev === "" || prev === " " || prev === "\t" || prev === "\n" || prev === "\r" ||
        prev === "\f" || prev === "\v" || prev === "*" || prev === "_" || prev === "~" || prev === "("
      ) break;
    } else if (
      (code === 109 || code === 120) &&
      (rem.startsWith("mailto:", i) || rem.startsWith("xmpp:", i)) &&
      !(i === unitEnd && unitEnd > 1) &&
      !alnumCode(prevCode)
    ) {
      break;
    }
    if (
      code < 128 && LOCAL_TABLE[code] === 1 &&
      (i === unitEnd || prevCode >= 128 || LOCAL_TABLE[prevCode] === 0) &&
      emailBegins(rem, i)
    ) break;
    prevCode = code;
    i++;
  }
  const rawText = rem.slice(0, i);
  return {
    k: "text", raw: rawText,
    text: ctx.inRawBlock ? rawText : decodeNumRefs(rawText),
    rawBlock: ctx.inRawBlock, fromText: true,
  };
}

function lexInline(src, ctx) {
  const keep = ctx.parenPossible;
  ctx.parenPossible = keep && src.indexOf(")") !== -1;
  try {
    return lexInlineInner(src, ctx);
  } finally {
    ctx.parenPossible = keep;
  }
}

function lexInlineInner(src, ctx) {
  const needsMask = src.indexOf("*") !== -1 || src.indexOf("_") !== -1 || src.indexOf("~") !== -1;
  const masked = needsMask ? makeMask(src, ctx.refs) : src;
  const closers = needsMask ? lastCloserMap(masked) : { "*": -1, _: -1, "~": -1 };
  const tokens = [];
  let pos = 0;
  let prevChar = "";
  let prevWasText = false;
  while (pos < src.length) {
    const rem = src.slice(pos);
    const effPrev = prevWasText ? prevChar : "";
    let tok = null;
    const c0 = rem.charAt(0);
    if (
      c0 !== "\\" && c0 !== "<" && c0 !== "!" && c0 !== "[" && c0 !== "`" &&
      c0 !== "*" && c0 !== "_" && c0 !== "~" && c0 !== " "
    ) {
      if (!ctx.inLink) {
        const code0 = rem.charCodeAt(0);
        if (code0 < 128 && LOCAL_TABLE[code0] === 1) tok = tryBareUrl(rem);
      }
      if (!tok) tok = scanText(rem, ctx);
    }
    if (!tok && c0 === "\\") {
      const m = ESCAPE_RE.exec(rem);
      if (m) tok = { k: "escape", raw: m[0], text: m[1] };
    }
    if (!tok && c0 === "<") tok = tryTagTok(rem, ctx);
    if (!tok && (c0 === "[" || c0 === "!")) {
      if (ctx.parenPossible) tok = tryInlineLink(rem, ctx);
      if (!tok) tok = tryRefLink(rem, ctx);
    }
    if (!tok && (c0 === "*" || c0 === "_")) tok = tryEmphasis(rem, masked, pos, effPrev, ctx, closers);
    if (!tok && c0 === "`") {
      const cs = codeSpanAt(rem);
      if (cs) tok = { k: "codespan", raw: cs.raw, text: cs.text };
    }
    if (!tok && (c0 === " " || c0 === "\\")) {
      const m = BR_RE.exec(rem);
      if (m) tok = { k: "br", raw: m[0] };
    }
    if (!tok && c0 === "~") tok = tryStrike(rem, masked, pos, effPrev, ctx, closers);
    if (!tok && c0 === "<") tok = tryAngleAutolink(rem);
    if (!tok && !ctx.inLink) {
      const code0 = rem.charCodeAt(0);
      if (code0 < 128 && LOCAL_TABLE[code0] === 1) tok = tryBareUrl(rem);
    }
    if (!tok) tok = scanText(rem, ctx);
    if (!tok || tok.raw.length === 0) {
      tok = {
        k: "text", raw: rem.charAt(0),
        text: ctx.inRawBlock ? rem.charAt(0) : decodeNumRefs(rem.charAt(0)),
        rawBlock: ctx.inRawBlock, fromText: true,
      };
    }
    tokens.push(tok);
    pos += tok.raw.length;
    if (tok.fromText) {
      prevWasText = true;
      if (!tok.raw.endsWith("_")) prevChar = tok.raw.charAt(tok.raw.length - 1);
    } else {
      prevWasText = false;
    }
  }
  return tokens;
}

function renderInlineToks(tokens, textOnly) {
  let out = "";
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.k === "text") {
      out += textOnly ? tok.text : tok.rawBlock ? tok.text : escHtml(tok.text, false);
    } else if (tok.k === "escape") {
      out += textOnly ? tok.text : escHtml(tok.text, false);
    } else if (tok.k === "html") {
      out += tok.raw;
    } else if (tok.k === "codespan") {
      out += textOnly ? tok.text : "<code>" + escHtml(tok.text, true) + "</code>";
    } else if (tok.k === "br") {
      out += textOnly ? "" : "<br>";
    } else if (tok.k === "strong") {
      out += textOnly
        ? renderInlineToks(tok.tokens, true)
        : "<strong>" + renderInlineToks(tok.tokens, false) + "</strong>";
    } else if (tok.k === "em") {
      out += textOnly
        ? renderInlineToks(tok.tokens, true)
        : "<em>" + renderInlineToks(tok.tokens, false) + "</em>";
    } else if (tok.k === "del") {
      out += textOnly
        ? renderInlineToks(tok.tokens, true)
        : "<del>" + renderInlineToks(tok.tokens, false) + "</del>";
    } else if (tok.k === "link") {
      if (textOnly) {
        out += renderInlineToks(tok.tokens, true);
      } else {
        const inner = tok.autolink ? escHtml(tok.text, true) : renderInlineToks(tok.tokens, false);
        const dest = cleanHref(tok.href);
        if (dest === null) {
          out += inner;
        } else {
          let tag = '<a href="' + escHtml(dest, tok.autolink) + '"';
          if (tok.title) tag += ' title="' + escHtml(tok.title, false) + '"';
          out += tag + ">" + inner + "</a>";
        }
      }
    } else if (tok.k === "image") {
      const alt = renderInlineToks(tok.tokens, true);
      if (textOnly) {
        out += alt;
      } else {
        const dest = cleanHref(tok.href);
        if (dest === null) {
          out += escHtml(alt, false);
        } else {
          let tag = '<img src="' + escHtml(dest, false) + '" alt="' + escHtml(alt, false) + '"';
          if (tok.title) tag += ' title="' + escHtml(tok.title, false) + '"';
          out += tag + ">";
        }
      }
    }
  }
  return out;
}

function renderInlineOnce(text, refs) {
  const ctx = { refs, inLink: false, inRawBlock: false, linkEmitted: false, parenPossible: true };
  return renderInlineToks(lexInline(text, ctx), false);
}

// ---- block patterns ----
const ANY_PUNCT_ESC_RE = /\\([\p{P}\p{S}])/gu;
const HEADING_LINE_RE = /^ {0,3}(#{1,6})(?=[ \t\n]|$)/;
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_KE_RE = /^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/;
const LIST_PARA_RE = /^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/;
const QUOTE_LINE_RE = /^ {0,3}>/;
const TABLE_DELIM_RE = /^ {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)$/;

function isBlankLine(line) {
  return BLANK_RE.test(line);
}

function isHrLine(line) {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;
  const ch = line[i];
  if (ch !== "-" && ch !== "_" && ch !== "*") return false;
  let count = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === ch) count++;
    else if (c !== " " && c !== "\t") return false;
  }
  return count >= 3;
}

function isFenceLine(line) {
  const m = FENCE_LINE_RE.exec(line);
  if (!m) return false;
  if (m[1][0] === "`" && line.indexOf("`", m[0].length) !== -1) return false;
  return true;
}

function splitRow(text, cols) {
  let markedStr = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "|") {
      let bs = 0;
      for (let p = i - 1; p >= 0 && text[p] === "\\"; p--) bs++;
      markedStr += bs % 2 === 1 ? "|" : "\x01";
    } else {
      markedStr += ch;
    }
  }
  let cells = markedStr.split("\x01");
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (cols !== undefined) {
    if (cells.length > cols) cells.splice(cols);
    while (cells.length < cols) cells.push("");
  }
  return cells.map((c) => c.trim().replace(/\\\|/g, "|"));
}

function tableHead(line1, line2) {
  if (line2 === undefined) return null;
  const h = /^ *([^\n ].*)$/.exec(line1);
  if (!h) return null;
  const d = TABLE_DELIM_RE.exec(line2);
  if (!d) return null;
  if (!/[:|]/.test(d[1])) return null;
  const delimCells = d[1].replace(/^\||\| *$/g, "").split("|");
  const aligns = delimCells.map((cell) => {
    if (/^ *-+: *$/.test(cell)) return "right";
    if (/^ *:-+: *$/.test(cell)) return "center";
    if (/^ *:-+ *$/.test(cell)) return "left";
    return null;
  });
  const header = splitRow(h[1]);
  if (header.length !== aligns.length) return null;
  return { header, aligns };
}

function takeSpace(src) {
  let pos = 0;
  while (pos < src.length) {
    const nl = src.indexOf("\n", pos);
    const lineEnd = nl === -1 ? src.length : nl;
    if (!BLANK_RE.test(src.slice(pos, lineEnd))) break;
    pos = nl === -1 ? src.length : nl + 1;
    if (nl === -1) break;
  }
  if (pos === 0) return null;
  return { raw: src.slice(0, pos), rawLen: pos };
}

function dedentCode(text) {
  return text.split("\n").map((line) => {
    const tabbed = /^ {0,3}\t/.exec(line);
    if (tabbed) return line.slice(tabbed[0].length);
    const spaced = /^ {1,4}/.exec(line);
    if (spaced) return line.slice(spaced[0].length);
    return line;
  }).join("\n");
}

function takeIndentedCode(src) {
  let pos = 0;
  let units = 0;
  while (pos < src.length) {
    let p = pos;
    let spaces = 0;
    while (src[p] === " ") { spaces++; p++; }
    let indentEnd = -1;
    if (src[p] === "\t" && spaces <= 3) indentEnd = p + 1;
    else if (spaces >= 4) indentEnd = pos + 4;
    if (indentEnd === -1) break;
    const nl = src.indexOf("\n", indentEnd);
    const lineEnd = nl === -1 ? src.length : nl;
    if (lineEnd === indentEnd) break;
    pos = lineEnd;
    units++;
    if (src[pos] === "\n") {
      let q = pos + 1;
      while (q < src.length) {
        const nl2 = src.indexOf("\n", q);
        const le = nl2 === -1 ? src.length : nl2;
        if (!BLANK_RE.test(src.slice(q, le))) break;
        q = nl2 === -1 ? src.length : nl2 + 1;
        if (nl2 === -1) break;
      }
      pos = q;
    }
  }
  if (units === 0) return null;
  const raw = src.slice(0, pos);
  return { text: dedentCode(trimEndBlanks(raw)), rawLen: pos };
}

function takeFence(src) {
  let i = 0;
  while (i < 3 && src[i] === " ") i++;
  const ch = src[i];
  if (ch !== "`" && ch !== "~") return null;
  let runEnd = i;
  while (src[runEnd] === ch) runEnd++;
  const runLen = runEnd - i;
  if (runLen < 3) return null;
  const nl = src.indexOf("\n", runEnd);
  const lineEnd = nl === -1 ? src.length : nl;
  const info = src.slice(runEnd, lineEnd);
  if (ch === "`" && info.indexOf("`") !== -1) return null;
  const indentStr = src.slice(0, i);
  const contentStart = nl === -1 ? src.length : nl + 1;
  let pos = contentStart;
  let contentEnd = src.length;
  let rawLen = src.length;
  let closed = false;
  while (pos <= src.length) {
    const lnl = src.indexOf("\n", pos);
    const le = lnl === -1 ? src.length : lnl;
    const line = src.slice(pos, le);
    let j = 0;
    while (j < 3 && line[j] === " ") j++;
    if (line[j] === ch) {
      let r = j;
      while (line[r] === ch) r++;
      if (r - j >= runLen && /^ *$/.test(line.slice(r))) {
        contentEnd = pos;
        rawLen = le;
        closed = true;
        break;
      }
    }
    if (lnl === -1) break;
    pos = lnl + 1;
  }
  if (!closed) { contentEnd = src.length; rawLen = src.length; }
  let content = src.slice(contentStart, contentEnd);
  if (content.endsWith("\n")) content = content.slice(0, -1);
  if (ch === "`" && indentStr.length > 0) {
    content = content.split("\n").map((line) => {
      const lead = /^[ \t]+/.exec(line);
      if (!lead) return line;
      return line.slice(Math.min(lead[0].length, indentStr.length));
    }).join("\n");
  }
  const lang = info.trim().replace(ANY_PUNCT_ESC_RE, "$1");
  return { text: content, lang, rawLen };
}

function takeHeading(src) {
  const nl = src.indexOf("\n");
  const line = nl === -1 ? src : src.slice(0, nl);
  const m = HEADING_LINE_RE.exec(line);
  if (!m) return null;
  let text = line.slice(m[0].length).trim();
  if (/#$/.test(text)) {
    const stripped = text.slice(0, text.length - tailRun(text, "#"));
    if (stripped === "" || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  return { tok: { t: "heading", depth: m[1].length, text }, rawLen: line.length };
}

function takeHr(src) {
  const nl = src.indexOf("\n");
  const line = nl === -1 ? src : src.slice(0, nl);
  if (!isHrLine(line)) return null;
  return { rawLen: line.length };
}

function lazyLines(src) {
  const cache = [];
  let pos = 0;
  let done = false;
  return {
    get(idx) {
      while (!done && cache.length <= idx) {
        if (pos >= src.length) { done = true; break; }
        const nl = src.indexOf("\n", pos);
        if (nl === -1) {
          cache.push({ text: src.slice(pos), start: pos, end: src.length, next: src.length });
          pos = src.length;
          done = true;
        } else {
          cache.push({ text: src.slice(pos, nl), start: pos, end: nl, next: nl + 1 });
          pos = nl + 1;
        }
      }
      return cache[idx];
    },
  };
}

function stripMarkers(text) {
  let inner = text.replace(/^( {0,3}>)([ \t]+)/gm, (whole, prefix, ws) => prefix + expandPrefixTabs(ws, prefix.length));
  inner = inner.replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, "\n    $1");
  inner = inner.replace(/^ {0,3}>[ \t]?/gm, "");
  return inner;
}

function takeBlockquote(src, ctx) {
  const lines = lazyLines(src);
  const firstLine = lines.get(0);
  if (!firstLine || !QUOTE_LINE_RE.test(firstLine.text)) return null;
  const candidate = [];
  let canLazy = false;
  for (let idx = 0; ; idx++) {
    const line = lines.get(idx);
    if (!line) break;
    if (QUOTE_LINE_RE.test(line.text)) {
      candidate.push(line);
      const content = line.text.replace(/^ {0,3}> ?/, "");
      canLazy = !BLANK_RE.test(content);
      continue;
    }
    if (!canLazy) break;
    if (line.text === "" || (BLANK_RE.test(line.text) && line.next > line.end)) break;
    if (
      isHrLine(line.text) || HEADING_LINE_RE.test(line.text) || isFenceLine(line.text) ||
      LIST_KE_RE.test(line.text) || HTML_BLOCK_HEAD_RE.test(line.text) || QUOTE_LINE_RE.test(line.text)
    ) break;
    candidate.push(line);
  }
  if (candidate.length === 0) return null;
  const toks = [];
  let idx = 0;
  while (idx < candidate.length) {
    const chunk = [];
    let seenMarker = false;
    while (idx < candidate.length) {
      const line = candidate[idx];
      const hasMarker = QUOTE_LINE_RE.test(line.text);
      if (!hasMarker && seenMarker) break;
      if (hasMarker) seenMarker = true;
      chunk.push(line);
      idx++;
    }
    const inner = stripMarkers(chunk.map((l) => l.text).join("\n"));
    lexInto(inner, { refs: ctx.refs, top: true }, true, toks);
    if (idx >= candidate.length) break;
    const lastTok = toks[toks.length - 1];
    if (!lastTok) break;
    if (lastTok.t === "code" || lastTok.t === "heading" || lastTok.t === "hr" || lastTok.t === "html" || lastTok.t === "table") break;
    if (lastTok.t === "blockquote") {
      const restLines = candidate.slice(idx);
      const combined =
        lastTok.rawText + "\n" +
        restLines.map((l) => l.text).join("\n").replace(/^ {0,3}>[ \t]?/gm, "");
      const again = takeBlockquote(combined, ctx);
      if (again && again.tok.lineCount > lastTok.lineCount) {
        toks[toks.length - 1] = again.tok;
        idx += again.tok.lineCount - lastTok.lineCount;
        continue;
      }
      break;
    }
    if (lastTok.t === "list") {
      const restLines = candidate.slice(idx);
      const combined = lastTok.rawText + "\n" + restLines.map((l) => l.text).join("\n");
      const again = takeList(combined, ctx);
      if (again) {
        let extra = 0;
        if (again.tok.rawText.length > lastTok.rawText.length) {
          extra = again.tok.rawText.slice(lastTok.rawText.length + 1).split("\n").length;
        }
        toks[toks.length - 1] = again.tok;
        idx += extra;
        continue;
      }
      break;
    }
  }
  if (idx === 0) return null;
  const rawText = candidate.slice(0, idx).map((l) => l.text).join("\n");
  return { tok: { t: "blockquote", toks, rawText, lineCount: idx }, rawLen: candidate[idx - 1].end };
}

const indentCache = new Map();

function indentRe(kind, indent) {
  const key = kind + ":" + indent;
  const hit = indentCache.get(key);
  if (hit) return hit;
  const pre = "^ {0," + Math.max(0, Math.min(3, indent - 1)) + "}";
  let re;
  if (kind === "bullet") re = new RegExp(pre + "(?:[*+-]|\\d{1,9}[.)])((?:[\\t ][^\\n]*)?(?:\\n|$))");
  else if (kind === "hr") re = new RegExp(pre + "((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)");
  else if (kind === "fence") re = new RegExp(pre + "(?:```|~~~)");
  else if (kind === "heading") re = new RegExp(pre + "#{1,6}(?:\\s|$)");
  else if (kind === "html") re = new RegExp(pre + "(?:</?(?:" + BLOCK_TAGS_STR + ")(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)", "i");
  else if (kind === "quote") re = new RegExp(pre + ">");
  else re = /$^/;
  indentCache.set(key, re);
  return re;
}

const LIST_START_RE = /^ {0,3}([*+-]|\d{1,9}[.)])([ \t][^\n]*?)?(?:\n|$)/;
const TASK_RE = /^\[[ xX]\][ \t]+\S/;
const TASK_STRIP_RE = /^\[[ xX]\][ \t]+/;
const TASK_BOX_RE = /\[[ xX]\]/;
const itemCache = new Map();

function endsDoubleBlank(s) {
  let i = s.length - 1;
  while (i >= 0 && (s[i] === " " || s[i] === "\t")) i--;
  if (i < 0 || s[i] !== "\n") return false;
  i--;
  while (i >= 0 && (s[i] === " " || s[i] === "\t")) i--;
  return i >= 0 && s[i] === "\n";
}

function takeList(src, ctx) {
  const first = LIST_START_RE.exec(src);
  if (!first) return null;
  const bullet = first[1];
  const ordered = bullet.length > 1;
  const start = ordered ? parseInt(bullet.slice(0, -1), 10) : "";
  const bulletPat = ordered ? "\\d{1,9}\\" + bullet.charAt(bullet.length - 1) : "\\" + bullet;
  let itemRe = itemCache.get(bulletPat);
  if (!itemRe) {
    itemRe = new RegExp("^( {0,3}" + bulletPat + ")((?:[\\t ][^\\n]*)?(?:\\n|$))");
    itemCache.set(bulletPat, itemRe);
  }
  const items = [];
  let rest = src;
  let loose = false;
  let pendingLoose = false;
  while (rest.length > 0) {
    if (takeHr(rest)) break;
    const m = itemRe.exec(rest);
    if (!m) break;
    const itemStart = src.length - rest.length;
    rest = rest.substring(m[0].length);
    const bulletLen = m[1].length;
    const m2nl = m[2].indexOf("\n");
    let firstLine = m2nl === -1 ? m[2] : m[2].slice(0, m2nl);
    const fl0 = firstLine.charAt(0);
    if (fl0 === " " || fl0 === "\t") {
      firstLine = firstLine.replace(/^[ \t]+/, (ws) => expandPrefixTabs(ws, bulletLen));
    }
    const blankFirst = firstLine.trim() === "";
    let indent;
    let text;
    if (blankFirst) {
      indent = bulletLen + 1;
      text = "";
    } else {
      let r = 0;
      while (firstLine.charAt(r) === " ") r++;
      if (r > 4) r = 1;
      text = firstLine.slice(r);
      indent = r + bulletLen;
    }
    let doneBlank = false;
    if (blankFirst) {
      const nl = rest.indexOf("\n");
      const nextLine = nl === -1 ? rest : rest.slice(0, nl);
      if (BLANK_RE.test(nextLine)) {
        rest = rest.substring(nextLine.length + 1);
        doneBlank = true;
      }
    }
    if (!doneBlank) {
      const bulletRe = indentRe("bullet", indent);
      const hrRe = indentRe("hr", indent);
      const fenceRe = indentRe("fence", indent);
      const headRe = indentRe("heading", indent);
      const htmlRe = indentRe("html", indent);
      const quoteRe = indentRe("quote", indent);
      let prevLine = firstLine;
      let wasBlank = blankFirst;
      while (rest.length > 0) {
        const nl = rest.indexOf("\n");
        const line = nl === -1 ? rest : rest.slice(0, nl);
        const leadCh = line.charAt(0);
        const expanded = leadCh === " " || leadCh === "\t"
          ? line.replace(/^[ \t]+/, (ws) => expandPrefixTabs(ws, 0))
          : line;
        let spaces = 0;
        while (line.charAt(spaces) === " ") spaces++;
        const c = line.charAt(spaces);
        let begins = false;
        if (spaces <= indent - 1 && c !== "") {
          if (c === "#") begins = headRe.test(line);
          else if (c === ">") begins = quoteRe.test(line);
          else if (c === "`" || c === "~") begins = fenceRe.test(line);
          else if (c === "<") begins = htmlRe.test(line);
          else if (c === "_" || c === "*") begins = hrRe.test(line) || bulletRe.test(line);
          else if (c === "-" || c === "+") begins = bulletRe.test(line) || hrRe.test(line);
          else if (c >= "0" && c <= "9") begins = bulletRe.test(line);
        }
        if (begins) break;
        let firstNonSpace = 0;
        while (expanded.charAt(firstNonSpace) === " ") firstNonSpace++;
        if (expanded.charAt(firstNonSpace) === "") firstNonSpace = -1;
        if ((firstNonSpace !== -1 && firstNonSpace >= indent) || !line.trim()) {
          text += "\n" + expanded.slice(indent);
        } else {
          if (
            wasBlank ||
            (prevLine.indexOf("\t") === -1 ? prevLine.search(/[^ ]/) : prevLine.replace(/\t/g, "    ").search(/[^ ]/)) >= 4 ||
            fenceRe.test(prevLine) || headRe.test(prevLine) || htmlRe.test(prevLine) || hrRe.test(prevLine)
          ) break;
          let add = line;
          if (/^ {0,3}(?:=+|-+) *$/.test(line) && takeSetext(prevLine + "\n" + line + "\n")) {
            add = "    " + expanded.replace(/^ {0,3}/, "");
          }
          text += "\n" + add;
        }
        wasBlank = !line.trim();
        rest = nl === -1 ? "" : rest.substring(nl + 1);
        prevLine = expanded.slice(indent);
      }
    }
    const itemRaw = src.slice(itemStart, src.length - rest.length);
    if (!loose) {
      if (pendingLoose) loose = true;
      else if (endsDoubleBlank(itemRaw)) pendingLoose = true;
    }
    items.push({ text, raw: itemRaw, task: false, checked: false, toks: null });
  }
  if (items.length === 0) return null;
  const lastItem = items[items.length - 1];
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  const consumed = src.length - rest.length;
  const rawLen = src.slice(0, consumed).trimEnd().length;
  for (const item of items) {
    item.toks = lexBlocks(item.text, { refs: ctx.refs, top: false }, false);
    if (TASK_RE.test(item.text)) item.task = true;
  }
  if (!loose) {
    for (const item of items) {
      for (const t of item.toks) {
        if (t.t === "space" && t.raw.indexOf("\n") !== t.raw.lastIndexOf("\n")) { loose = true; break; }
      }
      if (loose) break;
    }
  }
  if (loose) {
    for (const item of items) {
      for (const t of item.toks) if (t.t === "text") t.t = "paragraph";
    }
  }
  for (const item of items) {
    if (!item.task) continue;
    item.text = item.text.replace(TASK_STRIP_RE, "");
    const boxMatch = TASK_BOX_RE.exec(item.raw);
    item.checked = boxMatch ? boxMatch[0] !== "[ ]" : false;
    const firstTok = item.toks[0];
    if (firstTok && (firstTok.t === "text" || firstTok.t === "paragraph")) {
      firstTok.text = firstTok.text.replace(TASK_STRIP_RE, "");
      if (loose) { firstTok.checkbox = item.checked; continue; }
    } else if (loose) {
      item.toks.unshift({ t: "paragraph", text: "", checkbox: item.checked, checkboxOnly: true });
      continue;
    }
    item.toks.unshift({ t: "checkbox", checked: item.checked });
  }
  const listRawText = src.slice(0, rawLen);
  return {
    tok: { t: "list", ordered, start, loose, items, rawText: listRawText, lineCount: listRawText.split("\n").length },
    rawLen,
  };
}

const SCRIPT_HEAD_RE = /^ {0,3}<(script|pre|style|textarea)[\s>]/i;
const COMMENT_HEAD_RE = /^ {0,3}<!--/;
const PI_HEAD_RE = /^ {0,3}<\?/;
const DECL_HEAD_RE = /^ {0,3}<![A-Z]/;
const CDATA_HEAD_RE = /^ {0,3}<!\[CDATA\[/;
const BLOCKTAG_HEAD_RE = new RegExp("^ {0,3}</?(" + BLOCK_TAGS_STR + ")(?: +|\\n|/?>|$)", "i");
const ANYTAG_HEAD_RE = new RegExp(
  "^ {0,3}<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *\"[^\"\\n]*\"| *= *'[^'\\n]*'| *= *[^\\s\"'=<>`]+)?)*? */?>(?=[ \\t]*(?:\\n|$))",
  "i"
);
const CLOSETAG_HEAD_RE = /^ {0,3}<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))/i;
const BLANKRUN_RE = /(?:\n[ \t]*)+\n/;

function toBlankLine(src) {
  const m = BLANKRUN_RE.exec(src);
  return m ? m.index + m[0].length : src.length;
}

function takeHtmlBlock(src) {
  let m;
  if ((m = SCRIPT_HEAD_RE.exec(src))) {
    const tag = m[1].toLowerCase();
    const lower = src.toLowerCase();
    const closeIdx = lower.indexOf("</" + tag, m[0].length);
    let raw;
    if (closeIdx === -1) {
      raw = src;
    } else {
      const nl = src.indexOf("\n", closeIdx);
      const lineEnd = nl === -1 ? src.length : nl;
      let end = lineEnd;
      while (src[end] === "\n") end++;
      raw = src.slice(0, end);
    }
    const text = trimEndBlanks(raw);
    return { text, rawLen: text.length, pre: tag !== "textarea" };
  }
  if (COMMENT_HEAD_RE.test(src)) {
    let end;
    if (src.startsWith("<!-->", src.indexOf("<!--"))) {
      end = src.indexOf("<!-->") + 5;
    } else {
      const close = src.indexOf("-->", 4);
      end = close === -1 ? src.length : close + 3;
    }
    const nl = src.indexOf("\n", end);
    const lineEnd = nl === -1 ? src.length : nl;
    let stop = lineEnd;
    while (src[stop] === "\n") stop++;
    const raw = src.slice(0, stop);
    const text = trimEndBlanks(raw);
    return { text, rawLen: text.length, pre: false };
  }
  if (PI_HEAD_RE.test(src)) {
    const close = src.indexOf("?>", 2);
    let raw;
    if (close === -1) raw = src;
    else {
      const nl = src.indexOf("\n", close + 2);
      const lineEnd = nl === -1 ? src.length : nl;
      let stop = lineEnd;
      while (src[stop] === "\n") stop++;
      raw = src.slice(0, stop);
    }
    const text = trimEndBlanks(raw);
    return { text, rawLen: text.length, pre: false };
  }
  if (CDATA_HEAD_RE.test(src)) {
    const close = src.indexOf("]]>", 2);
    let raw;
    if (close === -1) raw = src;
    else {
      const nl = src.indexOf("\n", close + 3);
      const lineEnd = nl === -1 ? src.length : nl;
      let stop = lineEnd;
      while (src[stop] === "\n") stop++;
      raw = src.slice(0, stop);
    }
    const text = trimEndBlanks(raw);
    return { text, rawLen: text.length, pre: false };
  }
  if (DECL_HEAD_RE.test(src)) {
    const close = src.indexOf(">", 2);
    let raw;
    if (close === -1) raw = src;
    else {
      const nl = src.indexOf("\n", close + 1);
      const lineEnd = nl === -1 ? src.length : nl;
      let stop = lineEnd;
      while (src[stop] === "\n") stop++;
      raw = src.slice(0, stop);
    }
    const text = trimEndBlanks(raw);
    return { text, rawLen: text.length, pre: false };
  }
  if (BLOCKTAG_HEAD_RE.test(src) || ANYTAG_HEAD_RE.test(src) || CLOSETAG_HEAD_RE.test(src)) {
    const raw = src.slice(0, toBlankLine(src));
    const text = trimEndBlanks(raw);
    return { text, rawLen: text.length, pre: false };
  }
  return null;
}

function takeDef(src) {
  let i = 0;
  while (i < 3 && src[i] === " ") i++;
  if (src[i] !== "[") return null;
  if (/^\s*\]/.test(src.slice(i + 1))) return null;
  let j = i + 1;
  let labelEnd = -1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === "\\") { j += 2; continue; }
    if (ch === "[") return null;
    if (ch === "]") { labelEnd = j; break; }
    if (ch === "\n") {
      let k = j + 1;
      while (src[k] === " " || src[k] === "\t") k++;
      if (k >= src.length || src[k] === "\n") return null;
    }
    j++;
  }
  if (labelEnd === -1) return null;
  const label = src.slice(i + 1, labelEnd);
  if (label.length === 0) return null;
  j = labelEnd + 1;
  if (src[j] !== ":") return null;
  j++;
  while (src[j] === " ") j++;
  if (src[j] === "\n") {
    j++;
    while (src[j] === " " || src[j] === "\t") j++;
  }
  let hrefRaw;
  if (src[j] === "<") {
    let k = j + 1;
    while (k < src.length && src[k] !== ">" && src[k] !== "\n") k++;
    if (src[k] !== ">") return null;
    hrefRaw = src.slice(j, k + 1);
    j = k + 1;
  } else {
    if (j >= src.length || /[\s<]/.test(src[j])) return null;
    let k = j;
    while (k < src.length && !/\s/.test(src[k])) k++;
    hrefRaw = src.slice(j, k);
    j = k;
    if (bracketBalance(hrefRaw, "(", ")") !== -1) return null;
  }
  const afterHref = j;
  let titleRaw;
  {
    let k = j;
    while (src[k] === " ") k++;
    let separated = k > j;
    if (src[k] === "\n") {
      separated = true;
      k++;
      while (src[k] === " " || src[k] === "\t") k++;
    }
    if (separated && (src[k] === '"' || src[k] === "'" || src[k] === "(")) {
      const open = src[k];
      const close = open === "(" ? ")" : open;
      let e = k + 1;
      let ok = false;
      while (e < src.length) {
        const ch = src[e];
        if (ch === "\\") { e += 2; continue; }
        if (open === "(" && ch === "(") break;
        if (open === "'" && ch === "\n") {
          const q = e + 1;
          if (src[q] === "\n") break;
        }
        if (ch === close) { ok = true; break; }
        e++;
      }
      if (ok) { titleRaw = src.slice(k, e + 1); j = e + 1; }
    }
  }
  while (src[j] === " ") j++;
  if (j < src.length && src[j] !== "\n") {
    if (titleRaw === undefined) return null;
    titleRaw = undefined;
    j = afterHref;
    while (src[j] === " ") j++;
    if (j < src.length && src[j] !== "\n") return null;
  }
  const href = hrefRaw.replace(/^<(.*)>$/, "$1").replace(ANY_PUNCT_ESC_RE, "$1");
  const title = titleRaw ? titleRaw.slice(1, -1).replace(ANY_PUNCT_ESC_RE, "$1") : undefined;
  return { tag: normLabel(label), href, title, rawText: src.slice(0, j), rawLen: j };
}

function takeTable(src) {
  const lines = lazyLines(src);
  const line0 = lines.get(0);
  const line1 = lines.get(1);
  if (!line0 || !line1) return null;
  const head = tableHead(line0.text, line1.text);
  if (!head) return null;
  const rows = [];
  let rawLen = line1.end;
  for (let idx = 2; ; idx++) {
    const lineObj = lines.get(idx);
    if (!lineObj) break;
    const line = lineObj.text;
    if (/^ *$/.test(line)) break;
    if (
      isHrLine(line) || HEADING_LINE_RE.test(line) || QUOTE_LINE_RE.test(line) ||
      isFenceLine(line) || LIST_KE_RE.test(line) || HTML_BLOCK_HEAD_RE.test(line) ||
      /^(?: {4}| {0,3}\t)[^\n]/.test(line)
    ) break;
    rows.push(splitRow(line, head.header.length));
    rawLen = lineObj.end;
  }
  return { tok: { t: "table", head: head.header, aligns: head.aligns, rows }, rawLen };
}

function takeSetext(src) {
  const lines = lazyLines(src);
  const line0 = lines.get(0);
  if (!line0 || !lines.get(1)) return null;
  const first = line0.text;
  if (isBlankLine(first)) return null;
  if (
    LIST_KE_RE.test(first) || /^(?: {4}| {0,3}\t)/.test(first) || isFenceLine(first) ||
    QUOTE_LINE_RE.test(first) || HEADING_LINE_RE.test(first) ||
    /^ {0,3}<[^\n>]+>$/.test(first) || /^ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*$/.test(first)
  ) return null;
  const textLines = [first];
  for (let idx = 1; ; idx++) {
    const lineObj = lines.get(idx);
    if (!lineObj) break;
    const line = lineObj.text;
    const um = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (um) {
      const text = textLines.join("\n").trim();
      return { tok: { t: "heading", depth: um[1][0] === "=" ? 1 : 2, text }, rawLen: lineObj.end };
    }
    const nextObj = lines.get(idx + 1);
    if (
      isBlankLine(line) || isHrLine(line) || HEADING_LINE_RE.test(line) || QUOTE_LINE_RE.test(line) ||
      isFenceLine(line) || LIST_KE_RE.test(line) || /^ {0,3}<[^\n>]+>$/.test(line) ||
      tableHead(line, nextObj ? nextObj.text : undefined)
    ) return null;
    textLines.push(line);
  }
  return null;
}

// Loose table shape used only for paragraph interruption: marked's
// paragraph pattern embeds the table *regex* (header line plus a
// delimiter-shaped line), which does not verify that the header and
// delimiter cell counts agree — the strict check lives in the table
// tokeniser itself. A mismatched pair therefore still ends the
// paragraph, and the lines are then lexed on their own.
function looseTableBreak(line, nextLine) {
  if (nextLine === undefined) return false;
  if (!/^ *([^\n ].*)$/.test(line)) return false;
  return TABLE_DELIM_RE.test(nextLine);
}

function takeParagraph(src) {
  const lines = lazyLines(src);
  const line0 = lines.get(0);
  if (!line0 || isBlankLine(line0.text)) return null;
  const textLines = [line0.text];
  let rawLen = line0.end;
  for (let idx = 1; ; idx++) {
    const line = lines.get(idx);
    if (!line) break;
    if (line.text === "") break;
    if (BLANK_RE.test(line.text) && line.next > line.end) break;
    const lineText = line.text;
    const nextObj = lines.get(idx + 1);
    if (
      isHrLine(lineText) || HEADING_LINE_RE.test(lineText) || QUOTE_LINE_RE.test(lineText) ||
      isFenceLine(lineText) || LIST_PARA_RE.test(lineText) || HTML_BLOCK_HEAD_RE.test(lineText) ||
      looseTableBreak(lineText, nextObj ? nextObj.text : undefined)
    ) break;
    textLines.push(lineText);
    rawLen = line.end;
  }
  return { tok: { t: "paragraph", text: textLines.join("\n") }, rawLen };
}

function lexBlocks(src, ctx, mergePara) {
  const toks = [];
  lexInto(src, ctx, mergePara, toks);
  return toks;
}

// Character after up to three leading spaces — the position every
// block opener anchors on. Matchers whose opener character differs
// can be skipped without running their patterns at all.
function headChar(src) {
  let i = 0;
  while (i < 3 && src[i] === " ") i++;
  return src[i];
}

function lexInto(src, ctx, mergePara, toks) {
  let rest = src;
  while (rest.length > 0) {
    const sp = takeSpace(rest);
    if (sp) {
      rest = rest.slice(sp.rawLen);
      if (sp.raw.length === 1 && toks.length > 0) {
        const prevTok = toks[toks.length - 1];
        if (prevTok.rawText !== undefined) {
          prevTok.rawText += "\n";
          prevTok.lineCount = prevTok.rawText.split("\n").length;
        }
      } else {
        toks.push({ t: "space", raw: sp.raw });
      }
      continue;
    }
    const prev = toks[toks.length - 1];
    const hc = headChar(rest);
    const code = rest[0] === " " || rest[0] === "\t" ? takeIndentedCode(rest) : null;
    if (code) {
      rest = rest.slice(code.rawLen);
      if (prev && (prev.t === "paragraph" || prev.t === "text")) prev.text += "\n" + code.text;
      else toks.push({ t: "code", text: code.text, lang: "" });
      continue;
    }
    const fence = hc === "`" || hc === "~" ? takeFence(rest) : null;
    if (fence) {
      rest = rest.slice(fence.rawLen);
      toks.push({ t: "code", text: fence.text, lang: fence.lang });
      continue;
    }
    const heading = hc === "#" ? takeHeading(rest) : null;
    if (heading) {
      rest = rest.slice(heading.rawLen);
      toks.push(heading.tok);
      continue;
    }
    const hr = hc === "-" || hc === "_" || hc === "*" ? takeHr(rest) : null;
    if (hr) {
      rest = rest.slice(hr.rawLen);
      toks.push({ t: "hr" });
      continue;
    }
    const bq = hc === ">" ? takeBlockquote(rest, ctx) : null;
    if (bq) {
      rest = rest.slice(bq.rawLen);
      toks.push(bq.tok);
      continue;
    }
    const list =
      hc === "*" || hc === "+" || hc === "-" || (hc >= "0" && hc <= "9")
        ? takeList(rest, ctx)
        : null;
    if (list) {
      rest = rest.slice(list.rawLen);
      toks.push(list.tok);
      continue;
    }
    const html = hc === "<" ? takeHtmlBlock(rest) : null;
    if (html) {
      rest = rest.slice(html.rawLen);
      toks.push({ t: "html", text: html.text });
      continue;
    }
    const def = hc === "[" ? takeDef(rest) : null;
    if (def) {
      rest = rest.slice(def.rawLen);
      if (prev && (prev.t === "paragraph" || prev.t === "text")) {
        prev.text += "\n" + def.rawText;
      } else {
        if (!Object.prototype.hasOwnProperty.call(ctx.refs, def.tag)) {
          ctx.refs[def.tag] = { href: def.href, title: def.title };
        }
        toks.push({ t: "def" });
      }
      continue;
    }
    const table = takeTable(rest);
    if (table) {
      rest = rest.slice(table.rawLen);
      toks.push(table.tok);
      continue;
    }
    const lheading = takeSetext(rest);
    if (lheading) {
      rest = rest.slice(lheading.rawLen);
      toks.push(lheading.tok);
      continue;
    }
    if (ctx.top) {
      const para = takeParagraph(rest);
      if (para) {
        rest = rest.slice(para.rawLen);
        if (mergePara && prev && prev.t === "paragraph") prev.text += "\n" + para.tok.text;
        else toks.push(para.tok);
        continue;
      }
    }
    const nl = rest.indexOf("\n");
    const line = nl === -1 ? rest : rest.slice(0, nl);
    if (line.length === 0) { rest = rest.slice(1); continue; }
    rest = rest.slice(line.length);
    if (prev && prev.t === "text") prev.text += "\n" + line;
    else toks.push({ t: "text", text: line });
  }
}

function checkboxHtmlStr(checked) {
  return "<input " + (checked ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
}

function renderBlocks(toks, shared) {
  let out = "";
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (tok.t === "space" || tok.t === "def") {
      continue;
    } else if (tok.t === "hr") {
      out += "<hr>\n";
    } else if (tok.t === "heading") {
      out += "<h" + tok.depth + ">" + renderShared(tok.text, shared) + "</h" + tok.depth + ">\n";
    } else if (tok.t === "code") {
      const firstWord = (tok.lang || "").match(/^\S*/)[0];
      let body = tok.text ? tok.text.replace(/\n$/, "") + "\n" : "";
      body = escHtml(body, true);
      out += firstWord
        ? '<pre><code class="language-' + escHtml(firstWord, false) + '">' + body + "</code></pre>\n"
        : "<pre><code>" + body + "</code></pre>\n";
    } else if (tok.t === "blockquote") {
      out += "<blockquote>\n" + renderBlocks(tok.toks, shared) + "</blockquote>\n";
    } else if (tok.t === "list") {
      const tag = tok.ordered ? "ol" : "ul";
      const startAttr = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : "";
      out += "<" + tag + startAttr + ">\n";
      for (const item of tok.items) out += "<li>" + renderBlocks(item.toks, shared) + "</li>\n";
      out += "</" + tag + ">\n";
    } else if (tok.t === "checkbox") {
      out += checkboxHtmlStr(tok.checked);
    } else if (tok.t === "html") {
      out += tok.text;
    } else if (tok.t === "paragraph") {
      out += "<p>" + (tok.checkbox !== undefined ? checkboxHtmlStr(tok.checkbox) : "") + renderShared(tok.text, shared) + "</p>\n";
    } else if (tok.t === "text") {
      out += renderShared(tok.text, shared);
    } else if (tok.t === "table") {
      out += "<table>\n<thead>\n<tr>\n";
      for (let ci = 0; ci < tok.head.length; ci++) {
        const align = tok.aligns[ci];
        out += align ? '<th align="' + align + '">' : "<th>";
        out += renderShared(tok.head[ci], shared);
        out += "</th>\n";
      }
      out += "</tr>\n</thead>\n";
      if (tok.rows.length > 0) {
        out += "<tbody>";
        for (const row of tok.rows) {
          out += "<tr>\n";
          for (let ci = 0; ci < row.length; ci++) {
            const align = tok.aligns[ci];
            out += align ? '<td align="' + align + '">' : "<td>";
            out += renderShared(row[ci], shared);
            out += "</td>\n";
          }
          out += "</tr>\n";
        }
        out += "</tbody>";
      }
      out += "</table>\n";
    }
  }
  return out;
}

function renderShared(text, shared) {
  shared.inRawBlock = false;
  return renderInlineToks(lexInline(text, shared), false);
}

export function parse(markdown) {
  const src = markdown.replace(/\r\n|\r/g, "\n");
  const refs = {};
  const toks = lexBlocks(src, { refs, top: true }, false);
  const shared = { refs, inLink: false, inRawBlock: false, linkEmitted: false, parenPossible: true };
  return renderBlocks(toks, shared);
}
