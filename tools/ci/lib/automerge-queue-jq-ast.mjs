import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const JQ_KEYWORDS_BEFORE_PAREN = new Set([
  "if",
  "then",
  "elif",
  "else",
  "and",
  "or",
  "try",
  "catch",
  "reduce",
  "foreach",
]);

function resolveJqBinary() {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, "jq");
    if (existsSync(candidate)) return candidate;
  }
  for (const fallback of ["/opt/homebrew/bin/jq", "/usr/bin/jq"]) {
    if (existsSync(fallback)) return fallback;
  }
  return "jq";
}

function scanStringChar(chars, index, state) {
  const ch = chars[index];
  if (ch !== "\\") {
    state.masked.push(" ");
    if (ch === '"') state.inString = false;
    return index;
  }
  if (index + 1 >= chars.length) {
    state.error = "unterminated string escape";
    return index;
  }
  state.masked.push(" ", " ");
  if (chars[index + 1] === "(") {
    state.parenStack.push({ index: index + 1, kind: "interp" });
    state.inString = false;
  }
  return index + 1;
}

function skipJqComment(chars, startIndex, masked) {
  let cursor = startIndex;
  while (cursor < chars.length && chars[cursor] !== "\n") {
    masked.push(" ");
    cursor += 1;
  }
  if (cursor < chars.length) masked.push("\n");
  return cursor;
}

function bracketPop(state, ch, index) {
  const open = state.bracketStack.pop();
  if (!open || open.close !== ch) {
    state.error = `unmatched '${ch}' at offset ${index}`;
    return null;
  }
  return open;
}

function handleDelimiterChar(ch, index, state) {
  if (ch === "(") {
    state.parenStack.push({ index, kind: "group" });
    state.masked.push("(");
    return true;
  }
  if (ch === ")") {
    const open = state.parenStack.pop();
    if (!open) {
      state.error = `unmatched ')' at offset ${index}`;
      return true;
    }
    state.allEnclosingSpans.push([open.index, index]);
    if (open.kind === "interp") {
      state.masked.push(" ");
      state.inString = true;
    } else {
      state.groupingOpenToClose.set(open.index, index);
      state.groupingCloseToOpen.set(index, open.index);
      state.masked.push(")");
    }
    return true;
  }
  if (ch === "[" || ch === "{") {
    state.bracketStack.push({ index, close: ch === "[" ? "]" : "}" });
    state.masked.push(ch);
    return true;
  }
  if (ch === "]" || ch === "}") {
    const open = bracketPop(state, ch, index);
    if (!open) return true;
    state.bracketOpenToClose.set(open.index, index);
    state.masked.push(ch);
    return true;
  }
  return false;
}

function maskJqSyntax(program) {
  const chars = [...program];
  const state = {
    groupingOpenToClose: new Map(),
    groupingCloseToOpen: new Map(),
    allEnclosingSpans: [],
    parenStack: [],
    bracketStack: [],
    bracketOpenToClose: new Map(),
    masked: [],
    inString: false,
    error: null,
  };

  for (let index = 0; index < chars.length && !state.error; index += 1) {
    const ch = chars[index];
    if (state.inString) {
      index = scanStringChar(chars, index, state);
    } else if (ch === '"') {
      state.masked.push(" ");
      state.inString = true;
    } else if (ch === "#") {
      index = skipJqComment(chars, index, state.masked);
    } else if (!handleDelimiterChar(ch, index, state)) {
      state.masked.push(ch);
    }
  }

  if (state.error) return { ok: false, reason: state.error };
  if (state.inString) return { ok: false, reason: "unterminated string literal" };
  if (state.parenStack.length > 0) {
    return { ok: false, reason: `unclosed '(' at offset ${state.parenStack.at(-1).index}` };
  }
  if (state.bracketStack.length > 0) {
    return { ok: false, reason: `unclosed bracket at offset ${state.bracketStack.at(-1).index}` };
  }
  return { ok: true, text: state.masked.join(""), ...state };
}

function prevNonSpace(text, from) {
  let cursor = from;
  while (cursor >= 0 && /\s/.test(text[cursor])) cursor -= 1;
  return cursor;
}

function nextNonSpace(text, from) {
  let cursor = from;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
}

function resolveAsPatternEnd(match, bracketOpenToClose) {
  const asIndex = match.index;
  if (match[1]) return asIndex + match[0].length;
  const openBracketIndex = asIndex + match[0].length - 1;
  const closeBracketIndex = bracketOpenToClose.get(openBracketIndex);
  return closeBracketIndex === undefined ? -1 : closeBracketIndex + 1;
}

function validateOuterParens(asIndex, afterPattern, parsed) {
  const { text, groupingOpenToClose, groupingCloseToOpen } = parsed;
  const lhsClose = prevNonSpace(text, asIndex - 1);
  const lhsOpen = groupingCloseToOpen.get(lhsClose);
  if (text[lhsClose] !== ")" || lhsOpen === undefined || text.slice(lhsOpen + 1, lhsClose).trim() === "") {
    return `as at offset ${asIndex} LHS must be enclosed in non-empty (...)`;
  }
  const outerOpen = prevNonSpace(text, lhsOpen - 1);
  const outerClose = groupingOpenToClose.get(outerOpen);
  if (text[outerOpen] !== "(" || outerClose === undefined) {
    return `as at offset ${asIndex} must have outer grouping '(' immediately before LHS`;
  }
  const beforeOuter = prevNonSpace(text, outerOpen - 1);
  if (beforeOuter >= 0 && /[A-Za-z0-9_]/.test(text[beforeOuter])) {
    const ident = text.slice(0, beforeOuter + 1).match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0] ?? "";
    if (!JQ_KEYWORDS_BEFORE_PAREN.has(ident)) {
      return `as at offset ${asIndex} outer '(' belongs to function call ${ident}(...)`;
    }
  }
  if (outerClose <= afterPattern || text.slice(afterPattern + 1, outerClose).trim() === "") {
    return `as at offset ${asIndex} outer (...) must enclose a non-empty RHS body`;
  }
  return null;
}

function validateLoopAsBinding(asIndex, parsed) {
  const enclosingOpen =
    parsed.allEnclosingSpans
      .filter(([open, close]) => open < asIndex && close > asIndex)
      .sort((a, b) => a[0] - b[0])
      .map(([open]) => open)
      .at(-1) ?? -1;
  if (!/\b(?:reduce|foreach)\b/.test(parsed.text.slice(enclosingOpen + 1, asIndex))) {
    return `as at offset ${asIndex} followed by '(' without reduce/foreach`;
  }
  return null;
}

export function validateJqAsBindings(program) {
  const parsed = maskJqSyntax(program);
  if (!parsed.ok) return parsed;

  let nonReduceCount = 0;
  let loopCount = 0;
  for (const match of parsed.text.matchAll(/\bas\s+(?:\$([A-Za-z_][A-Za-z0-9_]*)|(\{|\[))/g)) {
    const asIndex = match.index;
    const patternEnd = resolveAsPatternEnd(match, parsed.bracketOpenToClose);
    if (patternEnd === -1) {
      return { ok: false, reason: `unclosed destructuring pattern at offset ${asIndex}` };
    }
    const afterPattern = nextNonSpace(parsed.text, patternEnd);
    if (parsed.text[afterPattern] === "(") {
      const loopErr = validateLoopAsBinding(asIndex, parsed);
      if (loopErr) return { ok: false, reason: loopErr };
      loopCount += 1;
      continue;
    }
    if (parsed.text[afterPattern] !== "|") {
      return { ok: false, reason: `as at offset ${asIndex} must be followed by '|'` };
    }
    const parenErr = validateOuterParens(asIndex, afterPattern, parsed);
    if (parenErr) return { ok: false, reason: parenErr };
    nonReduceCount += 1;
  }
  return { ok: true, nonReduceCount, loopCount };
}

function unquoteYamlFlowScalar(scalar) {
  const trimmed = scalar.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extractYamlRunScripts(workflowText) {
  if (!/^(?:name|on|jobs):/m.test(workflowText)) {
    return { ok: true, scripts: [workflowText] };
  }
  const lines = workflowText.replace(/\r\n?/g, "\n").split("\n");
  const scripts = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;
    const runMatch = line.match(/^( *(?:-\s+)?)run:[ \t]*(.*)$/);
    if (!runMatch) {
      if (/(?:^|[^A-Za-z0-9_-])jq(?:$|[^A-Za-z0-9_-])|--jq(?:\s|=|['"]|$)|(?:^|\s)-q(?:\s|=|['"]|$)/.test(line)) {
        return { ok: false, reason: `jq reference found outside YAML run: block at line ${i + 1}` };
      }
      continue;
    }
    const keyIndent = runMatch[1].length;
    const rawAfterRun = runMatch[2].trim();
    if (/^[|>][-+]?[0-9]*(?:\s+#.*)?$/.test(rawAfterRun)) {
      const blockLines = [];
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j];
        if (nextLine.trim() === "") {
          blockLines.push("");
          j += 1;
          continue;
        }
        const indent = nextLine.match(/^ */)[0].length;
        if (indent <= keyIndent) break;
        blockLines.push(nextLine);
        j += 1;
      }
      const nonEmptyIndents = blockLines.filter((l) => l.length > 0).map((l) => l.match(/^ */)[0].length);
      const minIndent = nonEmptyIndents.length > 0 ? Math.min(...nonEmptyIndents) : 0;
      scripts.push(blockLines.map((l) => (l.length >= minIndent ? l.slice(minIndent) : "")).join("\n"));
      i = j - 1;
    } else if (rawAfterRun.length > 0 && !rawAfterRun.startsWith("#")) {
      if (rawAfterRun.startsWith('"') && rawAfterRun.includes("\\")) {
        return { ok: false, reason: `escaped double-quoted YAML flow run: scalar is forbidden at line ${i + 1}` };
      }
      scripts.push(unquoteYamlFlowScalar(runMatch[2]));
    } else {
      return { ok: false, reason: `empty YAML run: block at line ${i + 1}` };
    }
  }
  if (scripts.length === 0) {
    return { ok: false, reason: "no YAML run: blocks found in workflow" };
  }
  return { ok: true, scripts };
}

function extractHeredocsAndQueries(scriptText) {
  const programs = [];
  const prefixVars = new Map();
  const queryRefVars = new Map();
  const protectedVars = new Set();
  let duplicateVar = null;

  let cleaned = scriptText.replace(
    /([A-Za-z_][A-Za-z0-9_]*)="\$\(cat <<'([A-Z_]+)'\n([\s\S]*?)\n *\2\n *\)"/g,
    (_, varName, delim, body) => {
      if (protectedVars.has(varName)) {
        duplicateVar ??= varName;
      }
      protectedVars.add(varName);
      if (delim === "JQ") {
        prefixVars.set(varName, body);
        programs.push(body);
      }
      return `__VERIFIED_HEREDOC_${varName}__=''`;
    },
  );
  if (duplicateVar) {
    return { ok: false, reason: `duplicate heredoc assignment to ${duplicateVar}` };
  }

  cleaned = cleaned.replace(/(?<!<)<<'([A-Z_]+)'\n([\s\S]*?)\n *\1(?=\n|$)/g, (_, delim, body) => {
    if (delim === "JQ") {
      programs.push(body);
    }
    return "<<<''";
  });

  if (/(?<!<)<<(?!<)/.test(cleaned)) {
    return { ok: false, reason: "only closed single-quoted <<'DELIM' heredocs are permitted" };
  }

  cleaned = cleaned.replace(
    /(^|[;\n])[ \t]*([A-Za-z_][A-Za-z0-9_]*(?:_query|_filter))='([^']*)'(?=[ \t]*(?:#[^\n]*)?(?:\n|;|$))/g,
    (_, lead, varName, body) => {
      if (protectedVars.has(varName)) {
        duplicateVar ??= varName;
      }
      protectedVars.add(varName);
      if (body.length > 0) {
        prefixVars.set(varName, body);
        queryRefVars.set(`"\${${varName}}"`, body);
        programs.push(body);
      }
      return `${lead}__VERIFIED_QUERY_${varName}__=''`;
    },
  );
  if (duplicateVar) {
    return { ok: false, reason: `duplicate jq variable assignment to ${duplicateVar}` };
  }

  return { ok: true, cleaned, programs, prefixVars, queryRefVars, protectedVars };
}

function readSingleQuoted(text, start) {
  let cursor = start + 1;
  while (cursor < text.length && text[cursor] !== "'") cursor += 1;
  if (cursor >= text.length) return -1;
  return cursor + 1;
}

function readArithmeticExpansion(text, start) {
  let cursor = start + 3;
  let depth = 1;
  while (cursor < text.length && depth > 0) {
    if (text.startsWith("((", cursor)) {
      depth += 1;
      cursor += 2;
    } else if (text.startsWith("))", cursor)) {
      depth -= 1;
      cursor += 2;
    } else {
      cursor += 1;
    }
  }
  return depth === 0 ? cursor : -1;
}

function flushWord(state) {
  if (state.buf.length > 0) {
    state.tokens.push({ kind: "word", raw: state.buf });
    state.buf = "";
  }
}

function scanDoubleQuotedSegment(text, start, state) {
  let cursor = start + 1;
  state.buf += '"';
  while (cursor < text.length && text[cursor] !== '"') {
    if (text[cursor] === "`") {
      state.error = "backtick command substitution is forbidden";
      return -1;
    }
    if (text.startsWith("$((", cursor)) {
      const end = readArithmeticExpansion(text, cursor);
      if (end === -1) {
        state.error = "unterminated $((...)) arithmetic expansion";
        return -1;
      }
      state.buf += text.slice(cursor, end);
      cursor = end;
    } else if (text.startsWith("$(", cursor)) {
      state.buf += '"';
      flushWord(state);
      state.tokens.push({ kind: "cmd_open", raw: "$(" });
      state.cmdStack.push({ resumeDoubleQuote: true, parenDepth: 0 });
      return cursor + 2;
    } else if (text[cursor] === "\\") {
      if (cursor + 1 >= text.length) {
        state.error = "unterminated escape in double-quoted string";
        return -1;
      }
      state.buf += text.slice(cursor, cursor + 2);
      cursor += 2;
    } else {
      state.buf += text[cursor];
      cursor += 1;
    }
  }
  if (cursor >= text.length) {
    state.error = "unterminated double-quoted string";
    return -1;
  }
  state.buf += '"';
  return cursor + 1;
}

function handleCommandCloseParen(text, cursor, state) {
  const top = state.cmdStack.at(-1);
  if (!top) return -2;
  if (top.parenDepth > 0) {
    top.parenDepth -= 1;
    return -2;
  }
  flushWord(state);
  state.tokens.push({ kind: "op", raw: ")" });
  state.cmdStack.pop();
  if (!top.resumeDoubleQuote) return cursor + 1;
  return scanDoubleQuotedSegment(text, cursor, state);
}

function tokenizeShellWords(scriptText) {
  const state = { tokens: [], buf: "", cmdStack: [], error: null };
  let cursor = 0;
  while (cursor < scriptText.length && !state.error) {
    const ch = scriptText[cursor];
    if (ch === "\\" && cursor + 1 < scriptText.length && scriptText[cursor + 1] === "\n") {
      cursor += 2;
    } else if (ch === "\n") {
      flushWord(state);
      state.tokens.push({ kind: "op", raw: "\n" });
      cursor += 1;
    } else if (/\s/.test(ch)) {
      flushWord(state);
      cursor += 1;
    } else if (ch === "#" && state.buf.length === 0) {
      while (cursor < scriptText.length && scriptText[cursor] !== "\n") cursor += 1;
    } else if (ch === "`") {
      state.error = "backtick command substitution is forbidden";
    } else if (scriptText.startsWith("$((", cursor)) {
      const end = readArithmeticExpansion(scriptText, cursor);
      if (end === -1) {
        state.error = "unterminated $((...)) arithmetic expansion";
      } else {
        state.buf += scriptText.slice(cursor, end);
        cursor = end;
      }
    } else if (scriptText.startsWith("$(", cursor)) {
      flushWord(state);
      state.tokens.push({ kind: "cmd_open", raw: "$(" });
      state.cmdStack.push({ resumeDoubleQuote: false, parenDepth: 0 });
      cursor += 2;
    } else if (ch === ")" && state.cmdStack.length > 0) {
      const next = handleCommandCloseParen(scriptText, cursor, state);
      if (next === -2) {
        flushWord(state);
        state.tokens.push({ kind: "op", raw: ")" });
        cursor += 1;
      } else if (next !== -1) {
        cursor = next;
      }
    } else if (scriptText.startsWith("<<<", cursor)) {
      flushWord(state);
      state.tokens.push({ kind: "op", raw: "<<<" });
      cursor += 3;
    } else if ("|&;()<>".includes(ch)) {
      if (ch === "(" && state.cmdStack.length > 0) state.cmdStack.at(-1).parenDepth += 1;
      if ((ch === "<" || ch === ">") && /^[0-9]+$/.test(state.buf)) {
        state.tokens.push({ kind: "op", raw: `${state.buf}${ch}` });
        state.buf = "";
      } else {
        flushWord(state);
        state.tokens.push({ kind: "op", raw: ch });
      }
      cursor += 1;
    } else if (ch === "'") {
      const end = readSingleQuoted(scriptText, cursor);
      if (end === -1) {
        state.error = "unterminated single-quoted string";
      } else {
        state.buf += scriptText.slice(cursor, end);
        cursor = end;
      }
    } else if (ch === '"') {
      const end = scanDoubleQuotedSegment(scriptText, cursor, state);
      if (end !== -1) cursor = end;
    } else if (ch === "\\" && cursor + 1 < scriptText.length) {
      state.buf += scriptText.slice(cursor, cursor + 2);
      cursor += 2;
    } else {
      state.buf += ch;
      cursor += 1;
    }
  }
  if (state.error) return { ok: false, reason: state.error };
  if (state.cmdStack.length > 0) return { ok: false, reason: "unclosed $(...) command substitution" };
  flushWord(state);
  return { ok: true, tokens: state.tokens };
}

function parseFilterToken(rawToken, prefixVars) {
  const match = rawToken.match(/^(?:"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")?'([^']*)'$/);
  if (!match) return null;
  const [, prefixVar, inlineFilter] = match;
  if (!prefixVar) {
    return { inlineFilter, compiledProgram: inlineFilter };
  }
  const prefixBody = prefixVars.get(prefixVar);
  if (prefixBody === undefined) return null;
  return { inlineFilter, compiledProgram: `${prefixBody}\n${inlineFilter}` };
}

function consumeJqCommandFilter(tokens, jqIndex, prefixVars) {
  let idx = jqIndex + 1;
  const declaredVars = [];
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (tok.kind === "cmd_open") {
      return { ok: false, reason: "nested $(...) command substitution inside jq invocation is forbidden" };
    }
    if (tok.kind !== "word") break;
    const word = tok.raw;
    if (word === "--arg" || word === "--argjson" || word === "--slurpfile") {
      const nameTok = tokens[idx + 1];
      const valTok = tokens[idx + 2];
      const afterValTok = tokens[idx + 3];
      if (
        !nameTok ||
        nameTok.kind !== "word" ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(nameTok.raw) ||
        !valTok ||
        valTok.kind !== "word" ||
        afterValTok?.kind === "cmd_open"
      ) {
        return { ok: false, reason: `invalid or command-substituted ${word} binding in jq invocation` };
      }
      declaredVars.push(nameTok.raw);
      idx += 3;
      continue;
    }
    if (word.startsWith("-")) {
      if (!/^-[ceEnrRsS]+$/.test(word)) {
        return { ok: false, reason: `unsupported jq flag: ${word}` };
      }
      idx += 1;
      continue;
    }
    const parsed = parseFilterToken(word, prefixVars);
    if (!parsed) {
      return { ok: false, reason: `jq filter must be single-quoted (with optional verified prefix), got: ${word}` };
    }
    let argCursor = idx + 1;
    while (argCursor < tokens.length && tokens[argCursor].kind !== "op") {
      if (tokens[argCursor].kind === "cmd_open") {
        return {
          ok: false,
          reason: "command substitution after jq filter is forbidden",
        };
      }
      if (!/^"\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[0-9]+)"$/.test(tokens[argCursor].raw)) {
        return {
          ok: false,
          reason: `unexpected trailing argument after jq filter: ${tokens[argCursor].raw}`,
        };
      }
      argCursor += 1;
    }
    if (
      tokens[argCursor]?.raw === "<<<" &&
      (tokens[argCursor + 1]?.kind === "cmd_open" ||
        (tokens[argCursor + 1]?.kind === "word" && tokens[argCursor + 2]?.kind === "cmd_open"))
    ) {
      return {
        ok: false,
        reason: "command substitution inside jq here-string input is forbidden",
      };
    }
    return {
      ok: true,
      inlineFilter: parsed.inlineFilter,
      compiledProgram: parsed.compiledProgram,
      declaredVars,
      nextIndex: argCursor - 1,
    };
  }
  return { ok: false, reason: `jq command at token ${jqIndex} is missing a filter argument` };
}

function compileCheckJqInvocation(jqBin, compiledProgram, declaredVars) {
  const args = ["-n"];
  for (const name of declaredVars) {
    args.push("--argjson", name, "null");
  }
  args.push(`if false then (\n${compiledProgram}\n) else empty end`);
  const res = spawnSync(jqBin, args, { encoding: "utf8" });
  if (res.status !== 0) {
    return { ok: false, reason: `jq compile check failed: ${(res.stderr ?? "").trim()}` };
  }
  return { ok: true };
}

export function auditWorkflowJqInvocations(workflowText) {
  const extracted = extractYamlRunScripts(workflowText);
  if (!extracted.ok) return { ok: false, reason: extracted.reason, programs: [] };

  const jqBin = resolveJqBinary();
  const programs = [];
  const invocations = [];
  let commandCount = 0;

  for (const script of extracted.scripts) {
    const pre = extractHeredocsAndQueries(script);
    if (!pre.ok) return { ok: false, reason: pre.reason, programs: [] };
    programs.push(...pre.programs);

    for (const defBody of pre.prefixVars.values()) {
      const standalone = defBody.trimEnd().endsWith(";") ? `${defBody}\n.` : defBody;
      const check = compileCheckJqInvocation(jqBin, standalone, []);
      if (!check.ok) return { ok: false, reason: check.reason, programs: [] };
      const bindingCheck = validateJqAsBindings(standalone);
      if (!bindingCheck.ok) return { ok: false, reason: bindingCheck.reason, programs: [] };
    }

    const tokenized = tokenizeShellWords(pre.cleaned);
    if (!tokenized.ok) return { ok: false, reason: tokenized.reason, programs: [] };
    const { tokens } = tokenized;

    let currentCmd = null;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token.kind === "op" || token.kind === "cmd_open") {
        currentCmd = null;
        continue;
      }
      if (token.kind !== "word") continue;

      const unquotedWord = token.raw.replace(/['"\\]/g, "");
      const baseCmd = unquotedWord.split("/").at(-1);
      if (currentCmd === null && !/^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/.test(token.raw)) {
        currentCmd = baseCmd;
      }
      if (
        (baseCmd === "jq" && token.raw !== "jq") ||
        ((unquotedWord === "--jq" || unquotedWord.startsWith("--jq=")) &&
          token.raw !== "--jq" &&
          !token.raw.startsWith("--jq="))
      ) {
        return {
          ok: false,
          reason: `aliased or quoted jq token is forbidden: ${token.raw}`,
          programs: [],
        };
      }

      if (
        unquotedWord === "-q" ||
        unquotedWord.startsWith("-q") ||
        (currentCmd === "gh" && /^-[A-Za-z]*q/.test(unquotedWord))
      ) {
        return {
          ok: false,
          reason: `-q shorthand is forbidden; use --jq (${token.raw})`,
          programs: [],
        };
      }

      if (
        currentCmd &&
        /^(?:read|printf|unset|declare|typeset|local|export|eval)$/.test(currentCmd) &&
        (pre.protectedVars.has(unquotedWord) || /(?:_query|_filter)$/.test(unquotedWord))
      ) {
        return {
          ok: false,
          reason: `builtin mutation of protected jq variable ${unquotedWord} is forbidden`,
          programs: [],
        };
      }

      const anyAssignMatch = token.raw.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=(.*)$/);
      if (
        anyAssignMatch &&
        !anyAssignMatch[1].startsWith("__VERIFIED_") &&
        (pre.protectedVars.has(anyAssignMatch[1]) || /(?:_query|_filter)$/.test(anyAssignMatch[1]))
      ) {
        return {
          ok: false,
          reason: `non-single-quoted or duplicate ${anyAssignMatch[1]} assignment is forbidden`,
          programs: [],
        };
      }

      if (token.raw === "--jq" || token.raw.startsWith("--jq=")) {
        const rawFilter = token.raw === "--jq" ? tokens[i + 1]?.raw : token.raw.slice("--jq=".length);
        const afterFilterIdx = token.raw === "--jq" ? i + 2 : i + 1;
        if (!rawFilter || (token.raw === "--jq" && tokens[i + 1]?.kind !== "word")) {
          return { ok: false, reason: "--jq missing filter token", programs: [] };
        }
        if (tokens[afterFilterIdx]?.kind === "cmd_open") {
          return { ok: false, reason: "nested $(...) in --jq filter is forbidden", programs: [] };
        }
        commandCount += 1;
        if (pre.queryRefVars.has(rawFilter)) {
          const src = pre.queryRefVars.get(rawFilter);
          const check = compileCheckJqInvocation(jqBin, src, []);
          if (!check.ok) return { ok: false, reason: check.reason, programs: [] };
          invocations.push({ source: src, fullSource: src, argNames: [] });
          if (token.raw === "--jq") i += 1;
          continue;
        }
        const parsed = parseFilterToken(rawFilter, pre.prefixVars);
        if (!parsed) {
          return { ok: false, reason: `--jq filter must be single-quoted, got: ${rawFilter}`, programs: [] };
        }
        const check = compileCheckJqInvocation(jqBin, parsed.compiledProgram, []);
        if (!check.ok) return { ok: false, reason: check.reason, programs: [] };
        const bindingCheck = validateJqAsBindings(parsed.compiledProgram);
        if (!bindingCheck.ok) return { ok: false, reason: bindingCheck.reason, programs: [] };
        programs.push(parsed.inlineFilter);
        invocations.push({ source: parsed.compiledProgram, fullSource: parsed.compiledProgram, argNames: [] });
        if (token.raw === "--jq") i += 1;
        continue;
      }

      if (token.raw === "jq") {
        commandCount += 1;
        const result = consumeJqCommandFilter(tokens, i, pre.prefixVars);
        if (!result.ok) return { ok: false, reason: result.reason, programs: [] };
        const check = compileCheckJqInvocation(jqBin, result.compiledProgram, result.declaredVars);
        if (!check.ok) return { ok: false, reason: check.reason, programs: [] };
        const bindingCheck = validateJqAsBindings(result.compiledProgram);
        if (!bindingCheck.ok) return { ok: false, reason: bindingCheck.reason, programs: [] };
        programs.push(result.inlineFilter);
        invocations.push({
          source: result.compiledProgram,
          fullSource: result.compiledProgram,
          argNames: result.declaredVars,
        });
        i = result.nextIndex;
      }
    }
  }
  return { ok: true, programs, invocations, commandCount };
}

export function extractWorkflowJqPrograms(workflowText) {
  const audit = auditWorkflowJqInvocations(workflowText);
  if (!audit.ok) {
    throw new Error(audit.reason);
  }
  return audit.programs;
}
