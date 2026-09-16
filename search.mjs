import { readApiKey } from "./config.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stallReason } from "./guards.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const alphabet = [
  ..."\n\t",
  ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 32)),
];
export async function search({
  prompt,
  conversation = [],
  maxCalls = 60,
  maxTokens = 300000,
  maxMs = 60000,
  width = 3,
  onUpdate = () => {},
  onTrace = () => {},
  beforeCall = async () => {},
  isStopped = () => false,
  evaluate,
} = {}) {
  const dir = fs.mkdtempSync(path.join(here, "search-"));
  const started = Date.now();
  let calls = 0,
    input = 0,
    output = 0,
    reason = "search_budget",
    winner = null;
  let frontier = [{ text: "", score: 0 }],
    archive = [],
    best = "";
  const expanded = new Set(),
    rejected = new Set();
  const key = evaluate ? null : readApiKey();
  async function ask(phase, state, criteria, instructions) {
    await beforeCall();
    if (isStopped()) throw Error("user_stop");
    if (
      calls >= maxCalls ||
      input + output >= maxTokens ||
      Date.now() - started >= maxMs
    )
      throw Error("search_budget");
    const request = {
      model: "jev-latest",
      state: { user_message: prompt, conversation, ...state },
      questions: { decision: { type: "choice", instructions, criteria } },
    };
    const t = Date.now();
    calls++;
    let response;
    try {
      if (evaluate)
        response = await evaluate(
          request,
          Math.min(15000, Math.max(1, maxMs - (Date.now() - started))),
        );
      else {
        const r = await fetch("https://api.typesafe.ai/v1/systemone", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + key,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(
            Math.min(15000, Math.max(1, maxMs - (Date.now() - started))),
          ),
        });
        if (!r.ok) throw Error("HTTP " + r.status);
        response = await r.json();
      }
    } catch (error) {
      const event = {
        phase,
        latencyMs: Date.now() - t,
        request,
        response: null,
        error: error.message,
      };
      fs.appendFileSync(
        path.join(dir, "trace.jsonl"),
        JSON.stringify(event) + "\n",
      );
      onTrace(event);
      throw error;
    }
    input += response.usage?.input_tokens || 0;
    output += response.usage?.output_tokens || 0;
    const event = { phase, latencyMs: Date.now() - t, request, response };
    fs.appendFileSync(
      path.join(dir, "trace.jsonl"),
      JSON.stringify(event) + "\n",
    );
    onTrace(event);
    if (isStopped()) throw Error("user_stop");
    if (Date.now() - started >= maxMs) throw Error("search_budget");
    const a = response.answers?.decision;
    if (
      !a ||
      !Object.hasOwn(criteria, a.choice) ||
      !a.probabilities ||
      typeof a.probabilities !== "object"
    )
      throw Error("invalid_response");
    return a;
  }
  try {
    while (frontier.length) {
      const next = [];
      const completions = [];
      for (const parent of frontier) {
        if (expanded.has(parent.text)) continue;
        expanded.add(parent.text);
        const chars = Object.fromEntries(alphabet.map((c, i) => ["c" + i, c]));
        chars.EOS = "EOS";
        const criteria = Object.fromEntries(
          Object.entries(chars).map(([id, c]) => [
            id,
            id === "EOS"
              ? "End this reply now."
              : "Resulting reply prefix: " + JSON.stringify(parent.text + c),
          ]),
        );
        const a = await ask(
          "expand",
          { prefix: parent.text },
          criteria,
          "Select the next raw character of a concise, helpful reply. The prefix may end inside a word; finish its spelling. Options show the entire prefix after appending a character. EOS ends the reply.",
        );
        const ranked = Object.entries(a.probabilities)
          .filter(([id, p]) => Object.hasOwn(chars, id) && p > 0)
          .sort((a, b) => b[1] - a[1]);
        for (const [id, p] of ranked.slice(0, parent.text.length ? 5 : 12)) {
          if (id === "EOS") {
            if (parent.text.trim()) completions.push(parent);
            continue;
          }
          const text = parent.text + chars[id];
          if ((!parent.text || /\s$/.test(parent.text)) && /\s/.test(chars[id]))
            continue;
          if (stallReason(text) || rejected.has(text)) continue;
          next.push({ text, score: parent.score + Math.log(p) });
        }
      }
      for (const candidate of completions.slice(0, 2)) {
        const a = await ask(
          "completion_check",
          { reply: candidate.text },
          {
            complete:
              "The reply is meaningful, grammatical, complete, and directly answers the user.",
            incomplete:
              "The reply could become a good answer by appending more characters.",
            invalid:
              "The reply is malformed, repetitive, irrelevant, or factually wrong; appending alone is unlikely to fix it.",
          },
          "Classify this proposed assistant reply. A lone article or partial word is not a complete answer. Judge the user request, not just whether the text resembles a greeting.",
        );
        if (a.choice === "complete") {
          winner = candidate.text;
          reason = "model_judged_complete";
          break;
        }
        if (a.choice === "invalid") rejected.add(candidate.text);
      }
      if (winner !== null) break;
      const available = [
        ...new Map(
          [...next, ...archive]
            .filter((x) => !expanded.has(x.text) && !rejected.has(x.text))
            .map((x) => [x.text, x]),
        ).values(),
      ].sort(
        (a, b) =>
          b.score / Math.max(1, b.text.length) -
          a.score / Math.max(1, a.text.length),
      );
      const pool = available.slice(0, 40);
      if (!pool.length) {
        reason = "no_branches";
        break;
      }
      const criteria = Object.fromEntries(
        pool.map((x, i) => [
          "branch" + i,
          "Partial reply " + JSON.stringify(x.text),
        ]),
      );
      criteria.BACKTRACK =
        "None of these prefixes can become a coherent relevant answer. Backtrack.";
      const a = await ask(
        "compare",
        { previous_best: best },
        criteria,
        "Which partial reply can become a correctly spelled, grammatically correct answer by APPENDING characters only? Judge the exact characters literally. Do not silently repair missing letters, apostrophes, or misplaced spaces. An unfinished last word is allowed, but earlier completed words must be spelled correctly and form a grammatical sentence beginning. Prefer the most relevant natural continuation. Backtrack if none can be repaired by appending.",
      );
      if (a.choice === "BACKTRACK") {
        for (const item of pool) rejected.add(item.text);
        frontier = available.slice(40, 40 + width);
        archive = available.slice(40 + width, 128);
        if (!frontier.length) {
          reason = "all_branches_rejected";
          break;
        }
      } else {
        const chosen = pool[Number(a.choice.slice(6))];
        best = chosen.text;
        const ranked = Object.entries(a.probabilities)
          .filter(([id]) => id.startsWith("branch"))
          .sort((a, b) => b[1] - a[1])
          .map(([id]) => pool[Number(id.slice(6))])
          .filter(Boolean);
        frontier = [chosen, ...ranked.filter((x) => x !== chosen)].slice(
          0,
          width,
        );
        archive = available.filter((x) => !frontier.includes(x)).slice(0, 128);
      }
      onUpdate({
        best,
        frontier: frontier.map((x) => x.text),
        calls,
        input,
        output,
      });
      fs.appendFileSync(
        path.join(dir, "branches.jsonl"),
        JSON.stringify({ best, frontier, archive, calls }) + "\n",
      );
    }
  } catch (e) {
    reason = e.message;
  }
  const result = {
    prompt,
    reply: winner ?? best,
    reason,
    calls,
    inputTokens: input,
    outputTokens: output,
    elapsedMs: Date.now() - started,
    dir,
  };
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify(result, null, 2),
  );
  return result;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(
    JSON.stringify(
      await search({
        prompt: process.argv.slice(2).join(" ") || "How are you?",
        onUpdate: (x) => console.log(JSON.stringify(x)),
      }),
      null,
      2,
    ),
  );
}
