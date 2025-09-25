import { marked } from "marked";
import DOMPurify from "dompurify";

/* Elements */
const form = document.getElementById("project-form");
const input = document.getElementById("project-input");
const loadBtn = document.getElementById("load-btn");
const supportersEl = document.getElementById("supporters");
const emptyEl = document.getElementById("empty");
const tmpl = document.getElementById("supporter-item");
const controls = document.getElementById("controls");
const prevBtn = document.getElementById("prev-btn");
const nextBtn = document.getElementById("next-btn");
const bestToggle = document.getElementById("best-toggle");
const pageIndicator = document.getElementById("page-indicator");
const metaTitle = document.getElementById("project-title");
const metaId = document.getElementById("project-id");
const totalCredits = document.getElementById("total-credits");

/* State */
let currentProject = null;
let currentPage = { start: null, end: null, index: 1 };
let historyStack = []; // stack of {start,end,index}
let sortByBest = false;

marked.setOptions({ breaks: true });

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = input.value.trim();
  if (!raw) return;
  disableUI(true);
  resetUI();
  try {
    const { id, title } = await resolveProject(raw);
    currentProject = { id, title };
    metaTitle.textContent = title ? `“${title}”` : "";
    metaId.textContent = `ID: ${id}`;
    await loadPage({ after: null, before: null });
    controls.hidden = false;
    attachRealtimeListener(id);
  } catch (err) {
    showError(err?.message || "Failed to load project");
  } finally {
    disableUI(false);
  }
});

bestToggle.addEventListener("change", async () => {
  sortByBest = bestToggle.checked;
  // Reset pagination when sort changes
  historyStack = [];
  currentPage = { start: null, end: null, index: 1 };
  await loadPage({ after: null, before: null });
});

prevBtn.addEventListener("click", async () => {
  if (!currentProject) return;
  if (historyStack.length <= 1) return;
  historyStack.pop(); // remove current
  const prev = historyStack[historyStack.length - 1];
  await loadPage({ before: prev.start }, true);
});

nextBtn.addEventListener("click", async () => {
  if (!currentProject || !currentPage.end) return;
  await loadPage({ after: currentPage.end });
});

/* Core */
async function resolveProject(inputStr) {
  const parsed = parseInput(inputStr);
  if (parsed.type === "id") {
    const project = await window.websim.getCurrentProject().catch(() => null);
    // We may not be in the same project; we only need id to fetch comments.
    return { id: parsed.value, title: "" };
  } else {
    // slug resolution
    const { username, slug } = parsed;
    const res = await fetch(`/api/v1/users/${encodeURIComponent(username)}/slugs/${encodeURIComponent(slug)}`);
    if (!res.ok) throw new Error("Slug resolution failed");
    const data = await res.json();
    const id = data?.project?.id || data?.id || data?.project_id;
    const title = data?.project?.title || data?.title || "";
    if (!id) throw new Error("Could not resolve project ID");
    return { id, title };
  }
}

function parseInput(str) {
  try {
    const url = new URL(str);
    const parts = url.pathname.split("/").filter(Boolean);
    // common patterns: /c/{username}/{slug} or /{username}/{slug}
    if (parts.length >= 3 && parts[0] === "c") {
      return { type: "slug", username: parts[1], slug: parts[2] };
    }
    if (parts.length >= 2) {
      return { type: "slug", username: parts[0], slug: parts[1] };
    }
  } catch {
    // not a URL
  }
  // Heuristics: username/slug string
  if (/^[^\/\s]+\/[^\/\s]+$/.test(str)) {
    const [username, slug] = str.split("/");
    return { type: "slug", username, slug };
  }
  // Treat as project id
  return { type: "id", value: str };
}

async function loadPage({ after = null, before = null } = {}, isPrev = false) {
  const id = currentProject.id;
  const params = new URLSearchParams();
  params.set("only_tips", "true");
  if (sortByBest) params.set("sort_by", "best");
  if (after) params.set("after", after);
  if (before) params.set("before", before);

  const res = await fetch(`/api/v1/projects/${encodeURIComponent(id)}/comments?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch comments");
  const data = await res.json();
  const list = (data?.comments?.data || []).map(w => w.comment);
  const meta = data?.comments?.meta || {};

  renderSupporters(list);
  updateTotals(list);

  currentPage = {
    start: meta.start_cursor || null,
    end: meta.end_cursor || null,
    index: isPrev ? Math.max(1, (historyStack[historyStack.length - 1]?.index || 2) - 1)
                  : (historyStack[historyStack.length - 1]?.index || 0) + 1
  };

  if (!isPrev) {
    historyStack.push({ start: currentPage.start, end: currentPage.end, index: currentPage.index });
  }

  prevBtn.disabled = historyStack.length <= 1;
  nextBtn.disabled = !meta.has_next_page;
  pageIndicator.textContent = `Page ${currentPage.index}`;
}

function renderSupporters(items) {
  supportersEl.innerHTML = "";
  if (!items.length) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  const frag = document.createDocumentFragment();
  for (const c of items) {
    const li = tmpl.content.firstElementChild.cloneNode(true);
    const avatar = li.querySelector(".avatar");
    const name = li.querySelector(".name");
    const username = li.querySelector(".username");
    const credits = li.querySelector(".credits");
    const time = li.querySelector(".time");
    const comment = li.querySelector(".comment");

    const author = c.author || {};
    avatar.src = author.avatar_url || "https://cdn.jsdelivr.net/gh/websimassets/placeholder/blank-avatar.png";
    avatar.alt = author.username ? `${author.username}'s avatar` : "avatar";
    name.textContent = author.display_name || author.username || "Anonymous";
    username.textContent = author.username ? `@${author.username}` : "";
    const amt = c.card_data?.credits_spent ?? 0;
    credits.textContent = `${amt} credits`;
    time.dateTime = c.created_at || "";
    time.textContent = formatDate(c.created_at);

    const commentHtml = DOMPurify.sanitize(marked.parse(c.raw_content || ""), {
      USE_PROFILES: { html: true }
    });
    comment.innerHTML = commentHtml;

    frag.appendChild(li);
  }
  supportersEl.appendChild(frag);
}

function updateTotals(items) {
  const sum = items.reduce((acc, c) => acc + (c.card_data?.credits_spent ?? 0), 0);
  totalCredits.textContent = `This page: ${sum} credits`;
}

/* Utils */
function formatDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch { return ""; }
}

function showError(msg) {
  supportersEl.innerHTML = "";
  emptyEl.hidden = false;
  emptyEl.textContent = msg;
}

function resetUI() {
  supportersEl.innerHTML = "";
  emptyEl.hidden = true;
  emptyEl.textContent = "No tips yet.";
  controls.hidden = true;
  prevBtn.disabled = true;
  nextBtn.disabled = true;
  pageIndicator.textContent = "";
  totalCredits.textContent = "";
  metaTitle.textContent = "";
  metaId.textContent = "";
  historyStack = [];
  currentPage = { start: null, end: null, index: 1 };
}

function disableUI(disabled) {
  loadBtn.disabled = disabled;
  input.disabled = disabled;
  prevBtn.disabled = disabled || prevBtn.disabled;
  nextBtn.disabled = disabled || nextBtn.disabled;
}

/* Real-time updates: append tips for the same project */
function attachRealtimeListener(projectId) {
  window.websim.removeEventListener && window.websim.removeEventListener('comment:created', onCommentCreated);
  window.websim.addEventListener('comment:created', onCommentCreated);

  function onCommentCreated(data) {
    if (data?.comment?.project_id !== projectId) return;
    const card = data.comment.card_data;
    if (!card || card.type !== "tip_comment") return;
    // Prepend and update totals for current page view
    const existing = Array.from(supportersEl.children).map(li => li);
    renderSupporters([data.comment, ...extractRenderedComments(existing)]);
    updateTotals([data.comment, ...extractRenderedComments(existing, true)]);
  }

  function extractRenderedComments(items, asComments = false) {
    // Best-effort extraction from DOM; limited to visible page
    return items.map(li => {
      if (!asComments) return { /* placeholder for re-render pipeline */ };
      const creditsText = li.querySelector(".credits")?.textContent || "0";
      const num = parseInt(creditsText.replace(/\D+/g, ""), 10) || 0;
      return { card_data: { credits_spent: num } };
    });
  }
}

