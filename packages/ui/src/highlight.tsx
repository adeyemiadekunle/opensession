import type { ReactNode } from "react";

/**
 * Tiny syntax highlighter for the file viewer: one regex pass per line, tracking
 * multi-line blocks (comments, triple-quoted strings) across lines. It colours
 * comments, strings, numbers and keywords — no parse tree, so it's forgiving.
 */

export interface Token {
  text: string;
  cls?: string;
}

interface Block {
  start: string;
  end: string;
  cls: string;
}

interface LangSpec {
  /** Line-comment prefixes, e.g. "//", "#". */
  line?: string[];
  /** Blocks that may span lines. */
  block?: Block[];
  /** Space-separated keyword list. */
  kw?: string;
  /** Set false to skip string literals. */
  strings?: boolean;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const words = (s: string) => `\\b(?:${s.split(" ").join("|")})\\b`;

const JS_KW =
  "abstract as async await break case catch class const continue declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface let module namespace new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while yield";
const PY_KW =
  "False None True and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield";
const GO_KW =
  "break case chan const continue default defer else fallthrough false for func go goto if import interface map nil package range return select struct switch true type var";
const RS_KW =
  "Self as async await box break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self static struct super trait true type unsafe use where while";
const SH_KW = "case do done echo elif else esac eval exec export fi for function if in local readonly return select set shift source then trap until while";
const SQL_KW =
  "alter and as between by case create delete drop else from group having in index inner insert into is join left limit not null on or order outer right select set table union update values view when where";
const GQL_KW = "directive enum extend fragment implements input interface mutation on query scalar schema subscription type union";
const DOCKER_KW = "ADD ARG CMD COPY ENTRYPOINT ENV EXPOSE FROM HEALTHCHECK LABEL ONBUILD RUN SHELL STOPSIGNAL USER VOLUME WORKDIR";

const C_COMMENT = { start: "/*", end: "*/", cls: "tok-com" };
const JSX_COMMENT = { start: "{/*", end: "*/}", cls: "tok-com" };
const HTML_COMMENT = { start: "<!--", end: "-->", cls: "tok-com" };

const LANGS: Record<string, LangSpec> = {
  bash: { line: ["#"], kw: SH_KW },
  cjs: { line: ["//"], block: [C_COMMENT], kw: JS_KW },
  css: { block: [C_COMMENT] },
  dockerfile: { line: ["#"], kw: DOCKER_KW },
  env: { line: ["#"] },
  go: { line: ["//"], block: [C_COMMENT], kw: GO_KW },
  gql: { line: ["#"], kw: GQL_KW },
  graphql: { line: ["#"], kw: GQL_KW },
  html: { block: [HTML_COMMENT] },
  ini: { line: ["#", ";"] },
  js: { line: ["//"], block: [C_COMMENT], kw: JS_KW },
  json: { kw: "false null true" },
  jsx: { line: ["//"], block: [JSX_COMMENT, C_COMMENT], kw: JS_KW },
  mjs: { line: ["//"], block: [C_COMMENT], kw: JS_KW },
  py: {
    line: ["#"],
    block: [
      { start: '"""', end: '"""', cls: "tok-str" },
      { start: "'''", end: "'''", cls: "tok-str" },
    ],
    kw: PY_KW,
  },
  rs: { line: ["//"], block: [C_COMMENT], kw: RS_KW },
  sh: { line: ["#"], kw: SH_KW },
  sql: { line: ["--"], kw: SQL_KW },
  svg: { block: [HTML_COMMENT] },
  toml: { line: ["#"] },
  ts: { line: ["//"], block: [C_COMMENT], kw: JS_KW },
  tsx: { line: ["//"], block: [JSX_COMMENT, C_COMMENT], kw: JS_KW },
  vue: { line: ["//"], block: [C_COMMENT, HTML_COMMENT], kw: JS_KW },
  xml: { block: [HTML_COMMENT] },
  yaml: { line: ["#"] },
  yml: { line: ["#"] },
  zsh: { line: ["#"], kw: SH_KW },
};

const STR_SRC = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|` + "`(?:[^`\\\\]|\\\\.)*`";
const NUM_SRC = String.raw`\b(?:0x[\da-fA-F_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)\b`;

type Kind = "line" | "block" | "str" | "kw" | "num";

interface Compiled {
  re: RegExp;
  /** Kind of each capture group, in order (group 1 = kinds[0]). */
  kinds: Kind[];
  blocks: Block[];
}

function compile(spec: LangSpec): Compiled {
  const parts: { src: string; kind: Kind }[] = [];
  if (spec.line?.length) parts.push({ src: `(${spec.line.map(esc).join("|")}).*`, kind: "line" });
  if (spec.block?.length) parts.push({ src: `(${spec.block.map((b) => esc(b.start)).join("|")})`, kind: "block" });
  if (spec.strings !== false) parts.push({ src: `(${STR_SRC})`, kind: "str" });
  if (spec.kw) parts.push({ src: `(${words(spec.kw)})`, kind: "kw" });
  parts.push({ src: `(${NUM_SRC})`, kind: "num" });
  return { re: new RegExp(parts.map((p) => p.src).join("|"), "g"), kinds: parts.map((p) => p.kind), blocks: spec.block ?? [] };
}

const compiled = new Map<string, Compiled>();

export function extOf(path: string): string | undefined {
  const name = path.split("/").pop() ?? "";
  if (/^dockerfile$/i.test(name)) return "dockerfile";
  if (/^\.env/.test(name)) return "env";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined;
}

/** The token runs of one line. `carry` is the still-open block from the previous line. */
function lineTokens(line: string, c: Compiled, carry: { end: string; cls: string } | null, out: Token[]): { end: string; cls: string } | null {
  let pos = 0;
  if (carry) {
    const end = line.indexOf(carry.end);
    if (end < 0) {
      out.push({ text: line, cls: carry.cls });
      return carry;
    }
    out.push({ text: line.slice(0, end + carry.end.length), cls: carry.cls });
    pos = end + carry.end.length;
  }
  const { re } = c;
  re.lastIndex = pos;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > pos) out.push({ text: line.slice(pos, m.index) });
    let gi = 1;
    while (m[gi] === undefined) gi += 1;
    const kind = c.kinds[gi - 1];
    if (kind === "line") {
      out.push({ text: line.slice(m.index), cls: "tok-com" });
      return null;
    }
    if (kind === "block") {
      const b = c.blocks.find((b) => line.startsWith(b.start, m!.index))!;
      const end = line.indexOf(b.end, m.index + m[0].length);
      if (end < 0) {
        out.push({ text: line.slice(m.index), cls: b.cls });
        return { end: b.end, cls: b.cls };
      }
      out.push({ text: line.slice(m.index, end + b.end.length), cls: b.cls });
      pos = end + b.end.length;
      re.lastIndex = pos;
      continue;
    }
    out.push({ text: m[0], cls: kind === "str" ? "tok-str" : kind === "kw" ? "tok-kw" : "tok-num" });
    pos = re.lastIndex;
    if (m[0].length === 0) re.lastIndex += 1;
  }
  if (pos < line.length) out.push({ text: line.slice(pos) });
  return null;
}

/** Tokenises `text` for the file at `path`; unknown types come back uncoloured. */
export function highlight(text: string, path: string): Token[][] {
  const ext = extOf(path);
  const spec = ext ? LANGS[ext] : undefined;
  if (!spec) return text.split("\n").map((l) => [{ text: l }]);
  let c = compiled.get(ext!);
  if (!c) {
    c = compile(spec);
    compiled.set(ext!, c);
  }
  let carry: { end: string; cls: string } | null = null;
  return text.split("\n").map((line) => {
    const out: Token[] = [];
    carry = lineTokens(line, c!, carry, out);
    return out;
  });
}

/** Token runs as React spans, one inner array per line. */
export function highlightedLines(text: string, path: string): ReactNode[][] {
  return highlight(text, path).map((line) => line.map((t, i) => (t.cls ? <span key={i} className={t.cls}>{t.text}</span> : t.text)));
}
