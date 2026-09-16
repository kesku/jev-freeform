#!/usr/bin/env node
import http from "node:http";
import { readApiKey } from "./config.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { stallReason, budgetReason } from "./guards.mjs";
import { search } from "./search.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4177" },
    "key-file": { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log("node main.mjs [--port 4177] [--key-file PATH]");
  process.exit(0);
}
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw Error("Invalid --port");
const runRoot = path.join(here, "runs");
fs.mkdirSync(runRoot, { recursive: true });

const sessions = new Map();
const charBase =
  "\n\t" +
  Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");

function candidates(s) {
  const tokens = [...charBase];
  const map = {};
  let i = 0;
  for (const token of tokens) {
    const id = "t_" + String(i++).padStart(3, "0");
    if (!s?.excluded?.includes(token)) map[id] = token;
  }
  map.EOS = "EOS";
  return map;
}
function percentile(values, p) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((a.length - 1) * p))];
}
export function createSession({
  prompt,
  conversation = [],
  representation = "text",
  decoder = "search",
  callBudget = 120,
  tokenBudget = 500000,
  timeBudgetMs = 60000,
}) {
  if (typeof prompt !== "string" || !prompt.trim())
    throw Error("Message is required");
  const task = { id: "chat", prompt: prompt.trim() };
  const id = crypto.randomUUID();
  const dir = fs.mkdtempSync(path.join(runRoot, id + "-"));
  const s = {
    id,
    dir,
    task,
    conversation: Array.isArray(conversation)
      ? conversation.map((x) => ({
          role: x.role === "assistant" ? "assistant" : "user",
          content: String(x.content),
        }))
      : [],
    mode: "character",
    code: "",
    steps: [],
    status: "ready",
    reason: null,
    callBudget: Math.min(Math.max(Number(callBudget) || 120, 1), 300),
    tokenBudget: Math.min(Math.max(Number(tokenBudget) || 500000, 1), 2000000),
    timeBudgetMs: Math.min(
      Math.max(Number(timeBudgetMs) || 60000, 1000),
      600000,
    ),
    startedAt: null,
    usage: { input: 0, output: 0 },
    test: null,
    feedback: null,
    recoveries: 0,
    excluded: [],
    representation,
    decoder: decoder === "greedy" ? "greedy" : "search",
    searchCredits: 0,
  };
  sessions.set(id, s);
  save(s);
  return s;
}
function publicSession(s) {
  const l = s.steps.at(-1);
  const latencies = s.steps.map((x) => x.latencyMs);
  return {
    id: s.id,
    decoder: s.decoder,
    searchFrontier: s.searchFrontier || [],
    task: s.task,
    mode: s.mode,
    code: s.code,
    status: s.status,
    reason: s.reason,
    callBudget: s.callBudget,
    tokenBudget: s.tokenBudget,
    timeBudgetMs: s.timeBudgetMs,
    usage: s.usage,
    elapsedMs: s.startedAt ? (s.endedAt || Date.now()) - s.startedAt : 0,
    steps: s.steps,
    candidates: l?.candidates || Object.values(candidates(s)),
    last: l
      ? {
          selected: l.selected,
          confidence: l.confidence,
          top: l.top,
          request: l.request,
          response: l.response,
          accepted: l.accepted,
          syntax: l.syntax,
        }
      : null,
    metrics: {
      calls: s.steps.length,
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      syntaxErrors: s.steps.filter((x) => x.syntax?.ok === false).length,
    },
    test: s.test,
    feedback: s.feedback,
  };
}
function save(s) {
  fs.writeFileSync(
    path.join(s.dir, "session.json"),
    JSON.stringify(publicSession(s), null, 2),
  );
  fs.writeFileSync(
    path.join(s.dir, "trace.jsonl"),
    s.steps.map((x) => JSON.stringify(x)).join("\n") +
      (s.steps.length ? "\n" : ""),
  );
}
export function stop(s, reason = "user_stop") {
  if (["ready", "running"].includes(s.status)) {
    s.status = "stopped";
    s.reason = reason;
    s.endedAt = Date.now();
    s.releaseSearch?.();
    s.resolveSearchStep?.(publicSession(s));
    s.resolveSearchStep = null;
    save(s);
  }
  return publicSession(s);
}
export function step(s, evaluator) {
  if (s.pending) return s.pending;
  s.pending = advance(s, evaluator).finally(() => {
    s.pending = null;
  });
  return s.pending;
}
async function advance(
  s,
  evaluator = async (request, timeout) => {
    const r = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + readApiKey(values["key-file"]),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) throw Error("TypeSafe HTTP " + r.status);
    return r.json();
  },
) {
  if (s.decoder === "search") return advanceSearch(s, evaluator);
  if (s.status === "ready") {
    s.status = "running";
    s.startedAt = Date.now();
  }
  if (s.status !== "running") return publicSession(s);
  const limit = budgetReason(s);
  if (limit) return stop(s, limit);
  const options = candidates(s);
  const criteria = Object.fromEntries(
    Object.entries(options).map(([id, t]) => [
      id,
      id === "EOS"
        ? "The assistant reply is complete. End the reply."
        : "Resulting assistant reply prefix (JSON-encoded): " +
          JSON.stringify(s.code + t),
    ]),
  );
  const request = {
    model: "jev-latest",
    state: {
      conversation: s.conversation,
      user_message: s.task.prompt,
      assistant_reply_so_far: s.code,
    },
    questions: {
      next: {
        type: "choice",
        instructions:
          "Continue a helpful, concise conversational assistant reply to the user. Each option shows the entire reply prefix after appending one raw character. Select the most natural next prefix, preserving all existing text. Partial words are expected. Answer the user directly in plain text. Choose EOS when the reply is complete. Do not describe the selection process.",
        criteria,
      },
    },
  };
  if (s.representation === "array") {
    request.state.prefix_characters = [...s.code];
    request.questions.next.criteria = Object.fromEntries(
      Object.entries(options).map(([id, t]) => [
        id,
        id === "EOS"
          ? "The assistant reply is complete. End the reply."
          : "Resulting characters: " + JSON.stringify([...s.code, t]),
      ]),
    );
    request.questions.next.instructions =
      "Continue a helpful conversational reply, exactly one character at a time. Each candidate is the complete character array after adding ONE character. Continue spelling the current word before adding a space. Never skip a letter. Answer the user directly and briefly. Choose EOS when the reply is complete.";
  }
  const before = performance.now();
  let response;
  let timer;
  const remaining = Math.max(1, s.timeBudgetMs - (Date.now() - s.startedAt));
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      stop(s, "time_budget");
      reject(Error("time_budget"));
    }, remaining);
  });
  try {
    response = await Promise.race([
      evaluator(request, Math.min(30000, remaining)),
      deadline,
    ]);
  } catch (e) {
    if (s.status === "running") {
      s.status = "error";
      s.reason = e.message;
      s.endedAt = Date.now();
    }
    s.steps.push({
      n: s.steps.length + 1,
      at: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - before),
      request,
      response: null,
      selected: null,
      accepted: false,
      disposition: s.reason,
      error: e.message,
      top: [],
      candidates: Object.values(options),
    });
    save(s);
    return publicSession(s);
  } finally {
    clearTimeout(timer);
  }

  s.usage.input += Number.isFinite(response?.usage?.input_tokens)
    ? response.usage.input_tokens
    : 0;
  s.usage.output += Number.isFinite(response?.usage?.output_tokens)
    ? response.usage.output_tokens
    : 0;
  const a = response?.answers?.next;
  if (
    !a ||
    !Object.hasOwn(options, a.choice) ||
    !a.probabilities ||
    typeof a.probabilities !== "object"
  ) {
    if (s.status === "running") {
      s.status = "error";
      s.reason = "invalid Choice response";
      s.endedAt = Date.now();
    }
    s.steps.push({
      n: s.steps.length + 1,
      at: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - before),
      request,
      response,
      selected: null,
      accepted: false,
      disposition: s.reason,
      error: "Invalid Choice response",
      top: [],
      candidates: Object.values(options),
    });
    save(s);
    return publicSession(s);
  }
  const selected = options[a.choice],
    top = Object.entries(a.probabilities || {})
      .sort((x, y) => y[1] - x[1])
      .slice(0, 12)
      .map(([id, p]) => ({ token: options[id], id, probability: p }));
  const item = {
    n: s.steps.length + 1,
    at: new Date().toISOString(),
    latencyMs: Math.round(performance.now() - before),
    candidates: Object.values(options),
    selected,
    confidence: a.confidence,
    top,
    request,
    response,
    accepted: false,
    disposition: null,
  };
  if (s.status !== "running") {
    item.disposition = "discarded_after_" + s.reason;
  } else if (Date.now() - s.startedAt >= s.timeBudgetMs) {
    stop(s, "time_budget");
    item.disposition = "discarded_after_time_budget";
  } else if (selected === "EOS") {
    s.status = "finished";
    s.reason = s.code.trim() ? "model_eos" : "empty_reply";
    item.disposition = s.reason;
  } else {
    const stalled = stallReason(s.code + selected);
    if (stalled) {
      item.disposition = "rejected_" + stalled;
      if (s.recoveries >= 3) {
        s.status = "stalled";
        s.reason = "recovery_exhausted";
      } else {
        s.recoveries++;
        item.recovery = {
          attempt: s.recoveries,
          reason: stalled,
          before: s.code,
        };
        if (stalled === "repeated_whitespace") {
          s.code = s.code.replace(/\s+$/, " ");
          s.excluded = [" ", "\n", "\t"];
        } else {
          s.excluded = [...new Set([...s.excluded, selected])];
        }
        item.recovery.after = s.code;
        item.recovery.excluded = [...s.excluded];
        item.disposition = "recovering_" + stalled;
      }
    } else {
      s.code += selected;
      item.accepted = true;
      item.disposition = "appended";
      s.excluded = [];
    }
  }
  if (s.status !== "running") s.endedAt ??= Date.now();
  s.steps.push(item);
  if (s.status === "running") {
    const limit = budgetReason(s);
    if (limit) stop(s, limit);
  }
  save(s);
  return publicSession(s);
}
async function advanceSearch(s, evaluate) {
  if (!["ready", "running"].includes(s.status)) return publicSession(s);
  s.status = "running";
  s.startedAt ??= Date.now();
  const result = new Promise((resolve) => {
    s.resolveSearchStep = resolve;
  });
  s.searchCredits++;
  const flush = () => {
    s.resolveSearchStep?.(publicSession(s));
    s.resolveSearchStep = null;
  };
  if (!s.searchRunner) {
    s.searchRunner = search({
      prompt: s.task.prompt,
      conversation: s.conversation,
      maxCalls: s.callBudget,
      maxTokens: s.tokenBudget,
      maxMs: s.timeBudgetMs,
      evaluate,
      isStopped: () => s.status !== "running",
      beforeCall: async () => {
        if (s.status !== "running") return;
        if (s.searchCredits > 0) {
          s.searchCredits--;
          return;
        }
        flush();
        await new Promise((resolve) => {
          s.releaseSearch = resolve;
        });
        s.releaseSearch = null;
        s.searchCredits = Math.max(0, s.searchCredits - 1);
      },
      onTrace: (event) => {
        const a = event.response?.answers?.decision;
        const criteria = event.request.questions.decision.criteria;
        const top = Object.entries(a?.probabilities || {})
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([id, p]) => ({ id, token: criteria[id], probability: p }));
        s.usage.input += event.response?.usage?.input_tokens || 0;
        s.usage.output += event.response?.usage?.output_tokens || 0;
        s.steps.push({
          n: s.steps.length + 1,
          at: new Date().toISOString(),
          ...event,
          selected: criteria[a?.choice] || a?.choice || null,
          confidence: a?.confidence,
          top,
          candidates: Object.values(criteria),
          accepted: s.status === "running" && !event.error,
          disposition: event.error
            ? "api_error"
            : s.status === "running"
              ? event.phase
              : "discarded_after_" + s.reason,
        });
        save(s);
      },
      onUpdate: (event) => {
        if (s.status !== "running") return;
        const before = s.code;
        s.code = event.best;
        s.searchFrontier = event.frontier;
        if (s.steps.length) {
          const last = s.steps.at(-1);
          last.recovery = {
            phase: "search",
            before,
            after: s.code,
            backtracked: !s.code.startsWith(before),
            frontier: event.frontier,
          };
        }
        save(s);
      },
    })
      .then((outcome) => {
        if (s.status === "running") {
          s.code = outcome.reply;
          s.status =
            outcome.reason === "model_judged_complete"
              ? "finished"
              : [
                    "search_budget",
                    "no_branches",
                    "all_branches_rejected",
                    "user_stop",
                  ].includes(outcome.reason)
                ? "stopped"
                : "error";
          s.reason = outcome.reason;
          s.endedAt = Date.now();
          s.searchTrace = outcome.dir;
        }
        save(s);
        flush();
      })
      .catch((error) => {
        if (s.status === "running") {
          s.status = "error";
          s.reason = error.message;
          s.endedAt = Date.now();
        }
        save(s);
        flush();
      });
  } else if (s.releaseSearch) s.releaseSearch();
  return result;
}
function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}
function body(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (d) => {
      data += d;
      if (data.length > 1e6) reject(Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(Error("invalid JSON"));
      }
    });
  });
}
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://localhost");
    if (req.method === "GET" && u.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(path.join(here, "public/index.html")));
    }
    if (
      req.method === "GET" &&
      ["/app.js", "/styles.css"].includes(u.pathname)
    ) {
      res.writeHead(200, {
        "Content-Type": u.pathname.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : "text/css; charset=utf-8",
      });
      return res.end(
        fs.readFileSync(path.join(here, "public", u.pathname.slice(1))),
      );
    }
    if (req.method === "GET" && u.pathname === "/api/tasks")
      return json(res, 200, []);
    if (req.method === "POST" && u.pathname === "/api/sessions") {
      const b = await body(req);
      return json(res, 201, publicSession(createSession(b)));
    }
    const match = u.pathname.match(
      /^\/api\/sessions\/([0-9a-f-]+)(?:\/(step|stop|reset))?$/,
    );
    if (!match) return json(res, 404, { error: "not found" });
    const s = sessions.get(match[1]);
    if (!s) return json(res, 404, { error: "unknown session" });
    if (req.method === "GET") return json(res, 200, publicSession(s));
    if (req.method === "POST" && match[2] === "step")
      return json(res, 200, await step(s));
    if (req.method === "POST" && match[2] === "stop")
      return json(res, 200, stop(s));
    if (req.method === "POST" && match[2] === "reset") {
      const fresh = createSession({
        prompt: s.task.prompt,
        conversation: s.conversation,
        callBudget: s.callBudget,
        tokenBudget: s.tokenBudget,
        timeBudgetMs: s.timeBudgetMs,
      });
      return json(res, 201, publicSession(fresh));
    }
    return json(res, 405, { error: "method not allowed" });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  server.listen(port, "127.0.0.1", () =>
    console.log(`Jev Freeform on http://127.0.0.1:${port}`),
  );
