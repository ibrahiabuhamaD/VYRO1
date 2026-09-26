const onlineCount = document.querySelector("#onlineCount");
const serverCaption = document.querySelector("#serverCaption");
const welcomeIdle = document.querySelector("#welcomeIdle");
const welcomeSearching = document.querySelector("#welcomeSearching");
const welcomeMatched = document.querySelector("#welcomeMatched");
const welcomeMatchTitle = document.querySelector("#welcomeMatchTitle");
const welcomeMatchHint = document.querySelector("#welcomeMatchHint");
const welcomePane = document.querySelector(".welcome-pane");
const localCameraName = document.querySelector("#localCameraName");
const localCameraPaused = document.querySelector("#localCameraPaused");
const connectionPill = document.querySelector("#connectionPill");
const connectionLabel = document.querySelector("#connectionLabel");
const remotePane = document.querySelector("#remotePane");
const remoteVideo = document.querySelector("#remoteVideo");
const remoteKicker = document.querySelector("#remoteKicker");
const remoteTitle = document.querySelector("#remoteTitle");
const remoteHint = document.querySelector("#remoteHint");
const remoteBottomStatus = document.querySelector("#remoteBottomStatus");
const peerCaption = document.querySelector("#peerCaption");
const peerCountry = document.querySelector("#peerCountry");
const peerGender = document.querySelector("#peerGender");
const localVideo = document.querySelector("#localVideo");
const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const nextButton = document.querySelector("#nextButton");
const cameraButton = document.querySelector("#cameraButton");
const micButton = document.querySelector("#micButton");
const countrySelect = document.querySelector("#countrySelect");
const genderSelect = document.querySelector("#genderSelect");
const lookingForSelect = document.querySelector("#lookingForSelect");
const audioDeviceSelect = document.querySelector("#audioDeviceSelect");
const chatStream = document.querySelector("#chatStream");
const chatEmpty = document.querySelector("#chatEmpty");
const messageForm = document.querySelector("#messageForm");
const messageInput = document.querySelector("#messageInput");
const sendButton = document.querySelector("#sendButton");
const toast = document.querySelector("#toast");
const permissionDialog = document.querySelector("#permissionDialog");
const permissionStorageKey = "wasl.permissions-intro.v1";
const signalUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/signal`;
const iceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
];

const state = {
  socket: null,
  socketPromise: null,
  stream: null,
  peerConnection: null,
  pendingCandidates: [],
  active: false,
  matched: false,
  searching: false,
  currentPeer: null,
  locationGranted: false,
  toastTimer: null,
  matchSetup: Promise.resolve()
};

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3400);
}

function sendSignalMessage(message) {
  if (state.socket?.readyState !== WebSocket.OPEN) return false;
  state.socket.send(JSON.stringify(message));
  return true;
}

function setConnectionState(kind, label) {
  connectionPill.classList.toggle("is-ready", kind === "ready");
  connectionPill.classList.toggle("is-searching", kind === "searching");
  connectionPill.classList.toggle("is-error", kind === "error");
  connectionLabel.textContent = label;
}

function setWelcomeState(kind) {
  const matched = kind === "matched" || kind === "live";
  welcomeIdle.hidden = kind !== "idle";
  welcomeSearching.hidden = kind !== "searching";
  welcomeMatched.hidden = !matched;
  if (matched) {
    welcomeMatchTitle.textContent = kind === "live" ? "مكالمة مباشرة" : "جارٍ توصيل الفيديو...";
    welcomeMatchHint.textContent = state.currentPeer ? formatCountry(state.currentPeer.country) : "المكالمة مباشرة بين الجهازين.";
  }
}

function setRemotePlaceholder(kind, title, hint) {
  if (kind !== "connected") state.currentPeer = null;
  setWelcomeState(kind === "connected" ? "matched" : kind);
  welcomePane.classList.toggle("is-searching", kind === "searching");
  welcomePane.classList.toggle("is-connected", kind === "connected");
  updateLocalCameraPresentation();
  remoteBottomStatus.textContent = kind === "connected" ? "يتم إنشاء اتصال مباشر بين الجهازين" : "لا تشارك بياناتك الشخصية";
  peerCaption.hidden = kind !== "connected";
  nextButton.disabled = !state.active;
  messageInput.disabled = !state.matched;
  sendButton.disabled = !state.matched;
}

function updateLocalCameraPresentation() {
  const track = state.stream?.getVideoTracks()[0];
  const hasLiveCamera = Boolean(track && track.readyState === "live");
  const cameraPaused = hasLiveCamera && !track.enabled;
  remotePane.classList.toggle("has-local-video", hasLiveCamera);
  remotePane.classList.toggle("camera-paused", cameraPaused);
  localCameraName.hidden = !hasLiveCamera;
  localCameraPaused.hidden = !cameraPaused;
  remoteKicker.textContent = hasLiveCamera ? "معاينتك" : "الكاميرا";
  remoteTitle.textContent = hasLiveCamera ? "أنت" : "كاميرتك تظهر هنا";
  remoteHint.textContent = hasLiveCamera ? "صورتك ظاهرة للطرف الآخر." : "امنح إذن الكاميرا لمعاينة صورتك.";
}

function setServerConnection(online) {
  serverCaption.textContent = online ? "الخادم جاهز لاستقبال اللقاءات" : "تعذر الاتصال بخادم المطابقة";
  serverCaption.classList.toggle("is-offline", !online);
  if (!online && !state.active) setConnectionState("error", "الخادم غير متصل");
  if (online && !state.active) setConnectionState("ready", "متصل بالخادم");
}

function updateControls() {
  startButton.disabled = state.active || !state.socket || state.socket.readyState !== WebSocket.OPEN;
  stopButton.disabled = !state.active;
  nextButton.disabled = !state.active;
  cameraButton.disabled = !state.stream;
  micButton.disabled = !state.stream;
  cameraButton.setAttribute("aria-pressed", String(Boolean(state.stream && !state.stream.getVideoTracks()[0]?.enabled)));
  micButton.setAttribute("aria-pressed", String(Boolean(state.stream && !state.stream.getAudioTracks()[0]?.enabled)));
}

function connectSignalServer() {
  if (state.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
  if (state.socketPromise) return state.socketPromise;

  state.socketPromise = new Promise((resolve, reject) => {
    const socket = new WebSocket(signalUrl);
    state.socket = socket;
    let settled = false;
    const connectionTimer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(new Error("تعذر الاتصال بالخادم"));
    }, 5000);

    socket.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(connectionTimer);
      setServerConnection(true);
      updateControls();
      resolve();
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      void handleServerMessage(message);
    });
    socket.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(connectionTimer);
      reject(new Error("تعذر الاتصال بالخادم"));
    });
    socket.addEventListener("close", () => {
      window.clearTimeout(connectionTimer);
      if (state.socket !== socket) return;
      state.socket = null;
      state.socketPromise = null;
      setServerConnection(false);
      onlineCount.textContent = "0";
      if (state.active) {
        state.active = false;
        state.searching = false;
        state.matched = false;
        closePeerConnection();
        stopLocalMedia();
        setRemotePlaceholder("idle", "انقطع الاتصال بالخادم", "أعد المحاولة بعد عودة الخادم.");
        setConnectionState("error", "انقطع الاتصال");
        showToast("انقطع الاتصال بخادم المطابقة.");
      }
      updateControls();
    });
  }).finally(() => {
    state.socketPromise = null;
  });
  return state.socketPromise;
}

async function requestLocalMedia() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("افتح الموقع عبر localhost أو HTTPS حتى تسمح للمتصفح باستخدام الكاميرا.");
  }
  if (state.stream?.getTracks().some((track) => track.readyState === "live")) {
    localVideo.srcObject = state.stream;
    updateLocalCameraPresentation();
    updateControls();
    return;
  }
  const video = { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" };
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (audioDeviceSelect.value) audio.deviceId = { exact: audioDeviceSelect.value };
  state.stream = await navigator.mediaDevices.getUserMedia({ video, audio });
  localVideo.srcObject = state.stream;
  updateLocalCameraPresentation();
  await refreshAudioDevices();
  updateControls();
}

function requestLocationPermission() {
  if (!navigator.geolocation) return Promise.resolve(false);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      () => {
        state.locationGranted = true;
        resolve(true);
      },
      () => {
        state.locationGranted = false;
        resolve(false);
      },
      { enableHighAccuracy: false, maximumAge: 300000, timeout: 7000 }
    );
  });
}

async function requestStartupPermissions() {
  permissionDialog.close();
  try {
    localStorage.setItem(permissionStorageKey, "seen");
  } catch {
    showToast("تعذر حفظ تفضيل الأذونات لهذا المتصفح.");
  }

  const [mediaResult, locationResult] = await Promise.allSettled([
    requestLocalMedia(),
    requestLocationPermission()
  ]);
  if (mediaResult.status === "fulfilled") {
    showToast(locationResult.status === "fulfilled" && locationResult.value
      ? "الكاميرا والميكروفون جاهزان. موقعك لا يُرسل للخادم."
      : "الكاميرا والميكروفون جاهزان؛ اختر بلدك يدويًا.");
  } else {
    showToast(getMediaErrorMessage(mediaResult.reason));
  }
}

function getMediaErrorMessage(error) {
  if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") return "اسمح للمتصفح باستخدام الكاميرا والميكروفون لبدء اللقاء.";
  if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") return "لم نعثر على كاميرا وميكروفون متاحين.";
  if (error.name === "NotReadableError") return "الكاميرا أو الميكروفون قيد الاستخدام في تطبيق آخر.";
  return error.message || "تعذر تشغيل الكاميرا والميكروفون.";
}

async function startMeeting() {
  if (state.active || startButton.disabled) return;
  startButton.disabled = true;
  setWelcomeState("searching");
  setConnectionState("searching", "جارٍ بدء اللقاء");
  try {
    await connectSignalServer();
    await requestLocalMedia();
    state.active = true;
    state.searching = true;
    state.matched = false;
    clearChat();
    setRemotePlaceholder("searching", "نبحث عن شخص متصل...", "سيبدأ الاتصال مباشرة عند العثور على طرف مناسب.");
    setConnectionState("searching", "نبحث عن متصل");
    sendSignalMessage({
      type: "join",
      preferences: {
        country: countrySelect.value,
        gender: genderSelect.value,
        lookingFor: lookingForSelect.value
      }
    });
    updateControls();
  } catch (error) {
    stopLocalMedia();
    state.active = false;
    setRemotePlaceholder("idle", "تعذر بدء اللقاء", getMediaErrorMessage(error));
    setConnectionState("error", "تعذر البدء");
    showToast(getMediaErrorMessage(error));
    updateControls();
  }
}

function stopMeeting() {
  if (!state.active && !state.stream) return;
  sendSignalMessage({ type: "leave" });
  state.active = false;
  state.searching = false;
  state.matched = false;
  closePeerConnection();
  stopLocalMedia();
  clearChat();
  setRemotePlaceholder("idle", "ابدأ لقاءً جديدًا", "سيظهر الطرف الآخر هنا عند العثور على متصل مناسب.");
  setConnectionState(state.socket?.readyState === WebSocket.OPEN ? "ready" : "error", state.socket?.readyState === WebSocket.OPEN ? "متصل بالخادم" : "الخادم غير متصل");
  updateControls();
}

function nextMatch() {
  if (!state.active || !sendSignalMessage({ type: "next" })) return;
  state.matched = false;
  state.searching = true;
  closePeerConnection();
  clearChat();
  setRemotePlaceholder("searching", "نبحث عن شخص آخر...", "ستنتقل إلى متصل جديد عندما يكون متاحًا.");
  setConnectionState("searching", "جارٍ البحث");
  updateControls();
}

function closePeerConnection() {
  if (state.peerConnection) {
    state.peerConnection.ontrack = null;
    state.peerConnection.onicecandidate = null;
    state.peerConnection.onconnectionstatechange = null;
    state.peerConnection.close();
  }
  state.peerConnection = null;
  state.pendingCandidates = [];
  remoteVideo.srcObject = null;
  state.matchSetup = Promise.resolve();
}

function stopLocalMedia() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  localVideo.srcObject = null;
  updateLocalCameraPresentation();
  setWelcomeState("idle");
  updateControls();
}

function sendPeerSignal(kind, data) {
  if (!sendSignalMessage({ type: "signal", kind, data })) {
    showToast("انقطع اتصال الإشارات؛ أعد بدء اللقاء.");
  }
}

function setupPeerConnection(initiator) {
  closePeerConnection();
  const connection = new RTCPeerConnection({ iceServers });
  state.peerConnection = connection;
  state.pendingCandidates = [];
  const incomingStream = new MediaStream();
  remoteVideo.srcObject = incomingStream;
  state.stream.getTracks().forEach((track) => connection.addTrack(track, state.stream));
  connection.ontrack = (event) => {
    const stream = event.streams[0];
    if (stream) {
      remoteVideo.srcObject = stream;
    } else {
      incomingStream.addTrack(event.track);
    }
    void remoteVideo.play().catch(() => {});
  };
  connection.onicecandidate = (event) => {
    if (event.candidate) sendPeerSignal("candidate", event.candidate.toJSON());
  };
  connection.onconnectionstatechange = () => {
    if (connection !== state.peerConnection) return;
    if (connection.connectionState === "connected") {
      setConnectionState("ready", "مكالمة مباشرة");
      setWelcomeState("live");
      remoteBottomStatus.textContent = "اتصال مباشر مشفر بين الجهازين";
    } else if (connection.connectionState === "failed") {
      showToast("تعذر إنشاء اتصال الفيديو. جرّب التالي أو أعد المحاولة.");
      nextMatch();
    }
  };
  if (initiator) void createAndSendOffer(connection);
  return connection;
}

async function createAndSendOffer(connection) {
  try {
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    sendPeerSignal("offer", { type: connection.localDescription.type, sdp: connection.localDescription.sdp });
  } catch {
    showToast("تعذر بدء اتصال الفيديو.");
  }
}

async function handleSignal(kind, data) {
  await state.matchSetup;
  const connection = state.peerConnection;
  if (!connection) return;
  try {
    if (kind === "offer") {
      await connection.setRemoteDescription(data);
      await flushCandidates(connection);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      sendPeerSignal("answer", { type: connection.localDescription.type, sdp: connection.localDescription.sdp });
    } else if (kind === "answer") {
      await connection.setRemoteDescription(data);
      await flushCandidates(connection);
    } else if (kind === "candidate") {
      if (connection.remoteDescription) await connection.addIceCandidate(data);
      else state.pendingCandidates.push(data);
    }
  } catch {
    showToast("تعذر إكمال إعداد الاتصال؛ اضغط التالي للمحاولة مجددًا.");
  }
}

async function flushCandidates(connection) {
  const candidates = state.pendingCandidates.splice(0);
  for (const candidate of candidates) await connection.addIceCandidate(candidate);
}

function formatCountry(code) {
  const option = [...countrySelect.options].find((item) => item.value === code);
  return option?.textContent || "متصل جديد";
}

function formatGender(gender) {
  return gender === "women" ? "امرأة" : gender === "men" ? "رجل" : "";
}

function handleMatch(message) {
  state.searching = false;
  state.matched = true;
  state.currentPeer = message.peer || null;
  peerCountry.textContent = formatCountry(message.peer?.country);
  peerGender.textContent = formatGender(message.peer?.gender);
  setRemotePlaceholder("connected", "تم العثور على متصل", "جارٍ إعداد اتصال الفيديو الآمن...");
  setConnectionState("searching", "جارٍ توصيل الفيديو");
  state.matchSetup = Promise.resolve(setupPeerConnection(Boolean(message.initiator))).catch((error) => {
    showToast(error.message || "تعذر بدء اتصال الفيديو.");
  });
  updateControls();
}

async function handleServerMessage(message) {
  switch (message.type) {
    case "online_count":
      onlineCount.textContent = String(message.count);
      break;
    case "waiting":
      if (!state.active) break;
      state.searching = true;
      state.matched = false;
      setRemotePlaceholder("searching", "نبحث عن شخص متصل...", "ستبدأ مكالمة الفيديو فور العثور على طرف مناسب.");
      setConnectionState("searching", "نبحث عن متصل");
      break;
    case "matched":
      if (state.active) handleMatch(message);
      break;
    case "signal":
      await handleSignal(message.kind, message.data);
      break;
    case "chat":
      if (state.matched && typeof message.text === "string") addChatMessage(message.text, true);
      break;
    case "peer_left":
      closePeerConnection();
      state.matched = false;
      if (state.active) {
        state.searching = true;
        setRemotePlaceholder("searching", "انتهى الاتصال", "جارٍ البحث عن متصل آخر.");
        setConnectionState("searching", "نبحث عن متصل");
      }
      updateControls();
      break;
    case "report_received":
      closePeerConnection();
      state.matched = false;
      state.searching = false;
      if (state.active) {
        setRemotePlaceholder("idle", "تم إنهاء اللقاء", "شكرًا لمساعدتنا على إبقاء المجتمع آمنًا.");
        setConnectionState("ready", "تم استلام البلاغ");
      }
      showToast("تم استلام البلاغ وإنهاء الاتصال.");
      updateControls();
      break;
    case "error":
      showToast(message.message || "تعذر تنفيذ الطلب.");
      break;
  }
}

function addChatMessage(text, incoming) {
  chatEmpty.hidden = true;
  const bubble = document.createElement("div");
  bubble.className = `chat-message${incoming ? " incoming" : ""}`;
  bubble.append(document.createTextNode(text));
  const time = document.createElement("time");
  time.textContent = new Intl.DateTimeFormat("ar", { hour: "2-digit", minute: "2-digit" }).format(new Date());
  bubble.append(time);
  chatStream.append(bubble);
  chatStream.scrollTop = chatStream.scrollHeight;
}

function clearChat() {
  chatStream.replaceChildren(chatEmpty);
  chatEmpty.hidden = false;
}

function sendChat(text) {
  const trimmed = text.trim();
  if (!trimmed || !state.matched) return;
  if (!sendSignalMessage({ type: "chat", text: trimmed })) {
    showToast("انقطع الاتصال؛ تعذر إرسال الرسالة.");
    return;
  }
  addChatMessage(trimmed, false);
  messageInput.value = "";
}

async function refreshAudioDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter((device) => device.kind === "audioinput");
    const selected = audioDeviceSelect.value;
    audioDeviceSelect.replaceChildren(new Option("الميكروفون الافتراضي", ""));
    audioInputs.forEach((device, index) => {
      audioDeviceSelect.add(new Option(device.label || `ميكروفون ${index + 1}`, device.deviceId));
    });
    if (audioInputs.some((device) => device.deviceId === selected)) audioDeviceSelect.value = selected;
  } catch {
    showToast("تعذر قراءة أجهزة الصوت المتاحة.");
  }
}

async function changeAudioInput() {
  if (!state.stream) return;
  try {
    const audioConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (audioDeviceSelect.value) audioConstraints.deviceId = { exact: audioDeviceSelect.value };
    const replacement = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
    const nextTrack = replacement.getAudioTracks()[0];
    const previousTrack = state.stream.getAudioTracks()[0];
    const sender = state.peerConnection?.getSenders().find((item) => item.track === previousTrack);
    if (sender) await sender.replaceTrack(nextTrack);
    if (previousTrack) {
      state.stream.removeTrack(previousTrack);
      previousTrack.stop();
    }
    state.stream.addTrack(nextTrack);
    updateControls();
  } catch {
    showToast("تعذر تبديل الميكروفون.");
  }
}

function toggleCamera() {
  const track = state.stream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const off = !track.enabled;
  updateLocalCameraPresentation();
  cameraButton.setAttribute("aria-pressed", String(off));
  cameraButton.setAttribute("aria-label", off ? "تشغيل الكاميرا" : "إيقاف الكاميرا");
  cameraButton.title = off ? "تشغيل الكاميرا" : "إيقاف الكاميرا";
  cameraButton.innerHTML = `<svg><use href="#${off ? "i-video-off" : "i-video"}"/></svg>`;
}

function toggleMicrophone() {
  const track = state.stream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const muted = !track.enabled;
  micButton.setAttribute("aria-pressed", String(muted));
  micButton.setAttribute("aria-label", muted ? "تشغيل الميكروفون" : "كتم الميكروفون");
  micButton.title = muted ? "تشغيل الميكروفون" : "كتم الميكروفون";
  micButton.innerHTML = `<svg><use href="#${muted ? "i-mic-off" : "i-mic"}"/></svg>`;
}

function reportCurrentPeer() {
  if (!state.matched) {
    showToast("لا توجد مكالمة نشطة للإبلاغ عنها.");
    return;
  }
  if (!window.confirm("سيُنهي الإبلاغ مكالمتك الحالية. هل تريد المتابعة؟")) return;
  sendSignalMessage({ type: "report", reason: "inappropriate-behavior" });
}

startButton.addEventListener("click", startMeeting);
stopButton.addEventListener("click", stopMeeting);
nextButton.addEventListener("click", nextMatch);
cameraButton.addEventListener("click", toggleCamera);
micButton.addEventListener("click", toggleMicrophone);
audioDeviceSelect.addEventListener("change", changeAudioInput);
document.querySelector("#allowPermissionsButton").addEventListener("click", requestStartupPermissions);
document.querySelector("#skipPermissionsButton").addEventListener("click", () => {
  try {
    localStorage.setItem(permissionStorageKey, "seen");
  } catch {}
  permissionDialog.close();
});
document.querySelector("#permissionSettingsButton").addEventListener("click", () => {
  document.querySelector("#settingsDialog").close();
  permissionDialog.showModal();
});
messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendChat(messageInput.value);
});
document.querySelector("#settingsButton").addEventListener("click", () => document.querySelector("#settingsDialog").showModal());
document.querySelector("#saveSettingsButton").addEventListener("click", () => {
  document.querySelector("#settingsDialog").close();
  if (state.searching) showToast("تم حفظ التفضيل، وسيُطبّق على اللقاء التالي.");
});
document.querySelector("#fullscreenButton").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await remotePane.requestFullscreen();
  } catch {
    showToast("تعذر تفعيل ملء الشاشة في هذا المتصفح.");
  }
});
document.querySelector("#reportButton").addEventListener("click", reportCurrentPeer);
document.querySelector("#rulesButton").addEventListener("click", () => document.querySelector("#safetyDialog").showModal());
document.querySelector("#termsButton").addEventListener("click", () => document.querySelector("#safetyDialog").showModal());
navigator.mediaDevices?.addEventListener?.("devicechange", refreshAudioDevices);
window.addEventListener("beforeunload", () => {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.peerConnection?.close();
  sendSignalMessage({ type: "leave" });
});

try {
  if (localStorage.getItem(permissionStorageKey) !== "seen") permissionDialog.showModal();
} catch {
  permissionDialog.showModal();
}

connectSignalServer().catch(() => {
  setServerConnection(false);
  updateControls();
});
