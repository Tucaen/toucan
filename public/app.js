const app = document.querySelector("#app");
let state = null;
let viewMode = localStorage.getItem("ade-view") ?? "canvas";
let openTaskId = null;
let showTimeline = false;
let requestDraft = "";
let requestPending = false;
let errorMessage = "";
const taskDrafts = new Map();
const answerDrafts = new Map();

const STATUS_LABELS = {
  starting: "Starting",
  working: "Working",
  waiting: "Needs input",
  completed: "Completed",
  failed: "Failed",
  unknown: "Outcome unknown"
};
const CARD_COLUMNS = 2;
const CARD_WIDTH = 330;
const CARD_HEIGHT = 250;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function statusLabel(status) {
  return STATUS_LABELS[status] ?? status;
}

function clockTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function openQuestionFor(task) {
  return state.questions.find((question) => question.taskId === task.id && question.status === "open");
}

function answerForm(question, source) {
  const key = `${source}:${question.id}`;
  const draft = answerDrafts.get(key) ?? "";
  return `<form class="answer-form" data-answer-form data-question="${escapeHtml(question.id)}" data-source="${escapeHtml(source)}">
    <textarea data-answer-draft="${escapeHtml(key)}" data-focus-key="answer:${escapeHtml(key)}" aria-label="Answer the task question" placeholder="Type your answer…">${escapeHtml(draft)}</textarea>
    <button type="submit">Answer</button>
  </form>`;
}

/** The collapsed card headlines what the task reported; internal mechanics stay a count. */
function reportedActivity(task, count) {
  const reported = task.activity.filter((entry) => entry.kind === "reported").slice(-count);
  if (reported.length) {
    return reported.map((entry) => `<div class="activity reported">› ${escapeHtml(entry.text)}</div>`).join("");
  }
  if (!task.internalSteps) return "";
  return `<div class="activity">› Working through internal steps (${task.internalSteps} so far).</div>`;
}

function internalSteps(task) {
  if (!task.activity.length) return "";
  const entries = task.activity
    .map((entry) => `<li class="step ${escapeHtml(entry.kind)}"><span class="step-kind">${escapeHtml(entry.kind)}</span><span>${escapeHtml(entry.text)}</span><span class="step-time">${escapeHtml(clockTime(entry.timestamp))}</span></li>`)
    .join("");
  return `<details class="steps"><summary>${task.internalSteps} internal step${task.internalSteps === 1 ? "" : "s"} · most recent below · never a separate card</summary><ol class="step-list">${entries}</ol></details>`;
}

function transcript(task) {
  if (!task.transcript.length) {
    return '<div class="transcript-empty">This task thread has no messages yet.</div>';
  }
  return task.transcript.map((entry) => {
    const meta = entry.source ? `<div class="entry-meta">via ${escapeHtml(entry.source)} · ${escapeHtml(clockTime(entry.timestamp))}</div>` : `<div class="entry-meta">${escapeHtml(clockTime(entry.timestamp))}</div>`;
    return `<div class="entry ${escapeHtml(entry.role)} ${entry.kind === "question" ? "question" : ""}">${meta}<div class="entry-copy">${escapeHtml(entry.text)}</div></div>`;
  }).join("");
}

function taskComposer(task) {
  const draft = taskDrafts.get(task.id) ?? "";
  const question = openQuestionFor(task);
  const busy = task.status === "working" || task.status === "starting";
  const placeholder = question ? "Answer this task and continue its thread…" : "Send a follow-up in this task thread…";
  return `<form class="task-composer" data-task-form data-task="${escapeHtml(task.id)}">
    <textarea data-task-draft="${escapeHtml(task.id)}" data-focus-key="task:${escapeHtml(task.id)}" aria-label="Message this task" placeholder="${escapeHtml(placeholder)}" ${busy ? "disabled" : ""}>${escapeHtml(draft)}</textarea>
    <div class="task-composer-footer">
      <span class="muted">Same Codex thread · Ctrl+Enter to send</span>
      <span class="spacer"></span>
      <button type="submit" ${busy ? "disabled" : ""}>Send</button>
    </div>
  </form>`;
}

function taskCard(task, { flow = false } = {}) {
  const open = task.id === openTaskId;
  const question = openQuestionFor(task);
  const left = 54 + (task.slot % CARD_COLUMNS) * CARD_WIDTH;
  const top = 58 + Math.floor(task.slot / CARD_COLUMNS) * CARD_HEIGHT;
  const style = flow || open ? "" : `style="left:${left}px;top:${top}px"`;
  const header = `<header class="node-header" data-open-task="${escapeHtml(task.id)}">
    <span class="dot ${escapeHtml(task.status)}"></span>
    <span class="node-title" title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</span>
    <span class="spacer"></span>
    <span class="provider" title="${escapeHtml(task.provider)}">${escapeHtml(task.provider)}</span>
    <button class="node-toggle" data-open-task="${escapeHtml(task.id)}" aria-label="${open ? "Collapse" : "Open"} task card">${open ? "▾" : "▸"}</button>
  </header>`;

  if (!open) {
    return `<article class="task-node ${question ? "needs-input" : ""}" data-task="${escapeHtml(task.id)}" ${style}>
      ${header}
      <div class="node-body">
        ${question ? '<div class="question-label">Waiting for your answer</div>' : ""}
        <p class="task-summary">${escapeHtml(question ? question.text : task.summary)}</p>
        ${question ? answerForm(question, "task card") : reportedActivity(task, 2)}
      </div>
      <footer class="node-footer">
        <span>${escapeHtml(statusLabel(task.status))}</span>
        <span class="spacer"></span>
        <span class="muted">${task.internalSteps} steps · ${task.transcript.length} messages</span>
      </footer>
    </article>`;
  }

  return `<article class="task-node open ${question ? "needs-input" : ""}" data-task="${escapeHtml(task.id)}">
    ${header}
    <div class="node-open-body">
      <div class="brief">
        <div class="brief-heading">Objective</div>
        <p>${escapeHtml(task.objective)}</p>
        <div class="brief-heading">Acceptance criteria</div>
        <ul>${task.acceptanceCriteria.map((criterion) => `<li>${escapeHtml(criterion)}</li>`).join("")}</ul>
      </div>
      ${internalSteps(task)}
      <div class="transcript" data-transcript>${transcript(task)}</div>
      ${taskComposer(task)}
      <footer class="identity">
        <span>${escapeHtml(statusLabel(task.status))}</span>
        <span class="spacer"></span>
        <code>${escapeHtml(task.id)}</code>
        <code>${escapeHtml(task.threadId ?? "thread pending")}</code>
        <a href="/api/tasks/${encodeURIComponent(task.id)}" target="_blank" rel="noopener">Inspect</a>
      </footer>
    </div>
  </article>`;
}

function canvas() {
  if (!state.tasks.length) {
    return `<section class="canvas"><div class="empty-canvas"><div class="empty-card"><h2>This Project canvas is empty</h2><p>Ask a question and the Coordinator answers here. Ask for work and it creates one task card with its own Codex thread.</p></div></div></section>`;
  }
  const cards = state.tasks.map((task) => taskCard(task)).join("");
  return `<section class="canvas"><div class="canvas-inner">${cards}<span class="canvas-hint">One task · one card · one Codex thread</span></div></section>`;
}

function flowBoard() {
  const lanes = [
    ["working", "Working", (task) => task.status === "starting" || task.status === "working"],
    ["waiting", "Needs input", (task) => task.status === "waiting"],
    ["completed", "Completed", (task) => task.status === "completed"],
    ["failed", "Stopped", (task) => task.status === "failed" || task.status === "unknown"]
  ];
  return `<section class="flow-board">${lanes.map(([status, label, matches]) => {
    const tasks = state.tasks.filter(matches);
    return `<section class="flow-lane">
      <header class="flow-lane-header"><span class="dot ${status}"></span><span>${label}</span><span class="spacer"></span><span class="count">${tasks.length}</span></header>
      <div class="flow-lane-body">${tasks.length ? tasks.map((task) => taskCard(task, { flow: true })).join("") : '<div class="flow-empty">No tasks here</div>'}</div>
    </section>`;
  }).join("")}</section>`;
}

function coordinatorMessage(message) {
  if (message.role === "owner") {
    return `<div class="chat-message user">${escapeHtml(message.text)}${message.source ? `<div class="chat-meta">via ${escapeHtml(message.source)}</div>` : ""}</div>`;
  }
  const openCard = message.taskId
    ? `<button class="link-button" data-open-task="${escapeHtml(message.taskId)}">Open the task card</button>`
    : "";
  const meta = [message.provider, message.kind === "answer" ? "direct answer" : null, message.kind === "dispatch" ? "task started" : null]
    .filter(Boolean)
    .map((label) => escapeHtml(label))
    .join(" · ");
  return `<div class="chat-message ${message.tone === "error" ? "error" : ""}">
    <span class="coordinator-mark">A</span>
    <div class="chat-copy">${escapeHtml(message.text)}
      ${openCard}
      ${meta ? `<div class="chat-meta">${meta}</div>` : ""}
    </div>
  </div>`;
}

function conversation() {
  const opening = state.messages.length
    ? ""
    : `<div class="chat-message"><span class="coordinator-mark">A</span><div class="chat-copy">I answer questions here. When you ask for work, I create one task card with its own Codex thread and report its result back in this conversation.</div></div>`;
  const messages = state.messages.map(coordinatorMessage).join("");
  const questions = state.questions.filter((question) => question.status === "open").map((question) => {
    const task = state.tasks.find((candidate) => candidate.id === question.taskId);
    return `<div class="chat-message"><span class="coordinator-mark">A</span><div class="chat-copy">A task needs your decision.
      <div class="attention-card">
        <div class="row"><span class="attention-chip">Needs input</span><button class="link-button" data-open-task="${escapeHtml(question.taskId)}">${escapeHtml(task?.title ?? question.taskId)}</button></div>
        <p class="question-copy">${escapeHtml(question.text)}</p>
        ${answerForm(question, "coordinator")}
      </div>
    </div></div>`;
  }).join("");
  return opening + messages + questions;
}

function timeline() {
  if (!showTimeline) return "";
  const events = [...state.events].reverse();
  return `<aside class="timeline">
    <header class="timeline-header"><h2>Inspectable activity record</h2><span class="spacer"></span><button class="timeline-close" data-toggle-timeline>Close</button></header>
    <ol class="event-list">${events.map((event) => `<li class="event">
      <span class="dot ${escapeHtml(event.status)}"></span>
      <div class="event-copy">
        <div class="event-type">${escapeHtml(event.type)} · ${escapeHtml(event.actor)}${event.kind ? ` · ${escapeHtml(event.kind)}` : ""}</div>
        <div class="event-summary">${escapeHtml(event.summary)}</div>
        <div class="event-time">${escapeHtml(new Date(event.timestamp).toLocaleString())}${event.taskId ? ` · ${escapeHtml(event.taskId)}` : ""}${event.threadId ? ` · ${escapeHtml(event.threadId)}` : ""}</div>
      </div>
    </li>`).join("")}</ol>
  </aside>`;
}

function captureFocus() {
  const element = document.activeElement;
  if (!element?.dataset?.focusKey) return null;
  return { key: element.dataset.focusKey, start: element.selectionStart, end: element.selectionEnd };
}

function restoreFocus(focus) {
  if (!focus) return;
  const element = app.querySelector(`[data-focus-key="${focus.key}"]`);
  if (!element || element.disabled) return;
  element.focus();
  if (focus.start !== null && focus.start !== undefined) element.setSelectionRange(focus.start, focus.end);
}

function render() {
  if (!state) {
    app.innerHTML = '<div class="empty-canvas"><div class="empty-card"><h2>Starting ADE…</h2></div></div>';
    return;
  }
  const focus = captureFocus();
  const openQuestions = state.questions.filter((question) => question.status === "open").length;
  const coordinatorBusy = state.coordinatorStatus === "working";
  const runningTasks = state.tasks.filter((task) => task.status === "working" || task.status === "starting").length;

  app.innerHTML = `<div class="shell">
    <aside class="rail">
      <div class="brand"><span class="brand-mark">A</span>ADE</div>
      <button class="primary" data-focus-composer ${coordinatorBusy ? "disabled" : ""}>＋ New request</button>
      <div class="rail-heading">Project</div>
      <button class="project-row"><span class="project-glyph">${escapeHtml(state.project.name.slice(0, 2).toUpperCase())}</span><span>${escapeHtml(state.project.name)}</span><span class="spacer"></span>${openQuestions ? '<span class="dot waiting"></span>' : ""}<span class="count">${state.tasks.length}</span></button>
      <div class="project-path">${escapeHtml(state.project.path)}</div>
      <div class="rail-heading">Task canvas</div>
      <div class="rail-copy">Each card is one work task with its own persistent Codex thread. Internal Codex subagents stay inside their card.</div>
      <div class="rail-footer row"><span class="dot ${runningTasks ? "working" : ""}"></span><span>${runningTasks} running</span><span class="spacer"></span><button class="event-button" data-toggle-timeline>Activity ${state.events.length}</button></div>
    </aside>
    <main class="workspace">
      <header class="toolbar">
        <span class="workspace-title">${escapeHtml(state.project.name)}</span>
        <span class="workspace-subtitle">${viewMode === "canvas" ? "Task canvas" : "Automatic status view"}</span>
        <span class="spacer"></span>
        <div class="view-switch"><button data-view="canvas" class="${viewMode === "canvas" ? "active" : ""}">Canvas</button><button data-view="flow" class="${viewMode === "flow" ? "active" : ""}">Flow</button></div>
        <span class="muted" style="font-size:11px">${state.tasks.length} task${state.tasks.length === 1 ? "" : "s"}</span>
      </header>
      ${viewMode === "canvas" ? canvas() : flowBoard()}
    </main>
    <aside class="coordinator">
      <header class="coordinator-header"><span class="dot ${coordinatorBusy ? "working" : ""}"></span><strong>Coordinator</strong><span class="spacer"></span>${openQuestions ? `<span class="attention-chip"><span class="dot waiting"></span>${openQuestions} question${openQuestions === 1 ? "" : "s"}</span>` : '<span class="muted" style="font-size:10px">Primary conversation</span>'}</header>
      <div class="thread">${conversation()}</div>
      ${errorMessage ? `<div class="error-banner">${escapeHtml(errorMessage)}</div>` : ""}
      <div class="compose-wrap"><form class="composer" data-request-form>
        <textarea data-request-draft data-focus-key="request" aria-label="Message the Coordinator" placeholder="Ask a question, or ask for work in ${escapeHtml(state.project.name)}…" ${coordinatorBusy ? "disabled" : ""}>${escapeHtml(requestDraft)}</textarea>
        <div class="composer-footer"><span class="project-chip"><span class="dot working"></span>${escapeHtml(state.project.name)}</span><span class="muted" style="font-size:10px">multiline · Ctrl+Enter to send</span><span class="spacer"></span><button class="send" type="submit" aria-label="Send request" ${coordinatorBusy || requestPending ? "disabled" : ""}>↑</button></div>
      </form></div>
    </aside>
    ${timeline()}
  </div>`;

  restoreFocus(focus);
  requestAnimationFrame(() => {
    const thread = document.querySelector(".thread");
    if (thread) thread.scrollTop = thread.scrollHeight;
    const openTranscript = document.querySelector("[data-transcript]");
    if (openTranscript) openTranscript.scrollTop = openTranscript.scrollHeight;
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
  if (event.target.matches("[data-task-draft]")) taskDrafts.set(event.target.dataset.taskDraft, event.target.value);
});

app.addEventListener("keydown", (event) => {
  if (!(event.key === "Enter" && (event.ctrlKey || event.metaKey))) return;
  if (event.target.matches("[data-request-draft]")) {
    event.preventDefault();
    void submitRequest();
  }
  if (event.target.matches("[data-task-draft]") || event.target.matches("[data-answer-draft]")) {
    event.preventDefault();
    event.target.closest("form")?.requestSubmit();
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
    const source = event.target.dataset.source;
    const key = `${source}:${questionId}`;
    const answer = answerDrafts.get(key)?.trim();
    if (!answer) return;
    errorMessage = "";
    try {
      await postJson(`/api/questions/${encodeURIComponent(questionId)}/answer`, { answer, source });
      answerDrafts.delete(key);
    } catch (error) {
      errorMessage = error.message;
      render();
    }
    return;
  }
  if (event.target.matches("[data-task-form]")) {
    const taskId = event.target.dataset.task;
    const message = taskDrafts.get(taskId)?.trim();
    if (!message) return;
    errorMessage = "";
    try {
      await postJson(`/api/tasks/${encodeURIComponent(taskId)}/messages`, { message, source: "task card" });
      taskDrafts.delete(taskId);
    } catch (error) {
      errorMessage = error.message;
    }
    render();
  }
});

app.addEventListener("click", (event) => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) {
    viewMode = viewButton.dataset.view;
    localStorage.setItem("ade-view", viewMode);
    render();
    return;
  }
  const openButton = event.target.closest("[data-open-task]");
  if (openButton) {
    const taskId = openButton.dataset.openTask;
    openTaskId = openTaskId === taskId ? null : taskId;
    render();
    return;
  }
  if (event.target.closest("[data-toggle-timeline]")) {
    showTimeline = !showTimeline;
    render();
    return;
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
    if (errorMessage.startsWith("Live updates disconnected")) {
      errorMessage = "";
      render();
    }
  };
}

connect().catch((error) => {
  app.innerHTML = `<div class="empty-canvas"><div class="empty-card"><h2>ADE could not start</h2><p>${escapeHtml(error.message)}</p></div></div>`;
});
