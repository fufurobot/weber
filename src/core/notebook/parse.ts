/**
 * Cell parsing for the reactive notebook.
 *
 * The dependency graph is derived from source rather than declared by hand:
 * top-level bindings become a cell's exports, and free identifiers that match
 * another cell's exports become edges.
 *
 * This deliberately scans rather than fully parsing: Weber cells are small
 * snippets, and a full JS parser would add a large dependency for something a
 * scope-aware token scan handles correctly for realistic cells.
 */

export type CellKind = "code" | "markdown";

export interface ParsedCell {
  defines: string[];
  references: string[];
}

/** Reserved words and globals that must never become dependency edges. */
const NON_REFERENCES = new Set([
  // keywords / control flow
  "await", "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "enum", "export", "extends", "false",
  "finally", "for", "function", "if", "import", "in", "instanceof", "let",
  "new", "null", "of", "return", "static", "super", "switch", "this", "throw",
  "true", "try", "typeof", "var", "void", "while", "with", "yield", "async",
  "as", "from", "get", "set", "using",
  // common globals
  "console", "Math", "JSON", "Object", "Array", "String", "Number", "Boolean",
  "Promise", "Map", "Set", "WeakMap", "WeakSet", "Symbol", "Date", "RegExp",
  "Error", "TypeError", "RangeError", "SyntaxError", "Infinity", "NaN",
  "undefined", "globalThis", "window", "document", "fetch", "setTimeout",
  "setInterval", "clearTimeout", "clearInterval", "structuredClone",
  "performance", "crypto", "process", "require", "module", "exports",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "TextEncoder", "TextDecoder", "URL", "URLSearchParams",
  "BigInt", "Proxy", "Reflect", "Intl", "Atomics", "queueMicrotask",
]);

/**
 * Parse one cell into its exported bindings and free references.
 *
 * Markdown cells participate in neither direction: they are documentation.
 */
export function parseCell(code: string, kind: CellKind = "code"): ParsedCell {
  if (kind === "markdown") return { defines: [], references: [] };

  const stripped = stripCommentsAndStrings(code);
  const defines = collectDefines(stripped);
  const references = collectReferences(stripped, new Set(defines));
  return { defines, references };
}

/**
 * Remove comments and string/template/regex literals so identifiers inside
 * them are never mistaken for bindings or dependencies.
 *
 * Replaced with spaces to preserve offsets and keep tokens separated.
 */
function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];

    // line comment
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      out += " ";
      continue;
    }
    // block comment
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    // Template literal: its *text* is data, but `${...}` is code and must be
    // preserved so identifiers inside it still become dependency edges.
    if (c === "`") {
      i++;
      out += "("; // keep the emitted expression syntactically separated
      while (i < n) {
        const tc = src[i]!;
        if (tc === "\\") {
          i += 2;
          continue;
        }
        if (tc === "`") {
          i++;
          break;
        }
        if (tc === "$" && src[i + 1] === "{") {
          // Emit the interpolation's contents verbatim, minus the braces, so
          // the caller's tokenizer sees the inner expression as real code.
          i += 2;
          let depth = 1;
          const start = i;
          while (i < n && depth > 0) {
            const ic = src[i]!;
            if (ic === "\\") {
              i += 2;
              continue;
            }
            if (ic === "{") depth++;
            else if (ic === "}") {
              depth--;
              if (depth === 0) break;
            }
            i++;
          }
          out += ` ${src.slice(start, i)} `;
          i++; // consume the closing brace
          continue;
        }
        i++;
      }
      out += ")";
      continue;
    }

    // string literal
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      out += '""';
      continue;
    }
    // regex literal: only when a "/" cannot be division
    if (c === "/" && isRegexPosition(out)) {
      i++;
      let inClass = false;
      while (i < n) {
        const rc = src[i]!;
        if (rc === "\\") {
          i += 2;
          continue;
        }
        if (rc === "[") inClass = true;
        else if (rc === "]") inClass = false;
        else if (rc === "/" && !inClass) {
          i++;
          break;
        } else if (rc === "\n") {
          break; // not actually a regex
        }
        i++;
      }
      while (i < n && /[a-z]/.test(src[i]!)) i++; // flags
      out += '""';
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

/** True when a "/" at this point starts a regex rather than a division. */
function isRegexPosition(emitted: string): boolean {
  const trimmed = emitted.replace(/\s+$/, "");
  if (trimmed === "") return true;
  const last = trimmed[trimmed.length - 1]!;
  // After a value-ending token, "/" is division.
  if (/[A-Za-z0-9_$)\]]/.test(last)) return false;
  return true;
}

/**
 * Collect identifiers bound at the top level of the cell.
 *
 * Bindings inside nested braces/functions are intentionally excluded: they are
 * cell-local, so they must not become graph exports.
 */
function collectDefines(src: string): string[] {
  const defines: string[] = [];
  const seen = new Set<string>();

  const add = (name: string | undefined) => {
    if (!name) return;
    if (NON_REFERENCES.has(name)) return;
    if (seen.has(name)) return;
    seen.add(name);
    defines.push(name);
  };

  // Track brace depth; only depth 0 counts as top level.
  let depth = 0;
  const tokens = tokenize(src);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;

    if (tok.type === "punct") {
      if (tok.value === "{") depth++;
      else if (tok.value === "}") depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;

    const word = tok.value;

    // const|let|var <pattern>
    if (word === "const" || word === "let" || word === "var") {
      for (const name of readBindingPattern(tokens, i + 1)) add(name);
      continue;
    }
    // function <name>(...) / class <name>
    if (word === "function" || word === "class") {
      let j = i + 1;
      if (tokens[j]?.value === "*") j++; // generator
      if (tokens[j]?.type === "word") add(tokens[j]!.value);
      continue;
    }
    // async function <name>
    if (word === "async" && tokens[i + 1]?.value === "function") {
      let j = i + 2;
      if (tokens[j]?.value === "*") j++;
      if (tokens[j]?.type === "word") add(tokens[j]!.value);
      continue;
    }
  }

  return defines;
}

/**
 * Read the binding names from a declarator pattern, handling
 * `a = 1`, `a, b = 2` and destructuring `{ x, y: z }` / `[p, q]`.
 */
function readBindingPattern(tokens: Token[], start: number): string[] {
  const names: string[] = [];
  let i = start;
  let nesting = 0;

  for (; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.type === "punct") {
      if (tok.value === "{" || tok.value === "[") nesting++;
      else if (tok.value === "}" || tok.value === "]") {
        nesting--;
        if (nesting < 0) break;
      } else if (tok.value === ";" && nesting === 0) {
        break;
      } else if (tok.value === "=" && nesting === 0) {
        // Skip the initialiser (which may be an object literal with keys).
        i = skipInitializer(tokens, i);
        // A declarator list continues only with a top-level comma.
        if (tokens[i + 1]?.value === ",") {
          i++;
          continue;
        }
        break;
      }
      continue;
    }
    if (tok.type === "word") {
      const prev = tokens[i - 1]?.value;
      const next = tokens[i + 1]?.value;
      // `{ x, y: z }` — only the target side of a rename is bound.
      const isPropertyKey = prev !== ":" && next === ":";
      // A bare word here is a binding, or a nested destructuring target.
      if (!isPropertyKey && prev !== "." && prev !== "...") {
        if (next !== "(") names.push(tok.value);
      } else if (isPropertyKey) {
        // `{ a: b }` binds b, handled when the loop reaches it.
      }
    }
  }
  return names;
}

/** Advance past an initialiser expression, stopping at a top-level "," or ";". */
function skipInitializer(tokens: Token[], eqIndex: number): number {
  let i = eqIndex;
  let nesting = 0;
  for (i = eqIndex + 1; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.type === "punct") {
      if (tok.value === "(" || tok.value === "{" || tok.value === "[") nesting++;
      else if (tok.value === ")" || tok.value === "}" || tok.value === "]") {
        nesting--;
        if (nesting < 0) return i - 1;
      } else if (nesting === 0 && (tok.value === ";" || tok.value === ",")) {
        return i - 1;
      }
    }
  }
  return tokens.length;
}

/**
 * Free identifiers: any word that is not locally bound and not a known global.
 *
 * Locals are approximated by walking the whole cell for nested bindings too,
 * which keeps shadowed variables from creating false edges.
 */
function collectReferences(src: string, defines: Set<string>): string[] {
  const tokens = tokenize(src);
  const locals = new Set<string>([...defines, ...collectAllBindings(tokens)]);
  const refs: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.type !== "word") continue;

    const word = tok.value;
    if (NON_REFERENCES.has(word)) continue;
    if (locals.has(word)) continue;

    const prev = tokens[i - 1];
    const next = tokens[i + 1];

    // Property access, object key, or method name: not a free reference.
    if (prev?.value === ".") continue;
    if (next?.value === ":") continue;
    // `obj?.prop` optional chaining.
    if (prev?.value === "?.") continue;
    // Function/class names on their declaration.
    if (prev?.value === "function" || prev?.value === "class") continue;
    // Labels and import specifiers.
    if (next?.value === "=>" && prev?.value === "(") continue;

    if (seen.has(word)) continue;
    seen.add(word);
    refs.push(word);
  }
  return refs;
}

/** Every binding introduced anywhere in the cell, including nested scopes. */
function collectAllBindings(tokens: Token[]): string[] {
  const names: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const word = tok.value;
    if (tok.type !== "word") continue;

    if (word === "const" || word === "let" || word === "var") {
      names.push(...readBindingPattern(tokens, i + 1));
      continue;
    }
    if (word === "function" || word === "class") {
      let j = i + 1;
      if (tokens[j]?.value === "*") j++;
      if (tokens[j]?.type === "word") names.push(tokens[j]!.value);
      continue;
    }
    if (word === "async" && tokens[i + 1]?.value === "function") {
      let j = i + 2;
      if (tokens[j]?.value === "*") j++;
      if (tokens[j]?.type === "word") names.push(tokens[j]!.value);
      continue;
    }
    // Arrow function parameters: `(x, y) =>`, or `x =>`.
    if (tokens[i + 1]?.value === "=>") {
      if (word !== ")") names.push(word);
      continue;
    }
    if (word === "catch" && tokens[i + 1]?.value === "(") {
      if (tokens[i + 2]?.type === "word") names.push(tokens[i + 2]!.value);
    }
  }
  return names;
}

interface Token {
  type: "word" | "punct";
  value: string;
}

/** Split source into identifier and punctuation tokens. */
function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let start = i;
      while (i < n && /[A-Za-z0-9_$]/.test(src[i]!)) i++;
      tokens.push({ type: "word", value: src.slice(start, i) });
      continue;
    }
    if (/[0-9]/.test(c)) {
      // Numeric literal: consume so its digits never look like identifiers.
      while (i < n && /[0-9a-fA-FxXoObBeE._n]/.test(src[i]!)) i++;
      continue;
    }
    // Multi-character operators that matter for the scans above.
    const two = src.slice(i, i + 2);
    if (two === "=>" || two === "?." || two === "..." || two === "==" || two === "!=") {
      tokens.push({ type: "punct", value: two });
      i += 2;
      continue;
    }
    tokens.push({ type: "punct", value: c });
    i++;
  }
  return tokens;
}
