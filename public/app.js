const $ = (id) => document.getElementById(id);
let tasks = [],
  turns = [],
  active = null,
  selected = null,
  busy = false,
  paused = false,
  inFlight = false,
  followLatest = true;
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const fmt = (n) => Number(n || 0).toLocaleString();
async function api(url, body) {
  const r = await fetch(
    url,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await r.json();
  if (!r.ok) throw Error(data.error || "Request failed");
  return data;
}
function status(t) {
  if (t.error) return "Request failed";
  if (t.stopped) return "Stopped";
  if (t === active && busy)
    return paused
      ? "Paused"
      : t.session?.steps?.at(-1)?.recovery?.phase === "search"
        ? "Comparing alternatives…"
        : t.session?.steps?.at(-1)?.recovery
          ? "Recovering…"
          : "Writing…";
  const s = t.session;
  if (!s) return "Connecting…";
  if (s.status === "error") return "API error";
  return (
    {
      recovery_exhausted: "Stopped · recovery attempts exhausted",
      repeated_whitespace: "Stalled · repeated whitespace",
      repeated_character: "Stalled · repeated character",
      repeated_pattern: "Stalled · repeated pattern",
      user_stop: "Stopped by you",
      model_judged_complete: "Jev judged reply complete",
      search_budget: "Stopped · search budget",
      no_branches: "Stopped · no viable branches",
      all_branches_rejected: "Stopped · branches rejected",
      model_eos: "Model ended reply",
      empty_reply: "Model ended without an answer",
      call_budget: "Stopped · call limit",
      token_budget: "Stopped · token limit",
      time_budget: "Stopped · time limit",
    }[s.reason] || "Stopped"
  );
}
function paint(t) {
  t.pre.textContent =
    t.session?.code ||
    t.error ||
    (busy ? "Choosing the first continuation…" : "No reply text");
  t.label.textContent = status(t);
  t.meter.textContent = t.session
    ? t.session.metrics.calls +
      " calls · " +
      fmt(t.session.usage.input + t.session.usage.output) +
      " tokens"
    : "";
  $("send").textContent = busy ? "Stop ■" : "Send ↑";
  $("new").disabled = busy || inFlight;
  if (selected === t) inspect();
  const list = $("messages");
  if (list.scrollHeight - list.scrollTop - list.clientHeight < 200)
    list.scrollTop = list.scrollHeight;
}
function choose(t) {
  selected = t;
  followLatest = true;
  $("panel").hidden = false;
  inspect();
}
function inspect() {
  const t = selected;
  if (!t) return;
  const s = t.session;
  $("inspectPrompt").textContent = t.prompt;
  if (!s) return;
  const m = s.metrics;
  $("stats").innerHTML = [
    ["Calls", m.calls],
    ["Reported tokens", fmt(s.usage.input + s.usage.output)],
    ["Input / output", fmt(s.usage.input) + " / " + fmt(s.usage.output)],
    ["Latency p50 / p95", (m.p50Ms ?? "—") + " / " + (m.p95Ms ?? "—") + " ms"],
  ]
    .map(([a, b]) => '<div class="stat">' + a + "<b>" + b + "</b></div>")
    .join("");
  const old = $("decision").value;
  $("decision").innerHTML = s.steps
    .map(
      (d, i) =>
        '<option value="' +
        i +
        '">' +
        d.n +
        ". " +
        esc(JSON.stringify(d.selected)) +
        " · " +
        d.latencyMs +
        " ms</option>",
    )
    .join("");
  $("decision").value = followLatest ? String(s.steps.length - 1) : old;
  const d = s.steps[Number($("decision").value)];
  $("debug").hidden = t !== active || !busy;
  $("step").disabled = !paused || inFlight;
  $("resume").disabled = !paused || inFlight;
  $("pause").disabled = paused;
  $("decisionStatus").textContent = d
    ? (d.disposition || (d.accepted ? "Appended" : "Rejected")) +
      " · confidence " +
      Number(d.confidence).toFixed(3)
    : "Waiting for a decision";
  $("distribution").innerHTML = (d?.top || [])
    .map(
      (x) =>
        '<div class="prob"><div><span>' +
        esc(JSON.stringify(x.token)) +
        "</span><span>" +
        (x.probability * 100).toFixed(1) +
        '%</span></div><div class="track"><div class="fill" style="width:' +
        Math.max(0, Math.min(100, x.probability * 100)) +
        '%"></div></div></div>',
    )
    .join("");
  $("menu").innerHTML = (d?.candidates || s.candidates || [])
    .map((x) => "<code>" + esc(JSON.stringify(x)) + "</code>")
    .join("");
  $("intervention").textContent = JSON.stringify(
    d?.recovery || { disposition: d?.disposition || "No decision yet" },
    null,
    2,
  );
  $("request").textContent = JSON.stringify(d?.request || {}, null, 2);
  $("response").textContent = JSON.stringify(d?.response || {}, null, 2);
}
async function one(t) {
  if (inFlight || t !== active) return;
  inFlight = true;
  try {
    t.session = await api("/api/sessions/" + t.session.id + "/step", {});
    if (active === t && !["ready", "running"].includes(t.session.status)) {
      busy = false;
      active = null;
    }
  } catch (e) {
    t.error = e.message;
    busy = false;
    active = null;
  } finally {
    inFlight = false;
    paint(t);
  }
}
async function loop(t) {
  while (busy && active === t && !paused) {
    await one(t);
    if (busy && !paused) await new Promise((r) => setTimeout(r, 120));
  }
}
async function send() {
  if (busy) {
    const t = active;
    paused = true;
    busy = false;
    t.stopped = true;
    active = null;
    paint(t);
    if (t.session) {
      try {
        t.session = await api("/api/sessions/" + t.session.id + "/stop", {});
      } catch (e) {
        t.error = "Stop failed: " + e.message;
      }
      paint(t);
    }
    return;
  }
  if (inFlight) return;
  const prompt = $("prompt").value.trim();
  if (!prompt) return;
  const conversation = turns.flatMap((t) => [
    { role: "user", content: t.prompt },
    { role: "assistant", content: t.session?.code || "" },
  ]);
  $("empty")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "turn";
  wrap.innerHTML =
    '<div class="user"></div><div class="author">Jev</div><pre class="code"></pre><div class="foot"><span class="label"></span><span class="meter"></span><button>Inspect</button></div>';
  wrap.querySelector(".user").textContent = prompt;
  $("messages").append(wrap);
  const t = {
    prompt,
    pre: wrap.querySelector("pre"),
    label: wrap.querySelector(".label"),
    meter: wrap.querySelector(".meter"),
  };
  wrap.querySelector("button").onclick = () => choose(t);
  turns.push(t);
  active = t;
  busy = true;
  paused = false;
  $("prompt").value = "";
  paint(t);
  $("messages").scrollTop = $("messages").scrollHeight;
  try {
    const matching = tasks.find((x) => x.prompt === prompt);
    t.session = await api("/api/sessions", {
      prompt,
      taskId: matching?.id,
      conversation,
      decoder: $("mode").value,
      callBudget: Number($("budget").value),
    });
    if (!busy || active !== t) {
      t.session = await api("/api/sessions/" + t.session.id + "/stop", {});
      paint(t);
      return;
    }
    paint(t);
    await loop(t);
  } catch (e) {
    t.error = e.message;
    busy = false;
    active = null;
    paint(t);
  }
}
$("form").onsubmit = (e) => {
  e.preventDefault();
  send();
};
$("prompt").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!busy) send();
  }
};
$("inspect").onclick = () => {
  if (!$("panel").hidden) {
    $("panel").hidden = true;
    return;
  }
  if (turns.length) choose(turns.at(-1));
  else $("panel").hidden = false;
};
$("close").onclick = () => ($("panel").hidden = true);
$("decision").onchange = () => {
  followLatest = false;
  inspect();
};
$("pause").onclick = () => {
  paused = true;
  paint(active);
};
$("resume").onclick = () => {
  paused = false;
  loop(active);
};
$("step").onclick = () => one(active);
$("new").onclick = () => {
  if (!busy && !inFlight) location.reload();
};
$("settings").onclick = () => $("config").showModal();
$("saveSettings").onclick = () => {
  $("settings").textContent = "Reply settings";
  $("config").close();
};
document.querySelectorAll("[data-example]").forEach(
  (b) =>
    (b.onclick = () => {
      $("prompt").value =
        b.dataset.example === "hello"
          ? "Hi!"
          : "What is your favorite color? Answer briefly.";
      $("prompt").focus();
    }),
);
$("download").onclick = () => {
  if (!selected?.session) return;
  const url = URL.createObjectURL(
      new Blob([JSON.stringify(selected.session, null, 2)], {
        type: "application/json",
      }),
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = "jev-" + selected.session.id + ".json";
  a.click();
  URL.revokeObjectURL(url);
};
api("/api/tasks")
  .then((t) => (tasks = t))
  .catch((e) => ($("prompt").placeholder = e.message));
