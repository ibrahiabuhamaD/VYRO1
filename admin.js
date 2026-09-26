const loginPanel = document.querySelector("#loginPanel");
const dashboard = document.querySelector("#dashboard");
const loginForm = document.querySelector("#loginForm");
const loginError = document.querySelector("#loginError");
const adminToast = document.querySelector("#adminToast");
const memberRows = document.querySelector("#memberRows");
const reportRows = document.querySelector("#reportRows");
const liveRows = document.querySelector("#liveRows");

let csrfToken = null;
let overview = null;
let toastTimer = null;

function showToast(message) {
  adminToast.textContent = message;
  adminToast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => adminToast.classList.remove("is-visible"), 3200);
}

async function request(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set("Content-Type", "application/json");
  if (csrfToken && options.method && options.method !== "GET") headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "تعذر إكمال الطلب.");
  return payload;
}

function setSignedIn(data) {
  csrfToken = data.csrfToken || csrfToken;
  loginPanel.hidden = true;
  dashboard.hidden = false;
  document.querySelector("#logoutButton").hidden = false;
  document.querySelector("#adminEmailLabel").textContent = data.adminEmail || "مشرف وَصْل";
}

function formatDate(value) {
  if (!value) return "لم يسجل بعد";
  return new Intl.DateTimeFormat("ar", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function makeButton(label, action, className = "table-action") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.dataset.action = action;
  return button;
}

function renderMembers() {
  const query = document.querySelector("#memberSearch").value.trim().toLowerCase();
  const users = (overview?.users || []).filter((user) => `${user.name} ${user.email}`.toLowerCase().includes(query));
  memberRows.replaceChildren();
  document.querySelector("#membersEmpty").hidden = users.length > 0;
  for (const user of users) {
    const row = document.createElement("tr");
    const identity = document.createElement("td");
    identity.className = "member-identity-cell";
    const name = document.createElement("strong");
    name.textContent = user.name || "عضو";
    const email = document.createElement("small");
    email.textContent = user.email;
    identity.append(name, email);
    const provider = document.createElement("td");
    provider.textContent = ({ google: "Google", facebook: "Facebook", password: "البريد وكلمة المرور" })[user.provider] || "غير معروف";
    const status = document.createElement("td");
    const statusPill = document.createElement("span");
    statusPill.className = `status-pill status-${user.status}`;
    statusPill.textContent = ({ active: "مفعّل", inactive: "موقوف", banned: "محظور" })[user.status] || user.status;
    if (user.online) statusPill.textContent += " · متصل";
    status.append(statusPill);
    const lastSeen = document.createElement("td");
    lastSeen.textContent = formatDate(user.lastSeenAt);
    const actions = document.createElement("td");
    actions.className = "table-actions";
    if (user.status !== "active") actions.append(makeButton("تفعيل", "activate", "table-action action-good"));
    else actions.append(makeButton("إيقاف", "deactivate"));
    if (user.status !== "banned") actions.append(makeButton("حظر", "ban", "table-action action-danger"));
    actions.append(makeButton("حذف", "delete", "table-action action-danger"));
    actions.dataset.userId = user.id;
    row.append(identity, provider, status, lastSeen, actions);
    memberRows.append(row);
  }
}

function renderReports() {
  const filter = document.querySelector("#reportFilter").value;
  const reports = (overview?.reports || []).filter((report) => filter === "all" || (filter === "resolved" ? report.status !== "open" : report.status === "open"));
  reportRows.replaceChildren();
  document.querySelector("#reportsEmpty").hidden = reports.length > 0;
  for (const report of reports) {
    const row = document.createElement("tr");
    for (const value of [report.reporterEmail, report.reportedEmail, report.reason, formatDate(report.createdAt)]) {
      const cell = document.createElement("td");
      cell.textContent = value || "غير محدد";
      row.append(cell);
    }
    const actions = document.createElement("td");
    actions.className = "table-actions";
    if (report.status === "open") {
      actions.append(makeButton("تمت المراجعة", "resolve", "table-action action-good"));
      actions.append(makeButton("تجاهل", "dismiss"));
      if (report.reportedId) actions.append(makeButton("حظر العضو", "ban", "table-action action-danger"));
    } else {
      const state = document.createElement("span");
      state.className = "status-pill status-inactive";
      state.textContent = report.status === "dismissed" ? "تم التجاهل" : "تمت المراجعة";
      actions.append(state);
    }
    actions.dataset.reportId = report.id;
    row.append(actions);
    reportRows.append(row);
  }
}

function renderLiveSessions(data) {
  document.querySelector("#liveOnlineCount").textContent = data.online;
  document.querySelector("#liveMatchCount").textContent = data.liveSessions.filter((item) => item.phase === "chatting").length / 2;
  liveRows.replaceChildren();
  document.querySelector("#liveEmpty").hidden = data.liveSessions.length > 0;
  for (const session of data.liveSessions) {
    const row = document.createElement("tr");
    const identity = document.createElement("td");
    identity.className = "member-identity-cell";
    const name = document.createElement("strong");
    name.textContent = session.name;
    const email = document.createElement("small");
    email.textContent = session.email || "زائر بدون حساب";
    identity.append(name, email);
    const type = document.createElement("td");
    type.textContent = session.email ? "عضو" : "زائر";
    const status = document.createElement("td");
    const pill = document.createElement("span");
    const inCall = session.phase === "chatting";
    pill.className = `status-pill ${inCall ? "status-active" : "status-inactive"}`;
    pill.textContent = inCall ? "في لقاء" : session.waiting ? "ينتظر مطابقة" : "متصل بالموقع";
    status.append(pill);
    const partner = document.createElement("td");
    partner.textContent = session.partnerName || "لا يوجد";
    const connected = document.createElement("td");
    connected.textContent = formatDate(session.matchStartedAt || session.connectedAt);
    const action = document.createElement("td");
    action.className = "table-actions";
    const disconnect = makeButton("إنهاء الجلسة", "disconnect", "table-action action-danger");
    disconnect.disabled = !session.open;
    action.dataset.sessionId = session.id;
    action.append(disconnect);
    row.append(identity, type, status, partner, connected, action);
    liveRows.append(row);
  }
}

async function loadLiveSessions() {
  const data = await request("/api/admin/live-sessions");
  renderLiveSessions(data);
  document.querySelector("#onlineStat").textContent = data.online;
}

function renderOverview() {
  const stats = overview.stats;
  document.querySelector("#onlineStat").textContent = stats.online;
  document.querySelector("#membersStat").textContent = stats.members;
  document.querySelector("#activeStat").textContent = stats.activeMembers;
  document.querySelector("#reportsStat").textContent = stats.openReports;
  const recent = document.querySelector("#recentReports");
  recent.replaceChildren();
  for (const report of overview.reports.filter((item) => item.status === "open").slice(0, 5)) {
    const item = document.createElement("div");
    item.className = "recent-item";
    const main = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = report.reportedEmail;
    const details = document.createElement("small");
    details.textContent = `${report.reason} · ${formatDate(report.createdAt)}`;
    main.append(title, details);
    const marker = document.createElement("i");
    item.append(main, marker);
    recent.append(item);
  }
  if (!recent.childElementCount) {
    const empty = document.createElement("p");
    empty.className = "empty-state compact-empty";
    empty.textContent = "لا توجد بلاغات مفتوحة.";
    recent.append(empty);
  }
  const status = document.querySelector("#platformStatus");
  status.replaceChildren();
  const states = [
    ["المطابقة", overview.settings.matchingEnabled ? "مفعّلة" : "متوقفة", overview.settings.matchingEnabled],
    ["وضع الصيانة", overview.settings.maintenance ? "مفعّل" : "غير مفعّل", !overview.settings.maintenance],
    ["التسجيل", overview.settings.registrationsEnabled ? "متاح" : "متوقف", overview.settings.registrationsEnabled],
    ["Google OAuth", overview.providers.google ? "مهيأ" : "مفاتيح مطلوبة", overview.providers.google],
    ["Facebook OAuth", overview.providers.facebook ? "مهيأ" : "مفاتيح مطلوبة", overview.providers.facebook]
  ];
  for (const [label, value, healthy] of states) {
    const item = document.createElement("div");
    item.className = "platform-row";
    const name = document.createElement("span");
    name.textContent = label;
    const state = document.createElement("strong");
    state.className = healthy ? "state-positive" : "state-negative";
    state.textContent = value;
    item.append(name, state);
    status.append(item);
  }
  renderMembers();
  renderReports();
  const settings = overview.settings;
  document.querySelector("#siteName").value = settings.siteName;
  document.querySelector("#tagline").value = settings.tagline;
  document.querySelector("#announcement").value = settings.announcement;
  for (const key of ["matchingEnabled", "maintenance", "registrationsEnabled", "allowGuestAccess"]) {
    document.querySelector(`#${key}`).checked = settings[key];
  }
  document.querySelector("#newAdminEmail").value = overview.adminEmail;
}

async function loadOverview() {
  const data = await request("/api/admin/overview");
  overview = data;
  setSignedIn(data);
  renderOverview();
}

function setView(name) {
  for (const view of document.querySelectorAll(".admin-view")) view.hidden = view.id !== `view-${name}`;
  for (const button of document.querySelectorAll("[data-view]")) button.classList.toggle("is-current", button.dataset.view === name);
  const labels = { overview: "نظرة عامة", live: "المتصلون الآن", members: "الأعضاء", reports: "البلاغات", settings: "إعدادات الموقع" };
  document.querySelector("#pageTitle").textContent = labels[name] || labels.overview;
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.hidden = true;
  const submit = loginForm.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const result = await request("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ email: document.querySelector("#adminEmail").value, password: document.querySelector("#adminPassword").value })
    });
    csrfToken = result.csrfToken;
    await loadOverview();
    loginForm.reset();
  } catch (error) {
    loginError.textContent = error.message;
    loginError.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

document.querySelector("#logoutButton").addEventListener("click", async () => {
  try { await request("/api/admin/logout", { method: "POST" }); } catch {}
  csrfToken = null;
  overview = null;
  dashboard.hidden = true;
  loginPanel.hidden = false;
  document.querySelector("#logoutButton").hidden = true;
  document.querySelector("#adminEmailLabel").textContent = "غير مسجل";
  showToast("تم تسجيل الخروج.");
});

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
document.querySelector("#refreshButton").addEventListener("click", () => loadOverview().then(() => showToast("تم تحديث البيانات.")).catch((error) => showToast(error.message)));
document.querySelector("#memberSearch").addEventListener("input", renderMembers);
document.querySelector("#reportFilter").addEventListener("change", renderReports);

memberRows.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const container = button.closest("[data-user-id]");
  const action = button.dataset.action;
  if (action === "delete" && !window.confirm("سيُحذف الحساب نهائيًا. هل تريد المتابعة؟")) return;
  if (action === "ban" && !window.confirm("سيُحظر العضو ويُنهى اتصاله الحالي. هل تريد المتابعة؟")) return;
  try {
    await request("/api/admin/users/action", { method: "POST", body: JSON.stringify({ userId: container.dataset.userId, action }) });
    await loadOverview();
    showToast("تم تحديث حالة العضو.");
  } catch (error) { showToast(error.message); }
});

liveRows.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action='disconnect']");
  if (!button) return;
  if (!window.confirm("سينتهي اتصال هذا الشخص وسيُفصل طرفه الحالي. هل تريد المتابعة؟")) return;
  const container = button.closest("[data-session-id]");
  try {
    await request("/api/admin/sessions/disconnect", { method: "POST", body: JSON.stringify({ sessionId: container.dataset.sessionId }) });
    await loadLiveSessions();
    showToast("تم إنهاء الجلسة.");
  } catch (error) { showToast(error.message); }
});

reportRows.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const container = button.closest("[data-report-id]");
  const action = button.dataset.action;
  if (action === "ban" && !window.confirm("سيُحظر الحساب المُبلّغ عنه ويُنهى اتصاله. هل تريد المتابعة؟")) return;
  try {
    await request("/api/admin/reports/action", { method: "POST", body: JSON.stringify({ reportId: container.dataset.reportId, action }) });
    await loadOverview();
    showToast("تم حفظ مراجعة البلاغ.");
  } catch (error) { showToast(error.message); }
});

document.querySelector("#settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  for (const key of ["matchingEnabled", "maintenance", "registrationsEnabled", "allowGuestAccess"]) values[key] = form.elements[key].checked;
  const message = document.querySelector("#settingsMessage");
  try {
    await request("/api/admin/settings", { method: "POST", body: JSON.stringify(values) });
    await loadOverview();
    message.textContent = "تم حفظ الإعدادات وتطبيقها.";
    showToast("تم حفظ إعدادات الموقع.");
  } catch (error) { message.textContent = error.message; }
});

document.querySelector("#credentialsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = document.querySelector("#credentialsMessage");
  try {
    const result = await request("/api/admin/credentials", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: document.querySelector("#currentPassword").value,
        email: document.querySelector("#newAdminEmail").value,
        newPassword: document.querySelector("#newAdminPassword").value
      })
    });
    csrfToken = result.csrfToken;
    document.querySelector("#currentPassword").value = "";
    document.querySelector("#newAdminPassword").value = "";
    await loadOverview();
    message.textContent = "تم تحديث بيانات المشرف.";
  } catch (error) { message.textContent = error.message; }
});

document.querySelector("#memberSearch").value = "";
request("/api/admin/overview").then((data) => {
  csrfToken = data.csrfToken || null;
  overview = data;
  setSignedIn(data);
  renderOverview();
  void loadLiveSessions();
}).catch(() => {
  loginPanel.hidden = false;
  dashboard.hidden = true;
});

window.setInterval(() => {
  if (!dashboard.hidden) void loadLiveSessions().catch((error) => {
    if (error.message.includes("تسجيل دخول")) {
      dashboard.hidden = true;
      loginPanel.hidden = false;
    }
  });
}, 5000);