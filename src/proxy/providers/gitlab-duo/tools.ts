/**
 * GitLab Duo — Tool Bridge
 *
 * Maps the workflow's typed `ServerAction`s to whatever tools the client
 * declared on the request, so an agentic client (Claude Code, Cline, Roo Code)
 * sees a normal tool_use round and can echo a tool_result back. We convert
 * that tool_result back into an `actionResponse` frame on the next turn.
 *
 * Strategy:
 *   1. Try to find a client-declared tool with a "matching" name (case
 *      insensitive substring on a small whitelist per action kind).
 *   2. If nothing matches, fall back to a synthetic tool name that mirrors
 *      Claude Code's built-ins (`Bash`, `Read`, `Write`, `Edit`, `Glob`,
 *      `Grep`). Most clients still accept this and bridge it locally.
 *
 * Args translation: we keep the action's native field names where possible
 * (the LLM sees the schema we declare on its side, so the names below match
 * the most common conventions). Anything we don't understand is JSON-stringified
 * and passed through.
 */

import type { ServerAction } from "./protocol";

/** Subset of JSON Schema we need to look up declared property names. */
interface ToolSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
}

export interface MatchedToolCall {
  /** Client-facing tool name (must match one of clientTools[].name when
   *  matched, or a sane default otherwise). */
  name: string;
  /** Stringified JSON of arguments the client will pass to its tool. */
  argsJson: string;
  /** Original requestID from the action — we echo it on actionResponse. */
  requestID: string;
}

export class ToolBridge {
  /** Heuristic candidates for each Duo action. First match wins. */
  private static readonly CANDIDATES: Record<string, string[]> = {
    runCommand: ["bash", "shell", "run_command", "execute_command", "terminal", "command"],
    runShellCommand: ["bash", "shell", "run_shell", "run_command", "execute_command", "terminal"],
    runReadFile: ["read", "read_file", "view", "fs_read", "file_read", "openfile"],
    runReadFiles: ["read", "read_file", "read_files", "view", "fs_read"],
    runWriteFile: ["write", "write_file", "create_file", "fs_write", "file_write"],
    runEditFile: ["edit", "edit_file", "str_replace", "fs_edit", "file_edit", "replace"],
    mkdir: ["mkdir", "make_directory", "create_directory"],
    listDirectory: ["ls", "list_dir", "list_directory", "fs_list", "tree"],
    findFiles: ["glob", "find_files", "find", "fs_find"],
    grep: ["grep", "search", "fs_grep", "ripgrep"],
    runGrep: ["grep", "search", "fs_grep", "ripgrep"],
    scanDirectoryTree: ["tree", "scan_directory", "list_directory", "ls"],
    runGitCommand: ["bash", "shell", "git", "run_command", "execute_command"],
    runReadOnlyGitCommand: ["bash", "shell", "git", "run_command", "execute_command"],
    runHTTPRequest: ["fetch", "http", "http_request", "web_fetch", "curl"],
    // ── Newer Duo agentic actions (17.x+) ────────────────────────────────────
    // Web search: prefer a real web-search tool if the client has one, else
    // fall back to fetch (we'll send the query as a search-engine URL).
    runWebSearch: ["web_search", "websearch", "search_web", "google_search"],
    // Semantic / RAG file search: most clients only have grep/glob, so we
    // route to those by default and let argsFor() degrade the query into a
    // simple regex/glob pattern.
    runFileSearch: ["file_search", "fs_search", "semantic_search", "grep", "search", "ripgrep"],
    // MCP tool calls: route by the upstream `tool` name when the client
    // declared an MCP-style namespaced tool (e.g. "github__create_issue"),
    // otherwise we emit the bare tool name and hope the client recognizes it.
    runMCPCall: [],
  };

  /** Defaults when the client didn't declare anything matching. Mirrors the
   *  Claude-Code-canonical tool names — but only used as a last resort when
   *  even `Bash` isn't declared. The match() flow prefers `Bash` over these
   *  whenever the client has it, because every agentic client has Bash but
   *  not all of them have Grep/Read/Glob/etc. */
  private static readonly FALLBACK: Record<string, string> = {
    runCommand: "Bash",
    runShellCommand: "Bash",
    runReadFile: "Read",
    runReadFiles: "Read",
    runWriteFile: "Write",
    runEditFile: "Edit",
    mkdir: "Bash",
    listDirectory: "LS",
    findFiles: "Glob",
    grep: "Grep",
    runGrep: "Grep",
    scanDirectoryTree: "LS",
    runGitCommand: "Bash",
    runReadOnlyGitCommand: "Bash",
    runHTTPRequest: "WebFetch",
    runWebSearch: "WebSearch",
    runFileSearch: "Grep",
    // MCP fallback: keep the upstream tool name verbatim. argsFor() handles
    // the special case so the client just sees a tool_use with whatever
    // name the workflow asked for.
    runMCPCall: "",
  };

  /** Action kinds we can emulate purely through `Bash` if the client only
   *  declared shell access. Every entry here has a corresponding shell-form
   *  branch in `argsFor()` — adding a kind here without that branch will emit
   *  a payload the bash tool can't execute, so keep them in sync. */
  private static readonly BASH_EMULATABLE = new Set<string>([
    "runCommand", "runShellCommand", "runGitCommand", "runReadOnlyGitCommand",
    "runReadFile", "runReadFiles", "runWriteFile", "runEditFile",
    "mkdir", "listDirectory", "scanDirectoryTree", "findFiles",
    "grep", "runGrep",
    // runFileSearch degrades to a `grep -rn <regex>` shell command —
    // good enough when the client only has Bash.
    "runFileSearch",
    // runWebSearch can degrade to `curl` against a search engine when the
    // client only has Bash — better than emitting an unknown "WebSearch" tool.
    "runWebSearch",
    // runHTTPRequest is also Bash-emulatable via curl; argsFor() already has
    // the http branch but no shell branch, so we add one below.
    "runHTTPRequest",
  ]);

  /**
   * Match a Duo action against the client's tool list.
   *
   * Returns null if the action isn't one we know how to bridge. Returns a
   * matched call (with synthesized args JSON) otherwise — the caller should
   * use this to emit a tool_use / tool_calls block to the client.
   */
  static match(
    action: ServerAction,
    clientTools: Array<{ name?: string; input_schema?: ToolSchema; parameters?: ToolSchema }> | undefined,
  ): MatchedToolCall | null {
    const kind = ToolBridge.actionKind(action);
    if (!kind) return null;

    const tools = clientTools ?? [];
    const declared = tools.map((t) => (t?.name ?? "").toString());

    // Special case: runMCPCall carries its own tool name. Try to honor it
    // verbatim, then fall through to a name-similarity lookup, then emit it
    // raw — most clients with MCP support will recognize the bare name.
    if (kind === "runMCPCall" && "runMCPCall" in action) {
      const mcp = action.runMCPCall;
      const wanted = `${mcp.server}__${mcp.tool}`;
      const exact = declared.find((d) => d.toLowerCase() === wanted.toLowerCase()
                                     || d.toLowerCase() === mcp.tool.toLowerCase());
      const sub = exact ?? declared.find((d) => d.toLowerCase().includes(mcp.tool.toLowerCase()));
      const toolName = sub ?? wanted;
      const matchedTool = tools.find((t) => (t?.name ?? "") === toolName);
      const schema = matchedTool?.input_schema ?? matchedTool?.parameters;
      const props = schema?.properties ?? {};
      return {
        name: toolName,
        argsJson: ToolBridge.argsFor(action, toolName, props),
        requestID: action.requestID,
      };
    }

    const candidates = ToolBridge.CANDIDATES[kind] ?? [];
    const fallback = ToolBridge.FALLBACK[kind] ?? "Bash";

    // 1. Prefer an exact / case-insensitive match against declared tools.
    let toolName: string | null = null;
    for (const cand of candidates) {
      const hit = declared.find((d) => d.toLowerCase() === cand.toLowerCase());
      if (hit) { toolName = hit; break; }
    }
    if (!toolName) {
      // 2. Substring fallback (e.g. client declared "execute_bash" → matches "bash").
      for (const cand of candidates) {
        const hit = declared.find((d) => d.toLowerCase().includes(cand.toLowerCase()));
        if (hit) { toolName = hit; break; }
      }
    }

    // 3. CRITICAL: if no specific match found AND this action can be emulated
    //    via Bash, prefer the client's declared Bash-like tool over emitting
    //    a fallback name like "Grep"/"Read" that the client may not have.
    //    This is the difference between a turn that silently dies after a
    //    shell call and one that keeps running. Every agentic client declares
    //    Bash; only some declare Grep/Read/Glob/etc.
    if (!toolName && ToolBridge.BASH_EMULATABLE.has(kind)) {
      const bashLike = ["bash", "shell", "run_command", "execute_command", "terminal", "command"];
      for (const cand of bashLike) {
        const hit = declared.find((d) => d.toLowerCase() === cand.toLowerCase());
        if (hit) { toolName = hit; break; }
      }
      if (!toolName) {
        for (const cand of bashLike) {
          const hit = declared.find((d) => d.toLowerCase().includes(cand.toLowerCase()));
          if (hit) { toolName = hit; break; }
        }
      }
    }

    // 4. Last-resort fallback to the canonical Claude-Code name. Only reached
    //    when the client declared neither a matching tool nor any Bash-like
    //    tool — extremely rare but kept for backwards compat.
    if (!toolName) toolName = fallback;

    // Look up the actual schema of the matched tool — we shape args to its
    // declared property names so e.g. Claude Code's `file_path` doesn't end
    // up as `path: undefined` on the client.
    const matchedTool = tools.find((t) => (t?.name ?? "") === toolName);
    const schema = matchedTool?.input_schema ?? matchedTool?.parameters;
    const props = schema?.properties ?? {};

    return {
      name: toolName,
      argsJson: ToolBridge.argsFor(action, toolName, props),
      requestID: action.requestID,
    };
  }

  /** Pick the first property name from the schema that's in `candidates`,
   *  preserving the case the client declared. Falls back to the first item
   *  in `candidates` when nothing matches — that gives sensible defaults
   *  (e.g. `command`, `file_path`) for unknown clients. */
  private static pickField(
    props: Record<string, unknown>,
    candidates: string[],
  ): string {
    const keys = Object.keys(props);
    const lowerKeys = keys.map((k) => k.toLowerCase());
    for (const cand of candidates) {
      const idx = lowerKeys.indexOf(cand.toLowerCase());
      if (idx !== -1) return keys[idx]!;
    }
    return candidates[0] ?? "value";
  }

  private static actionKind(a: ServerAction): keyof typeof ToolBridge.CANDIDATES | null {
    for (const k of Object.keys(ToolBridge.CANDIDATES)) {
      if (k in a) return k as keyof typeof ToolBridge.CANDIDATES;
    }
    return null;
  }

  /** Build the JSON args object the client's tool will see. We adapt to the
   *  client's declared schema (Claude Code uses `file_path`, others use `path`,
   *  some use `filename`) — `pickField()` looks at `props` to choose the right
   *  property name. Falls back to canonical names when the schema doesn't
   *  declare one. */
  private static argsFor(
    a: ServerAction,
    toolName: string,
    props: Record<string, unknown> = {},
  ): string {
    const lower = toolName.toLowerCase();
    const payload = ToolBridge.payload(a);

    // Common candidate orderings — first one wins per `pickField`.
    const F_CMD = ["command", "cmd", "shell_command", "script"];
    const F_PATH = ["file_path", "path", "filepath", "filename", "file"];
    const F_DIR = ["directory_path", "directory", "path", "dir", "folder"];
    const F_CONTENT = ["content", "contents", "text", "data", "body"];
    const F_OLD = ["old_string", "oldString", "old", "search", "from", "before"];
    const F_NEW = ["new_string", "newString", "new", "replace", "to", "after"];
    const F_PATTERN = ["pattern", "query", "regex", "search"];
    const F_OFFSET = ["offset", "line_offset", "lineOffset", "start_line"];
    const F_PATHS = ["paths", "file_paths", "filepaths", "files"];

    if ("runCommand" in a) {
      const p = a.runCommand;
      const cmdline = [p.program, ...(p.flags ?? []), ...(p.arguments ?? [])].filter(Boolean).join(" ");
      if (lower.includes("bash") || lower.includes("shell") || lower.includes("command") || lower === "terminal") {
        return JSON.stringify({ [ToolBridge.pickField(props, F_CMD)]: cmdline });
      }
      return JSON.stringify(payload);
    }

    if ("runShellCommand" in a) {
      const p = a.runShellCommand;
      if (lower.includes("bash") || lower.includes("shell") || lower.includes("command") || lower === "terminal") {
        return JSON.stringify({ [ToolBridge.pickField(props, F_CMD)]: p.command });
      }
      return JSON.stringify(payload);
    }

    if ("runGitCommand" in a || "runReadOnlyGitCommand" in a) {
      const p = ("runGitCommand" in a ? a.runGitCommand : a.runReadOnlyGitCommand);
      const cmdline = ["git", p.command, ...(p.arguments ?? [])].filter(Boolean).join(" ");
      if (lower.includes("bash") || lower.includes("shell") || lower.includes("command") || lower === "terminal") {
        return JSON.stringify({ [ToolBridge.pickField(props, F_CMD)]: cmdline });
      }
      return JSON.stringify(payload);
    }

    if ("runReadFile" in a) {
      const p = a.runReadFile;
      if (lower.includes("read") || lower === "view") {
        const out: Record<string, unknown> = {
          [ToolBridge.pickField(props, F_PATH)]: p.filepath,
        };
        if (p.lineOffset) out[ToolBridge.pickField(props, F_OFFSET)] = p.lineOffset;
        return JSON.stringify(out);
      }
      // Bash-emulation: when the client only declared Bash, use `cat` (or
      // `sed -n` for line offsets). Without this branch, a Bash-routed
      // runReadFile would emit `{filepath:..., lineOffset:...}` to a tool
      // that expects `{command: "..."}` and the call would fail silently.
      if (lower.includes("bash") || lower.includes("shell") || lower === "terminal") {
        const cmd = p.lineOffset
          ? `sed -n '${Number(p.lineOffset)},$p' ${shellQuote(p.filepath)}`
          : `cat ${shellQuote(p.filepath)}`;
        return JSON.stringify({ [ToolBridge.pickField(props, F_CMD)]: cmd });
      }
      return JSON.stringify(payload);
    }

    if ("runReadFiles" in a) {
      const p = a.runReadFiles;
      if (lower.includes("bash") || lower.includes("shell") || lower === "terminal") {
        // `for f in ...; do echo "===$f==="; cat "$f"; done` keeps boundaries.
        const args = p.filepaths.map(shellQuote).join(" ");
        const cmd = `for f in ${args}; do echo "=== $f ==="; cat "$f"; done`;
        return JSON.stringify({ [ToolBridge.pickField(props, F_CMD)]: cmd });
      }
      return JSON.stringify({ [ToolBridge.pickField(props, F_PATHS)]: p.filepaths });
    }

    if ("runWriteFile" in a) {
      const p = a.runWriteFile;
      if (lower.includes("write") || lower.includes("create")) {
        return JSON.stringify({
          [ToolBridge.pickField(props, F_PATH)]: p.filepath,
          [ToolBridge.pickField(props, F_CONTENT)]: p.contents,
        });
      }
      // Bash-emulation: heredoc with a randomized sentinel that won't collide
      // with user content. Note: this is best-effort — for huge files Edit
      // would be more efficient, but Bash gets the job done.
      if (lower.includes("bash") || lower.includes("shell") || lower === "terminal") {
        const sentinel = `EOF_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
        const cmd = `cat > ${shellQuote(p.filepath)} <<'${sentinel}'\n${p.contents}\n${sentinel}`;
        return JSON.stringify({ [ToolBridge.pickField(props, F_CMD)]: cmd });
      }
      return JSON.stringify(payload);
    }

    if ("runEditFile" in a) {
      const p = a.runEditFile;
      if (lower.includes("edit") || lower.includes("replace")) {
        return JSON.stringify({
          [ToolBridge.pickField(props, F_PATH)]: p.filepath,
          [ToolBridge.pickField(props, F_OLD)]: p.oldString,
          [ToolBridge.pickField(props, F_NEW)]: p.newString,
        });
      }
      // Bash-emulation: use python for safe in-place string replacement —
      // sed/awk are too painful to escape arbitrary strings reliably.
      if (lower.includes("bash") || lower.includes("shell") || lower === "terminal") {
        const py = `import sys,pathlib;p=pathlib.Path(sys.argv[1]);t=p.read_text();o=sys.argv[2];n=sys.argv[3];` +
          `assert t.count(o)==1, f"old_string not unique ({t.count(o)} matches)"; p.write_text(t.replace(o,n))`;
        const cmd = `python3 -c ${shellQuote(py)} ${shellQuote(p.filepath)} ${shellQuote(p.oldString)} ${shellQuote(p.newString)}`;
        return JSON.stringify({ [ToolBridge.pickField(props, F_CMD)]: cmd });
      }
      return JSON.stringify(payload);
    }

    if ("mkdir" in a) {
      const p = a.mkdir;
      if (lower.includes("bash") || lower.includes("shell") || lower === "terminal") {
        return JSON.stringify({
          [ToolBridge.pickField(props, F_CMD)]: `mkdir -p ${shellQuote(p.directory_path)}`,
        });
      }
      return JSON.stringify({ [ToolBridge.pickField(props, F_DIR)]: p.directory_path });
    }

    if ("listDirectory" in a || "scanDirectoryTree" in a) {
      const p = ("listDirectory" in a ? a.listDirectory : a.scanDirectoryTree);
      if (lower.includes("bash") || lower.includes("shell")) {
        return JSON.stringify({
          [ToolBridge.pickField(props, F_CMD)]: `ls -la ${shellQuote(p.directory)}`,
        });
      }
      return JSON.stringify({ [ToolBridge.pickField(props, F_PATH)]: p.directory });
    }

    if ("findFiles" in a) {
      const p = a.findFiles;
      if (lower.includes("glob")) {
        const out: Record<string, unknown> = {
          [ToolBridge.pickField(props, F_PATTERN)]: p.name_pattern,
        };
        if (p.search_directory) out[ToolBridge.pickField(props, F_PATH)] = p.search_directory;
        return JSON.stringify(out);
      }
      if (lower.includes("bash") || lower.includes("shell")) {
        const dir = p.search_directory || ".";
        return JSON.stringify({
          [ToolBridge.pickField(props, F_CMD)]: `find ${shellQuote(dir)} -name ${shellQuote(p.name_pattern)}`,
        });
      }
      return JSON.stringify(payload);
    }

    if ("grep" in a || "runGrep" in a) {
      const p = ("grep" in a ? a.grep : a.runGrep);
      if (lower.includes("grep") || lower.includes("search")) {
        const out: Record<string, unknown> = {
          [ToolBridge.pickField(props, F_PATTERN)]: p.pattern,
        };
        if (p.search_directory) out[ToolBridge.pickField(props, F_PATH)] = p.search_directory;
        if (p.case_insensitive) out["-i"] = true;
        return JSON.stringify(out);
      }
      // Bash-emulation: real `grep -rn` matches what the upstream tool
      // schema expects (line numbers + path + match, recursive into dir).
      if (lower.includes("bash") || lower.includes("shell") || lower === "terminal") {
        const dir = p.search_directory || ".";
        const flags = ["-rn", p.case_insensitive ? "-i" : ""].filter(Boolean).join(" ");
        const cmd = `grep ${flags} ${shellQuote(p.pattern)} ${shellQuote(dir)} || true`;
        return JSON.stringify({ [ToolBridge.pickField(props, F_CMD)]: cmd });
      }
      return JSON.stringify(payload);
    }

    if ("runHTTPRequest" in a) {
      const p = a.runHTTPRequest;
      if (lower.includes("fetch") || lower.includes("http")) {
        return JSON.stringify({
          url: p.url,
          method: p.method,
          ...(p.headers ? { headers: p.headers } : {}),
          ...(p.body ? { body: p.body } : {}),
        });
      }
      if (lower.includes("bash") || lower.includes("shell") || lower === "terminal") {
        const parts: string[] = ["curl", "-fsSL", "-X", p.method.toUpperCase()];
        for (const [k, v] of Object.entries(p.headers ?? {})) {
          parts.push("-H", shellQuote(`${k}: ${v}`));
        }
        if (p.body) parts.push("--data-raw", shellQuote(p.body));
        parts.push(shellQuote(p.url));
        return JSON.stringify({ [ToolBridge.pickField(props, F_CMD)]: parts.join(" ") });
      }
      return JSON.stringify(payload);
    }

    if ("runWebSearch" in a) {
      const p = a.runWebSearch;
      // Native web-search tool: pass query straight through.
      if (lower.includes("search") || lower.includes("web")) {
        const out: Record<string, unknown> = {
          [ToolBridge.pickField(props, ["query", "q", "search", "term"])]: p.query,
        };
        if (p.max_results !== undefined) {
          out[ToolBridge.pickField(props, ["max_results", "limit", "count"])] = p.max_results;
        }
        return JSON.stringify(out);
      }
      // WebFetch fallback — synthesize a search-engine URL.
      if (lower.includes("fetch") || lower.includes("http")) {
        const url = `https://duckduckgo.com/?q=${encodeURIComponent(p.query)}`;
        return JSON.stringify({ url, method: "GET" });
      }
      // Bash fallback — best-effort curl to a search engine.
      if (lower.includes("bash") || lower.includes("shell") || lower === "terminal") {
        const url = `https://duckduckgo.com/?q=${encodeURIComponent(p.query)}`;
        return JSON.stringify({
          [ToolBridge.pickField(props, F_CMD)]: `curl -fsSL ${shellQuote(url)}`,
        });
      }
      return JSON.stringify(payload);
    }

    if ("runFileSearch" in a) {
      const p = a.runFileSearch;
      // Native semantic search — pass through.
      if (lower.includes("file_search") || lower.includes("semantic")) {
        const out: Record<string, unknown> = {
          [ToolBridge.pickField(props, ["query", "q", "search", "term"])]: p.query,
        };
        if (p.search_directory) out[ToolBridge.pickField(props, F_PATH)] = p.search_directory;
        if (p.max_results !== undefined) {
          out[ToolBridge.pickField(props, ["max_results", "limit", "count"])] = p.max_results;
        }
        return JSON.stringify(out);
      }
      // Grep degradation — treat the natural-language query as a literal pattern.
      if (lower.includes("grep") || lower.includes("search") || lower.includes("ripgrep")) {
        const out: Record<string, unknown> = {
          [ToolBridge.pickField(props, F_PATTERN)]: p.query,
        };
        if (p.search_directory) out[ToolBridge.pickField(props, F_PATH)] = p.search_directory;
        return JSON.stringify(out);
      }
      // Bash fallback — recursive grep, tolerate no matches.
      if (lower.includes("bash") || lower.includes("shell") || lower === "terminal") {
        const dir = p.search_directory || ".";
        const cmd = `grep -rn ${shellQuote(p.query)} ${shellQuote(dir)} || true`;
        return JSON.stringify({ [ToolBridge.pickField(props, F_CMD)]: cmd });
      }
      return JSON.stringify(payload);
    }

    if ("runMCPCall" in a) {
      const p = a.runMCPCall;
      // MCP tool args are already a structured object — forward verbatim.
      // The matched tool's schema will reshape if needed via pickField, but
      // most MCP tools accept the upstream property names as-is.
      return JSON.stringify(p.arguments ?? {});
    }

    return JSON.stringify(payload);
  }

  /** Strip the requestID off and return just the action's payload. */
  private static payload(a: ServerAction): unknown {
    const { requestID: _id, ...rest } = a as { requestID: string; [k: string]: unknown };
    // `rest` has exactly one key: the action kind itself. Return its value so
    // the JSON shape matches the upstream schema.
    const keys = Object.keys(rest);
    const first = keys[0];
    if (keys.length === 1 && first !== undefined) return rest[first];
    return rest;
  }
}

/** Minimal POSIX-shell quoter for `Bash` fallbacks. */
function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./@:+,=%-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
