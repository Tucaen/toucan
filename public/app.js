const app = document.querySelector("#app");
let state = null;
let viewMode = localStorage.getItem("ade-view") ?? "canvas";
let showTimeline = false;
let requestDraft = "";
let requestPending = false;
let errorMessage = "";
const answerDrafts = new Map();

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function statusLabel(status) {
  return ({ starting: "Starting", working: "Working", waiting: "Needs input", completed: "Completed", failed: "Failed" })[status] ?? status;
}

function openQuestionFor(session) {
  return state.questions.find((question) => question.sessionId === session.id && question.status === "open");
}

function answerForm(question, source) {
  const draft = answerDrafts.get(question.id) ?? "";
  return `<form class="answer-form" data-answer-form data-question="${escapeHtml(question.id)}" data-source="${source}">
    <textarea data-answer-draft="${escapeHtml(question.id)}" aria-label="Answer clarification" placeholder="Type your answer…">${escapeHtml(draft)}</textarea>
    <button type="submit">Answer</button>
  </form>`;
}

function sessionCard(session, flow = false) {
  const question = openQuestionFor(session);
  const body = question
    ? `<div class="question-label">Question from ${escapeHtml(session.provider)}</div><p class="question-copy">${escapeHtml(question.text)}</p>${answerForm(question, "session")}`
    : `<p>${escapeHtml(session.summary)}</p><div class="activity">› ${escapeHtml(session.activity)}</div>${session.outcome ? `<p class="outcome">${escapeHtml(session.outcome)}</p>` : ""}`;
  const style = flow ? "" : `style="left:${session.x}px;top:${session.y}px"`;
  return `<article class="session-node ${question ? "needs-input" : ""}" ${style}>
    <header class="node-header"><span class="dot ${escapeHtml(session.status)}"></span><span class="node-title" title="${escapeHtml(session.title)}">${escapeHtml(session.title)}</span><span class="spacer"></span><span class="provider" title="${escapeHtml(session.provider)}">${escapeHtml(session.provider)}</span></header>
    <div class="node-body">${body}</div>
    <footer class="node-footer"><span>${escapeHtml(statusLabel(session.status))}</span><span class="spacer"></span><span>read-only Project context</span></footer>
  </article>`;
}

function canvas() {
  if (!state.sessions.length) {
    return `<section class="canvas"><div class="empty-canvas"><div class="empty-card"><h2>This Project canvas is empty</h2><p>Ask the Coordinator for an outcome. It will create bounded Agent Sessions here.</p></div></div></section>`;
  }
  return `<section class="canvas"><div class="canvas-inner">${state.sessions.map((session) => sessionCard(session)).join("")}<span class="canvas-hint">Runtime state places sessions automatically</span></div></section>`;
}

function flowBoard() {
  const lanes = [["explore", "Explore"], ["build", "Working"], ["waiting", "Waiting"], ["review", "Review"]];
  return `<section class="flow-board">${lanes.map(([phase, label]) => {
    const sessions = state.sessions.filter((session) => session.phase === phase);
    return `<section class="flow-lane"><header class="flow-lane-header"><span class="dot ${phase === "build" ? "working" : phase}"></span><span>${label}</span><span class="spacer"></span><span class="count">${sessions.length}</span></header><div class="flow-lane-body">${sessions.length ? sessions.map((session) => sessionCard(session, true)).join("") : '<div class="flow-empty">No sessions here</div>'}</div></section>`;
  }).join("")}</section>`;
}

function conversation() {
  const opening = !state.messages.length
    ? `<div class="chat-message"><span class="coordinator-mark">A</span><div class="chat-copy">I’m ready. Tell me the outcome you want, and I’ll direct bounded Agent Sessions from here.</div></div><p class="thread-empty">Clarifications and Coordinator responses remain in this permanent panel.</p>`
    : "";
  const messages = state.messages.map((message) => message.role === "user"
    ? `<div class="chat-message user">${escapeHtml(message.text)}${message.source ? `<div class="chat-meta">via ${escapeHtml(message.source)}</div>` : ""}</div>`
    : `<div class="chat-message"><span class="coordinator-mark">A</span><div class="chat-copy">${escapeHtml(message.text)}${message.provider ? `<div class="chat-meta">${escapeHtml(message.provider)}</div>` : ""}</div></div>`).join("");
  const questions = state.questions.filter((question) => question.status === "open").map((question) => {
    const session = state.sessions.find((candidate) => candidate.id === question.sessionId);
    return `<div class="chat-message"><span class="coordinator-mark">A</span><div class="chat-copy">An Agent Session needs your input.<div class="attention-card"><div class="row"><span class="attention-chip">Needs input</span><span class="muted" style="font-size:10px">from ${escapeHtml(session?.title ?? question.sessionId)}</span></div><p class="question-copy">${escapeHtml(question.text)}</p>${answerForm(question, "coordinator")}</div></div></div>`;
  }).join("");
  return opening + messages + questions;
}

function timeline() {
  if (!showTimeline) return "";
  const events = [...state.events].reverse();
  return `<aside class="timeline"><header class="timeline-header"><h2>Inspectable activity record</h2><span class="spacer"></span><button class="timeline-close" data-toggle-timeline aria-label="Close activity">Close</button></header><ol class="event-list">${events.map((event) => `<li class="event"><span class="dot ${escapeHtml(event.status)}"></span><div class="event-copy"><div class="event-type">${escapeHtml(event.type)} · ${escapeHtml(event.actor)}</div><div class="event-summary">${escapeHtml(event.summary)}</div><div class="event-time">${escapeHtml(new Date(event.timestamp).toLocaleString())} · ${escapeHtml(event.id)}</div></div></li>`).join("")}</ol></aside>`;
}

function render() {
  if (!state) {
    app.innerHTML = '<div class="empty-canvas"><div class="empty-card"><h2>Starting ADE…</h2></div></div>';
    return;
  }
  const openQuestions = state.questions.filter((question) => question.status === "open").length;
  const active = state.coordinatorStatus === "working" || state.sessions.some((session) => ["starting", "working", "waiting"].includes(session.status));
  app.innerHTML = `<div class="shell">
    <aside class="rail">
      <div class="brand"><span class="brand-mark">A</span>ADE</div>
      <button class="primary" data-focus-composer ${active ? "disabled" : ""}>＋ New request</button>
      <div class="rail-heading">Project</div>
      <button class="project-row"><span class="project-glyph">${escapeHtml(state.project.name.slice(0, 2).toUpperCase())}</span><span>${escapeHtml(state.project.name)}</span><span class="spacer"></span>${openQuestions ? '<span class="dot waiting"></span>' : ""}<span class="count">${state.sessions.length}</span></button>
      <div class="project-path">${escapeHtml(state.project.path)}</div>
      <div class="rail-heading">Workspace</div>
      <div class="rail-copy">Canvas preserves the approved interaction. Flow arranges actual sessions by runtime status.</div>
      <div class="rail-footer row"><span class="dot ${state.coordinatorStatus === "working" ? "working" : ""}"></span><span>Local runtime</span><span class="spacer"></span><button class="event-button" data-toggle-timeline>Activity ${state.events.length}</button></div>
    </aside>
    <main class="workspace">
      <header class="toolbar"><span class="workspace-title">${escapeHtml(state.project.name)}</span><span class="workspace-subtitle">${viewMode === "canvas" ? "Project canvas" : "Automatic status view"}</span><span class="spacer"></span><div class="view-switch"><button data-view="canvas" class="${viewMode === "canvas" ? "active" : ""}">Canvas</button><button data-view="flow" class="${viewMode === "flow" ? "active" : ""}">Flow</button></div><span class="muted" style="font-size:11px">${state.sessions.length} sessions</span></header>
      ${viewMode === "canvas" ? canvas() : flowBoard()}
    </main>
    <aside class="coordinator">
      <header class="coordinator-header"><span class="dot ${state.coordinatorStatus === "working" ? "working" : ""}"></span><strong>Coordinator</strong><span class="spacer"></span>${openQuestions ? `<span class="attention-chip"><span class="dot waiting"></span>${openQuestions} question${openQuestions === 1 ? "" : "s"}</span>` : '<span class="muted" style="font-size:10px">Primary conversation</span>'}</header>
      <div class="thread">${conversation()}</div>
      ${errorMessage ? `<div class="error-banner">${escapeHtml(errorMessage)}</div>` : ""}
      <div class="compose-wrap"><form class="composer" data-request-form><textarea data-request-draft aria-label="Message the Coordinator" placeholder="What should we work on in ${escapeHtml(state.project.name)}?" ${active ? "disabled" : ""}>${escapeHtml(requestDraft)}</textarea><div class="composer-footer"><span class="project-chip"><span class="dot working"></span>${escapeHtml(state.project.name)}</span><span class="muted" style="font-size:10px">multiline · Ctrl+Enter to send</span><span class="spacer"></span><button class="send" type="submit" aria-label="Send request" ${active || requestPending ? "disabled" : ""}>↑</button></div></form></div>
    </aside>
    ${timeline()}
  </div>`;
  requestAnimationFrame(() => {
    const thread = document.querySelector(".thread");
    if (thread) thread.scrollTop = thread.scrollHeight;
  });
}

async function postJson(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
  return result;
}

async function submitRequest() {
  const request = requestDraft.trim();
  if (!request || requestPending) return;
  requestPending = true;
  errorMessage = "";
  render();
  try {
    await postJson("/api/requests", { request });
    requestDraft = "";
  } catch (error) {
    errorMessage = error.message;
  } finally {
    requestPending = false;
    render();
  }
}

app.addEventListener("input", (event) => {
  if (event.target.matches("[data-request-draft]")) requestDraft = event.target.value;
  if (event.target.matches("[data-answer-draft]")) answerDrafts.set(event.target.dataset.answerDraft, event.target.value);
});

app.addEventListener("keydown", (event) => {
  if (event.target.matches("[data-request-draft]") && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void submitRequest();
  }
});

app.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.target.matches("[data-request-form]")) {
    await submitRequest();
    return;
  }
  if (event.target.matches("[data-answer-form]")) {
    const questionId = event.target.dataset.question;
    const answer = answerDrafts.get(questionId)?.trim();
    if (!answer) return;
    errorMessage = "";
    try {
      await postJson(`/api/questions/${encodeURIComponent(questionId)}/answer`, { answer, source: event.target.dataset.source });
      answerDrafts.delete(questionId);
    } catch (error) {
      errorMessage = error.message;
      render();
    }
  }
});

app.addEventListener("click", (event) => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) {
    viewMode = viewButton.dataset.view;
    localStorage.setItem("ade-view", viewMode);
    render();
  }
  if (event.target.closest("[data-toggle-timeline]")) {
    showTimeline = !showTimeline;
    render();
  }
  if (event.target.closest("[data-focus-composer]")) document.querySelector("[data-request-draft]")?.focus();
});

async function connect() {
  const response = await fetch("/api/state");
  state = await response.json();
  render();
  const events = new EventSource("/api/events");
  events.addEventListener("state", (message) => {
    const payload = JSON.parse(message.data);
    state = payload.state;
    render();
  });
  events.onerror = () => {
    errorMessage = "Live updates disconnected; reconnecting…";
    render();
  };
  events.onopen = () => {
    if (errorMessage.startsWith("Live updates disconnected")) errorMessage = "";
  };
}

connect().catch((error) => {
  app.innerHTML = `<div class="empty-canvas"><div class="empty-card"><h2>ADE could not start</h2><p>${escapeHtml(error.message)}</p></div></div>`;
});
