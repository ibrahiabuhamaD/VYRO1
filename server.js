const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual
} = require("node:crypto");
const { WebSocket, WebSocketServer } = require("ws");
const { defaultSettings, getStore, initialize, persist } = require("./store");

const publicRoot = path.resolve(__dirname);
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png"
};
const allowedTopLevel = new Set(["index.html", "styles.css", "app.js", "admin.html", "admin.css", "admin.js", "assets"]);
const countries = new Set(["sa", "eg", "ma", "ae", "jo", "other"]);
const genders = new Set(["women", "men", "other"]);
const lookingForValues = new Set(["everyone", "women", "men"]);
const clients = new Map();
const waitingQueue = [];
const sessions = new Map();
const oauthStates = new Map();
const loginFailures = new Map();
const sessionLifetime = 12 * 60 * 60 * 1000;

function secureHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(self), microphone=(self), fullscreen=(self)");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss:; media-src 'self' blob:; base-uri 'self'; frame-ancestors 'none'");
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function readJson(request, maximumBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maximumBytes) {
        reject(Object.assign(new Error("Request too large"), { statusCode: 413 }));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function cookieValue(request, name) {
  const cookies = request.headers.cookie?.split(";") || [];
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator !== -1 && cookie.slice(0, separator).trim() === name) {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    }
  }
  return "";
}

function getSession(request) {
  const token = cookieValue(request, "wasl_session");
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { ...session, token };
}

function appendCookie(response, cookie) {
  const current = response.getHeader("Set-Cookie");
  response.setHeader("Set-Cookie", current ? [...(Array.isArray(current) ? current : [current]), cookie] : cookie);
}

function setSessionCookie(request, response, token) {
  const secure = request.socket.encrypted || request.headers["x-forwarded-proto"] === "https";
  appendCookie(response, `wasl_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetime / 1000}${secure ? "; Secure" : ""}`);
}

function clearSessionCookie(request, response) {
  const secure = request.socket.encrypted || request.headers["x-forwarded-proto"] === "https";
  appendCookie(response, `wasl_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`);
}

function setOAuthStateCookie(request, response, provider, state) {
  const secure = request.socket.encrypted || request.headers["x-forwarded-proto"] === "https";
  appendCookie(response, `wasl_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/auth/${provider}/callback; Max-Age=300${secure ? "; Secure" : ""}`);
}

function clearOAuthStateCookie(request, response, provider) {
  const secure = request.socket.encrypted || request.headers["x-forwarded-proto"] === "https";
  appendCookie(response, `wasl_oauth_state=; HttpOnly; SameSite=Lax; Path=/auth/${provider}/callback; Max-Age=0${secure ? "; Secure" : ""}`);
}

function createSession(request, response, role, id) {
  const token = randomBytes(32).toString("base64url");
  const session = { role, id, csrfToken: randomBytes(24).toString("base64url"), expiresAt: Date.now() + sessionLifetime };
  sessions.set(token, session);
  setSessionCookie(request, response, token);
  return session;
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function validCsrf(request, session) {
  return Boolean(session && request.headers["x-csrf-token"] === session.csrfToken);
}

function validAdminPassword(candidate, credentials) {
  if (!credentials || typeof candidate !== "string" || candidate.length > 256) return false;
  const expected = Buffer.from(credentials.hash, "hex");
  const actual = scryptSync(candidate, Buffer.from(credentials.salt, "hex"), 32);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function hashPassword(password, salt = randomBytes(16)) {
  return {
    salt: salt.toString("hex"),
    hash: scryptSync(password, salt, 32).toString("hex")
  };
}

function validEmail(email) {
  return typeof email === "string" && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function takeLoginAttempt(request) {
  const ip = request.socket.remoteAddress || "unknown";
  const failures = loginFailures.get(ip) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
  if (failures.resetAt <= Date.now()) {
    failures.count = 0;
    failures.resetAt = Date.now() + 15 * 60 * 1000;
  }
  if (failures.count >= 8) return { blocked: true, ip, failures };
  return { blocked: false, ip, failures };
}

function rejectLoginAttempt(attempt) {
  attempt.failures.count += 1;
  loginFailures.set(attempt.ip, attempt.failures);
}

function completeLoginAttempt(attempt) {
  loginFailures.delete(attempt.ip);
}

function publicSettings() {
  const { siteName, tagline, announcement, maintenance, matchingEnabled } = getStore().settings;
  return { siteName, tagline, announcement, maintenance, matchingEnabled };
}

function getPublicBaseUrl(request) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const host = request.headers.host || "";
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) throw new Error("PUBLIC_BASE_URL must be configured");
  return `http://${host}`;
}

function oauthConfigured(provider) {
  if (provider === "google") return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  return Boolean(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET);
}

function oauthRedirectUri(request, provider) {
  return `${getPublicBaseUrl(request)}/auth/${provider}/callback`;
}

function beginOAuth(request, response, provider) {
  const store = getStore();
  if (!store.settings.registrationsEnabled) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("التسجيل متوقف حاليًا.");
    return;
  }
  if (!oauthConfigured(provider)) {
    response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" }).end("لم يتم إعداد تسجيل الدخول لهذا المزود. أضف مفاتيح OAuth إلى 1.env ثم أعد تشغيل الخادم.");
    return;
  }

  let redirectUri;
  try {
    redirectUri = oauthRedirectUri(request, provider);
  } catch {
    response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" }).end("يجب إعداد PUBLIC_BASE_URL قبل تسجيل الدخول الاجتماعي.");
    return;
  }
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  oauthStates.set(state, { provider, verifier, redirectUri, expiresAt: Date.now() + 5 * 60 * 1000 });
  setOAuthStateCookie(request, response, provider, state);
  const authorizationUrl = provider === "google"
    ? new URL("https://accounts.google.com/o/oauth2/v2/auth")
    : new URL("https://www.facebook.com/v20.0/dialog/oauth");
  authorizationUrl.searchParams.set("client_id", provider === "google" ? process.env.GOOGLE_CLIENT_ID : process.env.FACEBOOK_APP_ID);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("state", state);
  if (provider === "google") {
    authorizationUrl.searchParams.set("scope", "openid email profile");
    authorizationUrl.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
  } else {
    authorizationUrl.searchParams.set("scope", "email,public_profile");
  }
  response.writeHead(302, { Location: authorizationUrl.toString(), "Cache-Control": "no-store" }).end();
}

async function finishOAuth(request, response, provider, url) {
  const stateKey = url.searchParams.get("state");
  const state = oauthStates.get(stateKey);
  oauthStates.delete(stateKey);
  const stateCookieMatches = Boolean(stateKey && cookieValue(request, "wasl_oauth_state") === stateKey);
  clearOAuthStateCookie(request, response, provider);
  if (!state || !stateCookieMatches || state.provider !== provider || state.expiresAt < Date.now() || !url.searchParams.get("code")) {
    response.writeHead(302, { Location: "/?auth=error" }).end();
    return;
  }
  try {
    const tokenUrl = provider === "google"
      ? "https://oauth2.googleapis.com/token"
      : "https://graph.facebook.com/v20.0/oauth/access_token";
    const tokenBody = new URLSearchParams({
      client_id: provider === "google" ? process.env.GOOGLE_CLIENT_ID : process.env.FACEBOOK_APP_ID,
      client_secret: provider === "google" ? process.env.GOOGLE_CLIENT_SECRET : process.env.FACEBOOK_APP_SECRET,
      code: url.searchParams.get("code"),
      redirect_uri: state.redirectUri,
      ...(provider === "google" ? { grant_type: "authorization_code", code_verifier: state.verifier } : {})
    });
    const tokenResponse = await fetch(tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: tokenBody });
    if (!tokenResponse.ok) throw new Error("OAuth token exchange failed");
    const tokenData = await tokenResponse.json();
    let profile;
    if (provider === "google") {
      const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
      if (!profileResponse.ok) throw new Error("Google profile lookup failed");
      profile = await profileResponse.json();
      if (!profile.sub || !profile.email || profile.email_verified !== true) throw new Error("Verified Google email required");
      profile = { providerId: profile.sub, email: profile.email, name: profile.name || profile.email };
    } else {
      const profileUrl = new URL("https://graph.facebook.com/v20.0/me");
      profileUrl.searchParams.set("fields", "id,name,email");
      profileUrl.searchParams.set("access_token", tokenData.access_token);
      const profileResponse = await fetch(profileUrl);
      if (!profileResponse.ok) throw new Error("Facebook profile lookup failed");
      const facebookProfile = await profileResponse.json();
      if (!facebookProfile.id || !facebookProfile.email) throw new Error("Facebook email permission required");
      profile = { providerId: facebookProfile.id, email: facebookProfile.email, name: facebookProfile.name || facebookProfile.email };
    }

    const store = getStore();
    let user = store.users.find((item) => item.provider === provider && item.providerId === profile.providerId);
    if (!user) {
      user = {
        id: randomUUID(),
        provider,
        providerId: profile.providerId,
        email: profile.email.toLowerCase(),
        name: String(profile.name).slice(0, 100),
        status: "active",
        createdAt: new Date().toISOString(),
        lastSeenAt: null
      };
      store.users.push(user);
    }
    if (user.status !== "active") {
      response.writeHead(302, { Location: "/?auth=blocked" }).end();
      return;
    }
    user.email = profile.email.toLowerCase();
    user.name = String(profile.name).slice(0, 100);
    user.lastSeenAt = new Date().toISOString();
    await persist();
    createSession(request, response, "member", user.id);
    response.writeHead(302, { Location: "/?auth=success", "Cache-Control": "no-store" }).end();
  } catch (error) {
    console.error("[oauth] sign-in failed:", error.message);
    response.writeHead(302, { Location: "/?auth=error" }).end();
  }
}

function memberPublicProfile(user) {
  return user ? { id: user.id, email: user.email, name: user.name, provider: user.provider, status: user.status } : null;
}

function disconnectMember(memberId, message) {
  for (const [client, state] of clients) {
    if (state.memberId !== memberId) continue;
    removeFromQueue(client);
    detachPeer(client, { requeuePeer: true, skipPeer: true });
    send(client, { type: "error", message });
    client.close(1008, "Account unavailable");
  }
}

function recordModeration(action, userId, adminEmail) {
  const store = getStore();
  store.moderationLog.unshift({ id: randomUUID(), action, userId, adminEmail, createdAt: new Date().toISOString() });
  store.moderationLog.length = Math.min(store.moderationLog.length, 500);
}

async function handleApi(request, response, url) {
  const pathname = url.pathname;
  const store = getStore();
  if (request.method === "GET" && pathname === "/api/site-config") {
    sendJson(response, 200, publicSettings());
    return;
  }
  if (request.method === "GET" && pathname === "/api/auth/options") {
    sendJson(response, 200, { google: oauthConfigured("google"), facebook: oauthConfigured("facebook"), registrationsEnabled: store.settings.registrationsEnabled });
    return;
  }
  if (request.method === "GET" && pathname === "/api/auth/me") {
    const session = getSession(request);
    const user = session?.role === "member" ? store.users.find((item) => item.id === session.id) : null;
    sendJson(response, 200, { user: memberPublicProfile(user), csrfToken: session?.csrfToken || null });
    return;
  }
  if (pathname.startsWith("/api/") && request.method !== "GET" && !sameOrigin(request)) {
    sendJson(response, 403, { error: "Origin not allowed" });
    return;
  }
  if (request.method === "POST" && pathname === "/api/auth/logout") {
    const session = getSession(request);
    if (session) sessions.delete(session.token);
    clearSessionCookie(request, response);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === "POST" && (pathname === "/api/auth/register" || pathname === "/api/auth/login")) {
    const attempt = takeLoginAttempt(request);
    if (attempt.blocked) {
      sendJson(response, 429, { error: "محاولات كثيرة. انتظر 15 دقيقة ثم أعد المحاولة." });
      return;
    }
    let body;
    try { body = await readJson(request); } catch (error) { sendJson(response, error.statusCode || 400, { error: "طلب غير صالح" }); return; }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const isRegistration = pathname.endsWith("register");
    if (!validEmail(email) || password.length > 256 || (isRegistration && password.length < 12)) {
      rejectLoginAttempt(attempt);
      sendJson(response, 400, { error: isRegistration ? "أدخل بريدًا صحيحًا وكلمة مرور من 12 حرفًا على الأقل." : "بيانات الدخول غير صحيحة." });
      return;
    }
    if (isRegistration && email === store.credentials?.email) {
      rejectLoginAttempt(attempt);
      sendJson(response, 409, { error: "هذا البريد مخصص لحساب الإدارة." });
      return;
    }
    if (isRegistration && !store.settings.registrationsEnabled) {
      sendJson(response, 403, { error: "التسجيل متوقف حاليًا." });
      return;
    }
    if (!isRegistration && email === store.credentials?.email && validAdminPassword(password, store.credentials)) {
      completeLoginAttempt(attempt);
      const adminSession = createSession(request, response, "admin", store.credentials.email);
      sendJson(response, 200, { role: "admin", csrfToken: adminSession.csrfToken });
      return;
    }
    let user = store.users.find((item) => item.email === email);
    if (isRegistration) {
      if (user) {
        rejectLoginAttempt(attempt);
        sendJson(response, 409, { error: "تعذر إنشاء الحساب بهذا البريد. جرّب تسجيل الدخول." });
        return;
      }
      const passwordCredentials = hashPassword(password);
      user = {
        id: randomUUID(),
        provider: "password",
        providerId: null,
        passwordSalt: passwordCredentials.salt,
        passwordHash: passwordCredentials.hash,
        email,
        name: typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 100) : email.split("@")[0],
        status: "active",
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString()
      };
      store.users.push(user);
      await persist();
    } else {
      const passwordCredentials = user?.passwordSalt && user?.passwordHash
        ? { salt: user.passwordSalt, hash: user.passwordHash }
        : null;
      if (!passwordCredentials || !validAdminPassword(password, passwordCredentials)) {
        rejectLoginAttempt(attempt);
        sendJson(response, 401, { error: "البريد أو كلمة المرور غير صحيحة." });
        return;
      }
      if (user.status !== "active") {
        sendJson(response, 403, { error: "الحساب موقوف. تواصل مع الإدارة." });
        return;
      }
      user.lastSeenAt = new Date().toISOString();
      await persist();
    }
    if (user.status !== "active") {
      sendJson(response, 403, { error: "الحساب موقوف. تواصل مع الإدارة." });
      return;
    }
    completeLoginAttempt(attempt);
    const memberSession = createSession(request, response, "member", user.id);
    sendJson(response, isRegistration ? 201 : 200, { user: memberPublicProfile(user), csrfToken: memberSession.csrfToken });
    return;
  }
  if (request.method === "POST" && pathname === "/api/admin/login") {
    const attempt = takeLoginAttempt(request);
    if (attempt.blocked) {
      sendJson(response, 429, { error: "محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة." });
      return;
    }
    let body;
    try { body = await readJson(request); } catch (error) { sendJson(response, error.statusCode || 400, { error: "طلب غير صالح" }); return; }
    const credentials = store.credentials;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const valid = credentials && email === credentials.email && validAdminPassword(body.password, credentials);
    if (!valid) {
      rejectLoginAttempt(attempt);
      sendJson(response, 401, { error: "بيانات الدخول غير صحيحة" });
      return;
    }
    completeLoginAttempt(attempt);
    const session = createSession(request, response, "admin", credentials.email);
    sendJson(response, 200, { ok: true, csrfToken: session.csrfToken });
    return;
  }

  const session = getSession(request);
  const adminRequired = pathname.startsWith("/api/admin/");
  if (adminRequired && (session?.role !== "admin" || !validCsrf(request, session) && request.method !== "GET")) {
    sendJson(response, session?.role === "admin" ? 403 : 401, { error: "يلزم تسجيل دخول المشرف" });
    return;
  }
  if (request.method === "GET" && pathname === "/api/admin/live-sessions") {
    const liveSessions = [...clients.entries()].map(([client, state]) => {
      const user = state.memberId ? store.users.find((item) => item.id === state.memberId) : null;
      const partnerState = state.partner ? clients.get(state.partner) : null;
      const partnerUser = partnerState?.memberId ? store.users.find((item) => item.id === partnerState.memberId) : null;
      return {
        id: state.id,
        name: user?.name || "زائر",
        email: user?.email || null,
        phase: state.phase,
        partnerName: partnerState ? partnerUser?.name || "زائر" : null,
        connectedAt: state.connectedAt,
        matchStartedAt: state.matchStartedAt,
        waiting: state.waiting,
        open: client.readyState === WebSocket.OPEN
      };
    });
    sendJson(response, 200, { online: webSocketServer.clients.size, liveSessions });
    return;
  }
  if (request.method === "POST" && pathname === "/api/admin/logout") {
    sessions.delete(session.token);
    clearSessionCookie(request, response);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === "GET" && pathname === "/api/admin/overview") {
    const onlineIds = new Set([...clients.values()].map((client) => client.memberId).filter(Boolean));
    const users = store.users.map((user) => ({ ...memberPublicProfile(user), createdAt: user.createdAt, lastSeenAt: user.lastSeenAt, online: onlineIds.has(user.id) }));
    const userById = new Map(users.map((user) => [user.id, user]));
    const liveSessions = [...clients.entries()].map(([client, state]) => {
      const user = state.memberId ? userById.get(state.memberId) : null;
      const partnerState = state.partner ? clients.get(state.partner) : null;
      const partnerUser = partnerState?.memberId ? userById.get(partnerState.memberId) : null;
      return {
        id: state.id,
        memberId: state.memberId,
        name: user?.name || "زائر",
        email: user?.email || null,
        phase: state.phase,
        partnerName: partnerUser?.name || (partnerState ? "زائر" : null),
        connectedAt: state.connectedAt,
        matchStartedAt: state.matchStartedAt,
        waiting: state.waiting,
        open: client.readyState === WebSocket.OPEN
      };
    });
    const reports = store.reports.map((report) => ({
      ...report,
      reporterEmail: userById.get(report.reporterId)?.email || "زائر",
      reportedEmail: userById.get(report.reportedId)?.email || "زائر / حساب محذوف"
    }));
    sendJson(response, 200, {
      adminEmail: store.credentials?.email || session.id,
      csrfToken: session.csrfToken,
      providers: { google: oauthConfigured("google"), facebook: oauthConfigured("facebook") },
      stats: {
        online: webSocketServer.clients.size,
        liveMatches: liveSessions.filter((item) => item.phase === "chatting").length / 2,
        members: users.length,
        activeMembers: users.filter((user) => user.status === "active").length,
        openReports: reports.filter((report) => report.status === "open").length
      },
      settings: store.settings,
      users,
      liveSessions,
      reports,
      moderationLog: store.moderationLog.slice(0, 50)
    });
    return;
  }
  if (request.method === "POST" && pathname === "/api/admin/users/action") {
    let body;
    try { body = await readJson(request); } catch (error) { sendJson(response, error.statusCode || 400, { error: "طلب غير صالح" }); return; }
    const user = store.users.find((item) => item.id === body.userId);
    const actions = new Set(["activate", "deactivate", "ban", "unban", "delete"]);
    if (!user || !actions.has(body.action)) { sendJson(response, 404, { error: "العضو أو الإجراء غير موجود" }); return; }
    if (body.action === "delete") {
      store.users = store.users.filter((item) => item.id !== user.id);
      disconnectMember(user.id, "تم حذف الحساب.");
    } else {
      user.status = body.action === "ban" ? "banned" : body.action === "deactivate" ? "inactive" : "active";
      user.updatedAt = new Date().toISOString();
      if (user.status !== "active") disconnectMember(user.id, user.status === "banned" ? "تم حظر حسابك." : "تم إيقاف حسابك.");
    }
    recordModeration(body.action, user.id, store.credentials?.email || session.id);
    await persist();
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === "POST" && pathname === "/api/admin/sessions/disconnect") {
    let body;
    try { body = await readJson(request); } catch (error) { sendJson(response, error.statusCode || 400, { error: "طلب غير صالح" }); return; }
    const target = [...clients.entries()].find(([, state]) => state.id === body.sessionId);
    if (!target) { sendJson(response, 404, { error: "الجلسة غير متصلة" }); return; }
    const [client, state] = target;
    removeFromQueue(client);
    send(client, { type: "error", message: "أنهت الإدارة الجلسة." });
    client.close(1008, "Session ended by administrator");
    recordModeration("disconnect-session", state.memberId || state.id, store.credentials?.email || session.id);
    await persist();
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === "POST" && pathname === "/api/admin/reports/action") {
    let body;
    try { body = await readJson(request); } catch (error) { sendJson(response, error.statusCode || 400, { error: "طلب غير صالح" }); return; }
    const report = store.reports.find((item) => item.id === body.reportId);
    if (!report || !["resolve", "dismiss", "ban"].includes(body.action)) { sendJson(response, 404, { error: "البلاغ أو الإجراء غير موجود" }); return; }
    report.status = body.action === "dismiss" ? "dismissed" : "resolved";
    report.reviewedAt = new Date().toISOString();
    if (body.action === "ban") {
      const reportedUser = store.users.find((item) => item.id === report.reportedId);
      if (reportedUser) {
        reportedUser.status = "banned";
        reportedUser.updatedAt = report.reviewedAt;
        disconnectMember(reportedUser.id, "تم حظر حسابك.");
        recordModeration("ban-from-report", reportedUser.id, store.credentials?.email || session.id);
      }
    }
    await persist();
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === "POST" && pathname === "/api/admin/settings") {
    let body;
    try { body = await readJson(request); } catch (error) { sendJson(response, error.statusCode || 400, { error: "طلب غير صالح" }); return; }
    const next = { ...store.settings };
    for (const key of ["siteName", "tagline", "announcement"]) {
      if (typeof body[key] === "string") next[key] = body[key].trim().slice(0, key === "announcement" ? 500 : 80);
    }
    for (const key of ["maintenance", "matchingEnabled", "registrationsEnabled", "allowGuestAccess"]) {
      if (typeof body[key] === "boolean") next[key] = body[key];
    }
    store.settings = next;
    await persist();
    sendJson(response, 200, { ok: true, settings: store.settings });
    return;
  }
  if (request.method === "POST" && pathname === "/api/admin/credentials") {
    let body;
    try { body = await readJson(request); } catch (error) { sendJson(response, error.statusCode || 400, { error: "طلب غير صالح" }); return; }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!validAdminPassword(body.currentPassword, store.credentials) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      sendJson(response, 400, { error: "تحقق من كلمة المرور الحالية والبريد" });
      return;
    }
    if (typeof body.newPassword === "string" && body.newPassword && body.newPassword.length < 12) {
      sendJson(response, 400, { error: "كلمة المرور الجديدة يجب أن تكون 12 حرفًا على الأقل" });
      return;
    }
    const salt = randomBytes(16);
    const password = body.newPassword || body.currentPassword;
    store.credentials = { email, salt: salt.toString("hex"), hash: scryptSync(password, salt, 32).toString("hex") };
    await persist();
    sessions.clear();
    const freshSession = createSession(request, response, "admin", email);
    sendJson(response, 200, { ok: true, email, csrfToken: freshSession.csrfToken });
    return;
  }
  sendJson(response, 404, { error: "المسار غير موجود" });
}

const server = http.createServer(async (request, response) => {
  secureHeaders(response);
  let url;
  try {
    url = new URL(request.url, "http://localhost");
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    await handleApi(request, response, url).catch((error) => {
      console.error("[api] request failed:", error.message);
      if (!response.headersSent) sendJson(response, 500, { error: "حدث خطأ داخلي" });
      else response.end();
    });
    return;
  }
  const oauthMatch = url.pathname.match(/^\/auth\/(google|facebook)(\/callback)?$/);
  if (oauthMatch) {
    if (request.method !== "GET") { response.writeHead(405, { Allow: "GET" }).end(); return; }
    const [, provider, callback] = oauthMatch;
    if (callback) await finishOAuth(request, response, provider, url);
    else beginOAuth(request, response, provider);
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  if (pathname === "/admin") pathname = "/admin.html";
  const relativePath = pathname.replace(/^[/\\]+/, "");
  const topLevel = relativePath.split(/[\\/]/, 1)[0];
  if (!allowedTopLevel.has(topLevel)) {
    response.writeHead(404).end("Not found");
    return;
  }

  const filePath = path.resolve(publicRoot, relativePath);
  const relativeToRoot = path.relative(publicRoot, filePath);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    response.writeHead(404).end("Not found");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(request.method === "HEAD" ? undefined : file);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

const webSocketServer = new WebSocketServer({ server, path: "/signal", maxPayload: 96 * 1024 });

function send(client, payload) {
  if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
}

function broadcastOnlineCount() {
  const count = webSocketServer.clients.size;
  for (const client of webSocketServer.clients) send(client, { type: "online_count", count });
}

function removeFromQueue(client) {
  const index = waitingQueue.indexOf(client);
  if (index !== -1) waitingQueue.splice(index, 1);
  const state = clients.get(client);
  if (state) state.waiting = false;
}

function normalizePreferences(input = {}) {
  return {
    country: countries.has(input.country) ? input.country : "other",
    gender: genders.has(input.gender) ? input.gender : "other",
    lookingFor: lookingForValues.has(input.lookingFor) ? input.lookingFor : "everyone"
  };
}

function acceptsGender(lookingFor, gender) {
  return lookingFor === "everyone" || lookingFor === gender;
}

function compatible(first, second) {
  return acceptsGender(first.preferences.lookingFor, second.preferences.gender)
    && acceptsGender(second.preferences.lookingFor, first.preferences.gender);
}

function publicProfile(state) {
  return { country: state.preferences.country, gender: state.preferences.gender };
}

function queueClient(client) {
  const state = clients.get(client);
  if (!state || client.readyState !== WebSocket.OPEN || state.partner) return;
  const settings = getStore().settings;
  if (settings.maintenance || !settings.matchingEnabled) {
    removeFromQueue(client);
    sendError(client, settings.maintenance ? "الموقع في وضع الصيانة حاليًا." : "المطابقة متوقفة مؤقتًا.");
    return;
  }
  if (!state.memberId && !settings.allowGuestAccess) {
    removeFromQueue(client);
    sendError(client, "سجّل الدخول للمتابعة.");
    return;
  }
  if (state.memberId) {
    const user = getStore().users.find((item) => item.id === state.memberId);
    if (!user || user.status !== "active") {
      removeFromQueue(client);
      sendError(client, "حسابك غير مفعّل.");
      client.close(1008, "Account unavailable");
      return;
    }
  }
  removeFromQueue(client);
  state.waiting = true;
  state.phase = "waiting";
  state.matchStartedAt = null;

  const matchIndex = waitingQueue.findIndex((candidate) => {
    const candidateState = clients.get(candidate);
    return candidateState
      && candidate !== client
      && candidate.readyState === WebSocket.OPEN
      && !candidateState.partner
      && compatible(state, candidateState)
      && state.skipPeerId !== candidateState.id
      && candidateState.skipPeerId !== state.id;
  });

  if (matchIndex === -1) {
    waitingQueue.push(client);
    send(client, { type: "waiting" });
    return;
  }

  const peer = waitingQueue.splice(matchIndex, 1)[0];
  const peerState = clients.get(peer);
  state.waiting = false;
  peerState.waiting = false;
  state.phase = "chatting";
  peerState.phase = "chatting";
  state.matchStartedAt = new Date().toISOString();
  peerState.matchStartedAt = state.matchStartedAt;
  state.partner = peer;
  peerState.partner = client;
  state.skipPeerId = null;
  peerState.skipPeerId = null;
  send(client, { type: "matched", initiator: true, peer: publicProfile(peerState) });
  send(peer, { type: "matched", initiator: false, peer: publicProfile(state) });
}

function detachPeer(client, { notify = true, requeuePeer = false, skipPeer = false } = {}) {
  const state = clients.get(client);
  const peer = state?.partner;
  if (!peer) return null;
  const peerState = clients.get(peer);
  state.partner = null;
  state.phase = "connected";
  state.matchStartedAt = null;
  if (peerState) {
    peerState.partner = null;
    peerState.phase = "connected";
    peerState.matchStartedAt = null;
  }
  if (skipPeer && peerState) {
    state.skipPeerId = peerState.id;
    peerState.skipPeerId = state.id;
  }
  if (notify) send(peer, { type: "peer_left" });
  if (requeuePeer && peerState && peer.readyState === WebSocket.OPEN) queueClient(peer);
  return peer;
}

function sendError(client, message) {
  send(client, { type: "error", message });
}

function relaySignal(client, message) {
  const state = clients.get(client);
  if (!state?.partner || !message.data || typeof message.data !== "object") return;
  if (message.kind === "offer" || message.kind === "answer") {
    const { type, sdp } = message.data;
    if (type !== message.kind || typeof sdp !== "string" || sdp.length > 80_000) return;
    send(state.partner, { type: "signal", kind: message.kind, data: { type, sdp } });
  } else if (message.kind === "candidate") {
    const candidate = message.data;
    if (typeof candidate.candidate !== "string" || candidate.candidate.length > 8_000) return;
    send(state.partner, { type: "signal", kind: "candidate", data: candidate });
  }
}

function handleMessage(client, message) {
  const state = clients.get(client);
  if (!state || !message || typeof message.type !== "string") return;

  if (message.type === "join") {
    if (state.partner) detachPeer(client, { requeuePeer: true, skipPeer: true });
    removeFromQueue(client);
    state.preferences = normalizePreferences(message.preferences);
    state.skipPeerId = null;
    queueClient(client);
  } else if (message.type === "next") {
    if (state.partner) detachPeer(client, { requeuePeer: true, skipPeer: true });
    else removeFromQueue(client);
    queueClient(client);
  } else if (message.type === "leave") {
    removeFromQueue(client);
    detachPeer(client, { requeuePeer: true, skipPeer: true });
  } else if (message.type === "signal") {
    relaySignal(client, message);
  } else if (message.type === "chat") {
    const text = typeof message.text === "string" ? message.text.trim() : "";
    const now = Date.now();
    state.messageTimes = state.messageTimes.filter((sentAt) => now - sentAt < 10_000);
    if (text.length === 0 || text.length > 500) return;
    if (state.messageTimes.length >= 12) {
      sendError(client, "تم الإرسال بسرعة. انتظر قليلًا ثم أعد المحاولة.");
      return;
    }
    if (!state.partner) return;
    state.messageTimes.push(now);
    send(state.partner, { type: "chat", text });
  } else if (message.type === "report") {
    if (!state.partner) return;
    const peer = state.partner;
    const peerState = clients.get(peer);
    const report = {
      id: randomUUID(),
      reporterId: state.memberId,
      reportedId: peerState?.memberId || null,
      reporterSessionId: state.id,
      reportedSessionId: peerState?.id || null,
      reason: String(message.reason || "unspecified").slice(0, 80),
      status: "open",
      createdAt: new Date().toISOString()
    };
    getStore().reports.unshift(report);
    getStore().reports.length = Math.min(getStore().reports.length, 2000);
    void persist().catch((error) => console.error("[reports] save failed:", error.message));
    send(client, { type: "report_received" });
    removeFromQueue(client);
    detachPeer(client, { requeuePeer: true, skipPeer: true });
    if (peer.readyState === WebSocket.OPEN) queueClient(peer);
  }
}

webSocketServer.on("connection", (client, request) => {
  const origin = request.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== request.headers.host) {
        client.close(1008, "Origin not allowed");
        return;
      }
    } catch {
      client.close(1008, "Invalid origin");
      return;
    }
  }

  const session = getSession(request);
  const member = session?.role === "member" ? getStore().users.find((item) => item.id === session.id) : null;
  if ((session?.role === "member" && (!member || member.status !== "active"))
    || (!member && !getStore().settings.allowGuestAccess)) {
    client.close(1008, "Sign in required");
    return;
  }

  clients.set(client, {
    id: randomUUID(),
    memberId: member?.id || null,
    phase: "connected",
    connectedAt: new Date().toISOString(),
    matchStartedAt: null,
    preferences: normalizePreferences(),
    partner: null,
    waiting: false,
    skipPeerId: null,
    messageTimes: []
  });
  broadcastOnlineCount();
  client.on("message", (raw) => {
    try {
      handleMessage(client, JSON.parse(raw.toString()));
    } catch {
      sendError(client, "تعذر قراءة الطلب.");
    }
  });
  client.on("close", () => {
    removeFromQueue(client);
    detachPeer(client, { requeuePeer: true, skipPeer: true });
    clients.delete(client);
    broadcastOnlineCount();
  });
  client.on("error", () => {});
});

const port = Number(process.env.PORT) || 3001;
initialize().then(() => {
  server.listen(port, "0.0.0.0", () => {
    console.log(`WASL server listening on http://localhost:${port}`);
  });
}).catch((error) => {
  console.error("Unable to initialize WASL storage:", error.message);
  process.exitCode = 1;
});
