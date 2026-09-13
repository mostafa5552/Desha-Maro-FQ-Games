const SUPABASE_URL = "";
const SUPABASE_ANON_KEY = "sb_publishable_AwhUDlto_zbxXOYLy-DDsA_22L1D15l";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const EMAIL_DOMAIN = "@fqgames.local";
const ROUND_TIME = { r1: 20, r2: 15, r3: 50, r4: 15 };
const PLAYERS_PER_ROUND1 = 5;
const QUESTIONS_PER_ROUND2 = 6;

let me = null;
let myMatchChannel = null;
let myInboxChannel = null;
let currentMatch = null;
let hostTimerHandle = null;
let uiTickHandle = null;
let friendsCache = [];

const AI_ID = "ai-opponent";
function isAiMatch(match) { return !!match && match.player2 === AI_ID; }
let aiScheduledSignature = null;

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.add("hidden"), 2600);
}
function isHost(match) { return match.player1 === me.id; }
function otherPlayerId(match) { return match.player1 === me.id ? match.player2 : match.player1; }
function myKey(match) { return match.player1 === me.id ? "p1" : "p2"; }
function oppKey(match) { return match.player1 === me.id ? "p2" : "p1"; }

document.querySelectorAll("[data-goto]").forEach(el => {
  el.addEventListener("click", () => {
    const target = el.dataset.goto;
    showScreen(target);
    if (target === "screen-friends") loadFriendsScreen();
  });
});

document.querySelectorAll(".auth-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".auth-tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".auth-form").forEach(f => f.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("form-" + tab.dataset.tab).classList.add("active");
  });
});

function authError(msg) {
  const el = document.getElementById("auth-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}

document.getElementById("form-signup").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("signup-username").value.trim().toLowerCase();
  const password = document.getElementById("signup-password").value;
  document.getElementById("auth-error").classList.add("hidden");

  const { data: exists } = await sb.from("profiles").select("id").eq("username", username).maybeSingle();
  if (exists) return authError("اسم المستخدم ده متحجز، جرب اسم تاني");

  const { data, error } = await sb.auth.signUp({ email: username + EMAIL_DOMAIN, password });
  if (error) return authError(error.message);

  const uid = data.user?.id;
  if (uid) {
    const { error: pErr } = await sb.from("profiles").insert({ id: uid, username });
    if (pErr) return authError(pErr.message);
  }
  toast("تم إنشاء الحساب! سجّل دخولك");
  document.querySelector('.auth-tab[data-tab="login"]').click();
});

document.getElementById("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("login-username").value.trim().toLowerCase();
  const password = document.getElementById("login-password").value;
  document.getElementById("auth-error").classList.add("hidden");

  const { error } = await sb.auth.signInWithPassword({ email: username + EMAIL_DOMAIN, password });
  if (error) return authError("اسم المستخدم أو كلمة السر غلط");
  await afterLogin();
});

document.getElementById("btn-logout").addEventListener("click", async () => {
  await sb.auth.signOut();
  me = null;
  showScreen("screen-auth");
});

async function afterLogin() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { showScreen("screen-auth"); return; }
  const { data: profile, error } = await sb.from("profiles").select("*").eq("id", user.id).single();
  if (error || !profile) { showScreen("screen-auth"); return; }
  me = profile;
  renderHome();
  showScreen("screen-home");
  subscribeInbox();
  checkPendingMatchOnLoad();
  checkActiveMatchOnLoad();
}

async function checkActiveMatchOnLoad() {
  const { data } = await sb.from("matches")
    .select("*")
    .or(`player1.eq.${me.id},player2.eq.${me.id}`)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (data) enterGame(data);
}

function renderHome() {
  document.getElementById("home-username").textContent = me.username;
  document.getElementById("home-avatar").textContent = me.username[0].toUpperCase();
  document.getElementById("home-points").textContent = me.points;
  document.getElementById("home-wins").textContent = me.wins;
  document.getElementById("home-record").textContent = `${me.wins}-${me.losses}-${me.draws}`;
}

sb.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_IN" && !me) afterLogin();
});
(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session) afterLogin();
})();

let friendSearchTimer = null;
document.getElementById("friend-search-input").addEventListener("input", (e) => {
  const term = e.target.value.trim();
  clearTimeout(friendSearchTimer);
  const box = document.getElementById("friend-search-results");
  if (!term) { box.innerHTML = ""; return; }
  friendSearchTimer = setTimeout(() => runFriendSearch(term), 300);
});

async function runFriendSearch(term) {
  const box = document.getElementById("friend-search-results");
  const { data: results } = await sb
    .from("profiles")
    .select("id, username")
    .ilike("username", `%${term}%`)
    .neq("id", me.id)
    .limit(8);

  box.innerHTML = "";
  if (!results || !results.length) {
    box.innerHTML = `<div class="list-empty">مفيش نتائج</div>`;
    return;
  }
  results.forEach(r => {
    const row = document.createElement("div");
    row.className = "row-card";
    row.innerHTML = `<span class="name">${r.username}</span>
      <button class="btn-small btn-primary" data-send-req="${r.id}">إرسال طلب</button>`;
    box.appendChild(row);
  });
  box.querySelectorAll("[data-send-req]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const { error } = await sb.from("friend_requests").insert({ from_id: me.id, to_id: btn.dataset.sendReq });
      if (error) return toast("الطلب موجود بالفعل أو حصل خطأ");
      btn.disabled = true;
      btn.textContent = "اتبعت";
      toast("تم إرسال طلب الصداقة");
    });
  });
}

async function loadFriendsScreen() {
  document.getElementById("friend-search-input").value = "";
  document.getElementById("friend-search-results").innerHTML = "";
  await loadIncomingRequests();
  await loadFriendsList();
}

async function loadIncomingRequests() {
  const box = document.getElementById("incoming-requests");
  const { data: reqs } = await sb
    .from("friend_requests")
    .select("id, from_id, profiles!friend_requests_from_id_fkey(username)")
    .eq("to_id", me.id)
    .eq("status", "pending");

  box.innerHTML = "";
  if (!reqs || reqs.length === 0) return;

  const title = document.createElement("h3");
  title.className = "list-title";
  title.textContent = "طلبات صداقة جديدة";
  box.appendChild(title);

  reqs.forEach(r => {
    const row = document.createElement("div");
    row.className = "row-card";
    row.innerHTML = `
      <span class="name">${r.profiles.username}</span>
      <div class="row-actions">
        <button class="btn-small btn-primary" data-accept="${r.id}" data-from="${r.from_id}">قبول</button>
        <button class="btn-small btn-ghost" data-reject="${r.id}">رفض</button>
      </div>`;
    box.appendChild(row);
  });

  box.querySelectorAll("[data-accept]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const reqId = btn.dataset.accept;
      const fromId = btn.dataset.from;
      await sb.from("friend_requests").update({ status: "accepted" }).eq("id", reqId);
      await sb.from("friends").insert([
        { user_id: me.id, friend_id: fromId },
        { user_id: fromId, friend_id: me.id },
      ]);
      toast("بقيتوا أصحاب!");
      loadFriendsScreen();
    });
  });
  box.querySelectorAll("[data-reject]").forEach(btn => {
    btn.addEventListener("click", async () => {
      await sb.from("friend_requests").update({ status: "rejected" }).eq("id", btn.dataset.reject);
      loadFriendsScreen();
    });
  });
}

async function loadFriendsList() {
  const box = document.getElementById("friends-list");
  const { data: rows, error } = await sb
    .from("friends")
    .select("friend_id, profiles!friends_friend_id_fkey(username, points)")
    .eq("user_id", me.id);

  if (error) { toast("حصل خطأ في تحميل الأصدقاء: " + error.message); }
  friendsCache = rows || [];
  box.innerHTML = "";
  if (!friendsCache.length) {
    box.innerHTML = `<div class="list-empty">لسه معندكش أصحاب — دور بالبحث فوق</div>`;
    return;
  }
  friendsCache.forEach(f => {
    const row = document.createElement("div");
    row.className = "row-card";
    row.innerHTML = `<span class="name">${f.profiles.username}</span><span class="sub">${f.profiles.points} نقطة</span>`;
    box.appendChild(row);
  });
}

document.getElementById("btn-play-ai").addEventListener("click", startAiMatch);

async function startAiMatch() {
  aiScheduledSignature = null;
  const state = buildInitialState();
  currentMatch = {
    id: "local-ai-" + Date.now(),
    player1: me.id, player2: AI_ID,
    status: "active", state, input_p1: {}, input_p2: {},
  };
  enterGame(currentMatch);
}

document.getElementById("btn-start-match").addEventListener("click", async () => {
  const { data, error } = await sb
    .from("friends")
    .select("friend_id, profiles!friends_friend_id_fkey(username)")
    .eq("user_id", me.id);

  if (error) {
    toast("حصل خطأ في جلب الأصدقاء: " + error.message);
    friendsCache = [];
  } else {
    friendsCache = data || [];
  }

  document.getElementById("opponent-search-input").value = "";
  renderOpponentList(friendsCache);
  showScreen("screen-pick-opponent");
});

function renderOpponentList(list) {
  const box = document.getElementById("opponent-list");
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = friendsCache.length
      ? `<div class="list-empty">مفيش نتائج مطابقة</div>`
      : `<div class="list-empty">ضيف أصدقاء الأول من صفحة الأصدقاء</div>`;
    return;
  }
  list.forEach(f => {
    const row = document.createElement("div");
    row.className = "row-card";
    row.innerHTML = `<span class="name">${f.profiles.username}</span>
      <button class="btn-small btn-primary" data-play="${f.friend_id}">ماتش</button>`;
    box.appendChild(row);
  });
  box.querySelectorAll("[data-play]").forEach(btn => {
    btn.addEventListener("click", () => sendMatchRequest(btn.dataset.play));
  });
}

document.getElementById("opponent-search-input").addEventListener("input", (e) => {
  const term = e.target.value.trim().toLowerCase();
  if (!term) { renderOpponentList(friendsCache); return; }
  const filtered = friendsCache.filter(f => f.profiles.username.toLowerCase().includes(term));
  renderOpponentList(filtered);
});

async function sendMatchRequest(opponentId) {
  const { data, error } = await sb.from("matches").insert({
    player1: me.id, player2: opponentId, status: "pending", state: {},
  }).select().single();
  if (error) return toast("حصل خطأ وأنت بتبعت طلب الماتش");
  currentMatch = data;
  document.getElementById("waiting-text").textContent = "في انتظار رد صاحبك...";
  showScreen("screen-waiting");
  subscribeToMatch(data.id);
}

document.getElementById("btn-cancel-wait").addEventListener("click", async () => {
  if (currentMatch) await sb.from("matches").update({ status: "declined" }).eq("id", currentMatch.id);
  cleanupMatchChannel();
  showScreen("screen-home");
});

async function checkPendingMatchOnLoad() {
  const { data } = await sb.from("matches")
    .select("*").eq("player2", me.id).eq("status", "pending")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (data) showPendingBanner(data);
}

function subscribeInbox() {
  if (myInboxChannel) sb.removeChannel(myInboxChannel);
  myInboxChannel = sb.channel("inbox-" + me.id)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "matches", filter: `player2=eq.${me.id}` },
      (payload) => showPendingBanner(payload.new))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "matches", filter: `player1=eq.${me.id}` },
      (payload) => {
        if (payload.new.status === "active" && document.getElementById("screen-waiting").classList.contains("active")) {
          currentMatch = payload.new;
          enterGame(payload.new);
        }
        if (payload.new.status === "declined" && document.getElementById("screen-waiting").classList.contains("active")) {
          toast("صاحبك رفض الماتش");
          showScreen("screen-home");
        }
      })
    .subscribe();
}

function showPendingBanner(match) {
  sb.from("profiles").select("username").eq("id", match.player1).single().then(({ data }) => {
    document.getElementById("pending-match-text").textContent = `${data?.username || "لاعب"} عايز يلعب معاك!`;
    document.getElementById("pending-match-banner").classList.remove("hidden");
    document.getElementById("btn-accept-match").onclick = () => acceptMatch(match);
    document.getElementById("btn-decline-match").onclick = () => declineMatch(match);
  });
}

async function acceptMatch(match) {
  const initialState = buildInitialState();
  const { data, error } = await sb.from("matches")
    .update({ status: "active", state: initialState, input_p1: {}, input_p2: {} })
    .eq("id", match.id).select().single();
  if (error) return toast("حصل خطأ");
  document.getElementById("pending-match-banner").classList.add("hidden");
  currentMatch = data;
  enterGame(data);
}
async function declineMatch(match) {
  await sb.from("matches").update({ status: "declined" }).eq("id", match.id);
  document.getElementById("pending-match-banner").classList.add("hidden");
}

function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }

function buildInitialState() {
  const players = shuffle(PLAYERS_DB).slice(0, PLAYERS_PER_ROUND1);
  const questions = shuffle(TRIVIA_QUESTIONS).slice(0, QUESTIONS_PER_ROUND2);
  const category = shuffle(AUCTION_CATEGORIES)[0];
  const pool = shuffle(PLAYERS_DB);
  return {
    round: 1,
    scoreP1: 0, scoreP2: 0,
    stepKey: "start",
    r1: { players, idx: 0, phase: "position" },
    r2: { questions, idx: 0 },
    r3: { category, submittedP1: false, submittedP2: false, listP1: [], listP2: [] },
    r4: {
      secretForP1: pool[0], secretForP2: pool[1],
      turn: "p1", history: [],
    },
    deadlineTs: 0,
    finished: false,
  };
}

function subscribeToMatch(matchId) {
  cleanupMatchChannel();
  myMatchChannel = sb.channel("match-" + matchId)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "matches", filter: `id=eq.${matchId}` },
      (payload) => onMatchRowChanged(payload.new))
    .subscribe();
}
function cleanupMatchChannel() {
  if (myMatchChannel) { sb.removeChannel(myMatchChannel); myMatchChannel = null; }
  if (hostTimerHandle) { clearInterval(hostTimerHandle); hostTimerHandle = null; }
  if (uiTickHandle) { clearInterval(uiTickHandle); uiTickHandle = null; }
}

function enterGame(match) {
  currentMatch = match;
  if (!isAiMatch(match)) subscribeToMatch(match.id);
  showScreen("screen-game");
  loadOpponentName(match);
  renderMatch(match);
  if (isHost(match)) startHostTimerLoop();
  startUiTick();
  if (isAiMatch(match)) maybeScheduleAiMove();
}

function loadOpponentName(match) {
  document.getElementById("game-my-name").textContent = me.username;
  if (isAiMatch(match)) {
    document.getElementById("game-opp-name").textContent = "الذكاء الاصطناعي 🤖";
    return;
  }
  sb.from("profiles").select("username").eq("id", otherPlayerId(match)).single().then(({ data }) => {
    document.getElementById("game-opp-name").textContent = data?.username || "الخصم";
  });
}

function onMatchRowChanged(row) {
  currentMatch = row;
  if (row.status === "finished") { showResult(row); return; }
  renderMatch(row);
  if (isHost(row)) hostMaybeResolve(row);
}

function startUiTick() {
  if (uiTickHandle) clearInterval(uiTickHandle);
  uiTickHandle = setInterval(() => {
    if (!currentMatch || !currentMatch.state) return;
    const s = currentMatch.state;
    if (!s.deadlineTs) return;
    const left = Math.max(0, Math.ceil((s.deadlineTs - Date.now()) / 1000));
    const total = roundTimeFor(s.round);
    document.getElementById("timer-num").textContent = left + "s";
    document.getElementById("timer-fill").style.width = Math.max(0, (left / total) * 100) + "%";
  }, 250);
}
function roundTimeFor(round) {
  return round === 1 ? ROUND_TIME.r1 : round === 2 ? ROUND_TIME.r2 : round === 3 ? ROUND_TIME.r3 : ROUND_TIME.r4;
}

function renderMatch(match) {
  const s = match.state;
  if (!s || !s.round) return;
  document.getElementById("game-my-score").textContent = myKey(match) === "p1" ? s.scoreP1 : s.scoreP2;
  document.getElementById("game-opp-score").textContent = myKey(match) === "p1" ? s.scoreP2 : s.scoreP1;
  document.getElementById("round-indicator").textContent = "جولة " + ["١", "٢", "٣", "٤"][s.round - 1];

  const stage = document.getElementById("game-stage");
  stage.innerHTML = "";
  if (s.round === 1) renderRound1(match, stage);
  else if (s.round === 2) renderRound2(match, stage);
  else if (s.round === 3) renderRound3(match, stage);
  else if (s.round === 4) renderRound4(match, stage);
}

async function sendMyInput(payload) {
  const col = myKey(currentMatch) === "p1" ? "input_p1" : "input_p2";
  if (isAiMatch(currentMatch)) {
    currentMatch = { ...currentMatch, [col]: payload };
    await hostMaybeResolveSafe(currentMatch);
    return;
  }
  await sb.from("matches").update({ [col]: payload }).eq("id", currentMatch.id);
}

function renderRound1(match, stage) {
  const s = match.state, r1 = s.r1;
  const player = r1.players[r1.idx];
  const phaseLabel = { position: "المركز", nationality: "الجنسية", club: "النادي" }[r1.phase];
  const clueValue = player[{ position: "position", nationality: "nation", club: "club" }[r1.phase]];

  const box = document.createElement("div");
  box.className = "player-card-box";
  box.innerHTML = `<div class="clue-label">${phaseLabel}</div><div class="clue-value">${clueValue}</div>`;
  stage.appendChild(box);

  stage.appendChild(makeGuessForm("اكتب اسم اللاعب", async (val) => {
    sendMyInput({ type: "guess", value: val, ts: Date.now(), step: r1.idx + "-" + r1.phase });
  }, () => sendMyInput({ type: "dontknow", ts: Date.now(), step: r1.idx + "-" + r1.phase })));

  stage.appendChild(opponentStatusLine(match, r1.idx + "-" + r1.phase));
}

function renderRound2(match, stage) {
  const s = match.state, r2 = s.r2;
  const q = r2.questions[r2.idx];
  const box = document.createElement("div");
  box.className = "q-box";
  box.textContent = q.q;
  stage.appendChild(box);

  stage.appendChild(makeGuessForm("اكتب إجابتك", async (val) => {
    sendMyInput({ type: "guess", value: val, ts: Date.now(), step: "q" + r2.idx });
  }, () => sendMyInput({ type: "dontknow", ts: Date.now(), step: "q" + r2.idx })));

  stage.appendChild(opponentStatusLine(match, "q" + r2.idx));
}

function renderRound3(match, stage) {
  const s = match.state, r3 = s.r3;
  const mine = myKey(match) === "p1" ? r3.submittedP1 : r3.submittedP2;

  const box = document.createElement("div");
  box.className = "q-box";
  box.textContent = r3.category.prompt;
  stage.appendChild(box);

  if (mine) {
    const st = document.createElement("div");
    st.className = "status-line";
    st.textContent = "بعتّ إجاباتك — مستني الخصم يخلّص أو ينتهي الوقت...";
    stage.appendChild(st);
    return;
  }

  const listEl = document.createElement("div");
  listEl.className = "auction-log";
  stage.appendChild(listEl);
  const myList = [];

  const row = document.createElement("div");
  row.className = "answer-row";
  row.innerHTML = `<input type="text" id="auction-input" placeholder="اكتب إجابة واضغط Enter"/>`;
  stage.appendChild(row);

  const doneBtn = document.createElement("button");
  doneBtn.className = "btn-primary";
  doneBtn.textContent = "خلصت — ابعت إجاباتي";
  stage.appendChild(doneBtn);

  const input = row.querySelector("#auction-input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) {
      myList.push(input.value.trim());
      const item = document.createElement("div");
      item.className = "auction-item mine";
      item.textContent = input.value.trim();
      listEl.appendChild(item);
      input.value = "";
    }
  });
  doneBtn.addEventListener("click", () => {
    sendMyInput({ type: "auction_submit", list: myList, ts: Date.now() });
    input.disabled = true; doneBtn.disabled = true;
  });
}

function renderRound4(match, stage) {
  const s = match.state, r4 = s.r4;
  const myTurn = r4.turn === myKey(match);

  const box = document.createElement("div");
  box.className = "q-box";
  box.textContent = myTurn ? "دورك — اسأل أي سؤال نعم/لا عن لاعبك السري" : "دور خصمك دلوقتي...";
  stage.appendChild(box);

  if (r4.history.length) {
    const log = document.createElement("div");
    log.className = "auction-log";
    r4.history.slice(-6).forEach(h => {
      const item = document.createElement("div");
      item.className = "auction-item " + (h.who === myKey(match) ? "mine" : "theirs");
      item.textContent = `${h.q} → ${h.a}`;
      log.appendChild(item);
    });
    stage.appendChild(log);
  }

  if (myTurn) {
    stage.appendChild(makeGuessForm("مثال: هل يلعب في الدوري الإنجليزي؟", (val) => {
      sendMyInput({ type: "r4_question", value: val, ts: Date.now() });
    }));
  }

  const guessLabel = document.createElement("div");
  guessLabel.className = "list-title";
  guessLabel.textContent = "أو خمّن الاسم مباشرة (متاح في أي وقت):";
  stage.appendChild(guessLabel);
  stage.appendChild(makeGuessForm("تخمين اسم اللاعب", (val) => {
    sendMyInput({ type: "r4_final_guess", value: val, ts: Date.now() });
  }));
}

function makeGuessForm(placeholder, onSubmit, onDontKnow) {
  const wrap = document.createElement("div");
  wrap.style.display = "flex"; wrap.style.flexDirection = "column"; wrap.style.gap = "10px";
  const row = document.createElement("div");
  row.className = "answer-row";
  row.innerHTML = `<input type="text" placeholder="${placeholder}"/>`;
  const input = row.querySelector("input");
  const send = document.createElement("button");
  send.className = "btn-primary"; send.style.marginTop = "0"; send.textContent = "إرسال";
  row.appendChild(send);
  wrap.appendChild(row);

  const submit = () => { if (input.value.trim()) { onSubmit(input.value.trim()); input.disabled = true; send.disabled = true; if (dk) dk.disabled = true; } };
  send.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

  let dk;
  if (onDontKnow) {
    const actions = document.createElement("div");
    actions.className = "game-actions";
    dk = document.createElement("button");
    dk.className = "btn-ghost"; dk.textContent = "لا أعرف";
    dk.addEventListener("click", () => { onDontKnow(); input.disabled = true; send.disabled = true; dk.disabled = true; });
    actions.appendChild(dk);
    wrap.appendChild(actions);
  }
  return wrap;
}
function statusLine() {
  const el = document.createElement("div");
  el.className = "status-line";
  el.textContent = "";
  return el;
}
function opponentStatusLine(match, stepId) {
  const el = document.createElement("div");
  el.className = "status-line";
  const oppInput = oppKey(match) === "p1" ? match.input_p1 : match.input_p2;
  if (oppInput && oppInput.step === stepId) {
    el.textContent = isAiMatch(match) ? "🤖 الذكاء الاصطناعي جاوب بالفعل" : "الخصم جاوب بالفعل";
  }
  return el;
}

function startHostTimerLoop() {
  if (hostTimerHandle) clearInterval(hostTimerHandle);
  ensureDeadline();
  hostTimerHandle = setInterval(() => {
    if (!currentMatch || !currentMatch.state) return;
    const s = currentMatch.state;
    if (s.finished) return;
    if (s.deadlineTs && Date.now() > s.deadlineTs) {
      hostAdvanceOnTimeout();
    }
  }, 1000);
}

async function ensureDeadline() {
  const s = currentMatch.state;
  if (!s.deadlineTs) {
    s.deadlineTs = Date.now() + roundTimeFor(s.round) * 1000;
    if (isAiMatch(currentMatch)) { currentMatch = { ...currentMatch, state: s }; return; }
    await sb.from("matches").update({ state: s }).eq("id", currentMatch.id);
  }
}

function hostMaybeResolve(row) { return hostMaybeResolveSafe(row); }

async function commitState(newState, clearInputs = true) {
  const payload = { state: newState };
  if (clearInputs) { payload.input_p1 = {}; payload.input_p2 = {}; }
  currentMatch = { ...currentMatch, ...payload };
  if (isAiMatch(currentMatch)) { renderMatch(currentMatch); maybeScheduleAiMove(); return; }
  await sb.from("matches").update(payload).eq("id", currentMatch.id);
}

function normalize(str) { return (str || "").trim().toLowerCase().replace(/[إأآا]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه"); }
function fuzzyMatch(guess, target) {
  const g = normalize(guess), t = normalize(target);
  return g === t || t.includes(g) || g.includes(t);
}

async function aiJudgeAuctionBatch(prompt, items) {
  if (!items.length) return {};
  try {
    const { data, error } = await sb.functions.invoke("judge", { body: { mode: "auction_batch", prompt, items } });
    if (error) throw error;
    return data.results || {};
  } catch (e) {
    const fallback = {};
    items.forEach(it => fallback[it.id] = false);
    return fallback;
  }
}
async function aiJudgeR4Question(player, question) {
  try {
    const { data, error } = await sb.functions.invoke("judge", { body: { mode: "r4_question", player, question } });
    if (error) throw error;
    return data.answer === "نعم" ? "نعم" : "لا";
  } catch (e) { return "لا"; }
}
async function aiRound1Guess(phase, clueValue) {
  try {
    const { data, error } = await sb.functions.invoke("judge", { body: { mode: "ai_round1_guess", phase, clueValue } });
    if (error) throw error;
    return data.guess || null;
  } catch (e) { return null; }
}
async function aiRound2Answer(question) {
  try {
    const { data, error } = await sb.functions.invoke("judge", { body: { mode: "ai_round2_answer", question } });
    if (error) throw error;
    return data.answer || null;
  } catch (e) { return null; }
}
async function aiRound3List(prompt) {
  try {
    const { data, error } = await sb.functions.invoke("judge", { body: { mode: "ai_round3_list", prompt } });
    if (error) throw error;
    return data.list || [];
  } catch (e) { return []; }
}
async function aiRound4Turn(history) {
  try {
    const { data, error } = await sb.functions.invoke("judge", { body: { mode: "ai_round4_turn", history } });
    if (error) throw error;
    return data;
  } catch (e) { return { type: "question", value: "هل هو مهاجم؟" }; }
}

async function goToNextRound(s) {
  s.round += 1;
  s.deadlineTs = Date.now() + roundTimeFor(s.round) * 1000;
  if (s.round > 4) return finishMatch(s);
  await commitState(s);
}

async function finishMatch(s) {
  s.finished = true;
  const winner = s.scoreP1 === s.scoreP2 ? null : (s.scoreP1 > s.scoreP2 ? currentMatch.player1 : currentMatch.player2);
  if (isAiMatch(currentMatch)) {
    currentMatch = { ...currentMatch, state: s, status: "finished", winner, input_p1: {}, input_p2: {} };
    await applyResultsToProfiles(currentMatch, s);
    showResult(currentMatch);
    return;
  }
  await sb.from("matches").update({ state: s, status: "finished", winner, input_p1: {}, input_p2: {} }).eq("id", currentMatch.id);
  await applyResultsToProfiles(currentMatch, s);
}

async function applyResultsToProfiles(match, s) {
  const p1Delta = s.scoreP1 === s.scoreP2 ? 1 : (s.scoreP1 > s.scoreP2 ? 3 : -3);
  const p2Delta = s.scoreP1 === s.scoreP2 ? 1 : (s.scoreP2 > s.scoreP1 ? 3 : -3);
  await bumpProfile(match.player1, p1Delta, s.scoreP1 === s.scoreP2 ? "draw" : (s.scoreP1 > s.scoreP2 ? "win" : "loss"));
  if (match.player2 !== AI_ID) {
    await bumpProfile(match.player2, p2Delta, s.scoreP1 === s.scoreP2 ? "draw" : (s.scoreP2 > s.scoreP1 ? "win" : "loss"));
  }
}
async function bumpProfile(userId, pointsDelta, kind) {
  const { data: p } = await sb.from("profiles").select("*").eq("id", userId).single();
  if (!p) return;
  const patch = { points: p.points + pointsDelta };
  if (kind === "win") patch.wins = p.wins + 1;
  if (kind === "loss") patch.losses = p.losses + 1;
  if (kind === "draw") patch.draws = p.draws + 1;
  await sb.from("profiles").update(patch).eq("id", userId);
}

async function hostResolveRound1(s, ip1, ip2) {
  const r1 = s.r1;
  const stepId = r1.idx + "-" + r1.phase;
  const a1 = ip1.step === stepId ? ip1 : null;
  const a2 = ip2.step === stepId ? ip2 : null;
  const bothActed = a1 && a2;
  const timedOut = Date.now() > s.deadlineTs;
  if (!bothActed && !timedOut) return;

  const player = r1.players[r1.idx];
  const points = { position: 5, nationality: 3, club: 2 }[r1.phase];
  const correct1 = a1 && a1.type === "guess" && fuzzyMatch(a1.value, player.name);
  const correct2 = a2 && a2.type === "guess" && fuzzyMatch(a2.value, player.name);

  if (correct1 && !correct2) { s.scoreP1 += points; advanceRound1Player(s); }
  else if (correct2 && !correct1) { s.scoreP2 += points; advanceRound1Player(s); }
  else if (correct1 && correct2) {
    if (a1.ts <= a2.ts) s.scoreP1 += points; else s.scoreP2 += points;
    advanceRound1Player(s);
  } else {
    advanceRound1Phase(s);
  }
  if (s._advance) return;
  s.deadlineTs = Date.now() + roundTimeFor(1) * 1000;
  await commitState(s);
}
function advanceRound1Phase(s) {
  const r1 = s.r1;
  if (r1.phase === "position") r1.phase = "nationality";
  else if (r1.phase === "nationality") r1.phase = "club";
  else advanceRound1Player(s);
}
function advanceRound1Player(s) {
  const r1 = s.r1;
  r1.idx += 1;
  r1.phase = "position";
  if (r1.idx >= r1.players.length) s._advance = true;
}

async function hostResolveRound2(s, ip1, ip2) {
  const r2 = s.r2;
  const stepId = "q" + r2.idx;
  const a1 = ip1.step === stepId ? ip1 : null;
  const a2 = ip2.step === stepId ? ip2 : null;
  const bothActed = a1 && a2;
  const timedOut = Date.now() > s.deadlineTs;
  if (!bothActed && !timedOut) return;

  const q = r2.questions[r2.idx];
  const correct1 = a1 && a1.type === "guess" && fuzzyMatch(a1.value, q.a);
  const correct2 = a2 && a2.type === "guess" && fuzzyMatch(a2.value, q.a);

  if (correct1 && !correct2) s.scoreP1 += 3;
  else if (correct2 && !correct1) s.scoreP2 += 3;
  else if (correct1 && correct2) { if (a1.ts <= a2.ts) s.scoreP1 += 3; else s.scoreP2 += 3; }

  r2.idx += 1;
  s.deadlineTs = Date.now() + roundTimeFor(2) * 1000;
  if (r2.idx >= r2.questions.length) { await goToNextRound(s); return; }
  await commitState(s);
}

async function hostResolveRound3(s, ip1, ip2) {
  const r3 = s.r3;
  if (ip1.type === "auction_submit" && !r3.submittedP1) { r3.submittedP1 = true; r3.listP1 = ip1.list || []; }
  if (ip2.type === "auction_submit" && !r3.submittedP2) { r3.submittedP2 = true; r3.listP2 = ip2.list || []; }

  const timedOut = Date.now() > s.deadlineTs;
  const bothDone = r3.submittedP1 && r3.submittedP2;
  if (!bothDone && !timedOut) { await commitState(s, false); return; }

  const key = r3.category.answers;

  function prefilter(list) {
    const seen = new Set(); const known = { valid: 0, wrong: 0 }; const needsAI = [];
    (list || []).forEach((item, i) => {
      const n = normalize(item);
      if (!n || seen.has(n)) return;
      seen.add(n);
      if (key) {
        if (key.some(k => fuzzyMatch(item, k))) known.valid++; else known.wrong++;
      } else {
        needsAI.push({ id: "x" + i, text: item });
      }
    });
    return { known, needsAI };
  }
  const f1 = prefilter(r3.listP1), f2 = prefilter(r3.listP2);

  let g1 = { ...f1.known }, g2 = { ...f2.known };
  if (!key && (f1.needsAI.length || f2.needsAI.length)) {
    const combined = [
      ...f1.needsAI.map(it => ({ id: "p1-" + it.id, text: it.text })),
      ...f2.needsAI.map(it => ({ id: "p2-" + it.id, text: it.text })),
    ];
    const results = await aiJudgeAuctionBatch(r3.category.prompt, combined);
    f1.needsAI.forEach(it => { if (results["p1-" + it.id]) g1.valid++; else g1.wrong++; });
    f2.needsAI.forEach(it => { if (results["p2-" + it.id]) g2.valid++; else g2.wrong++; });
  }

  if (g1.wrong === 0 && g2.wrong === 0) {
    if (g1.valid > g2.valid) s.scoreP1 += 3;
    else if (g2.valid > g1.valid) s.scoreP2 += 3;
  } else {
    if (g1.wrong < g2.wrong) s.scoreP1 += 2;
    else if (g2.wrong < g1.wrong) s.scoreP2 += 2;
    else if (g1.valid > g2.valid) s.scoreP1 += 2;
    else if (g2.valid > g1.valid) s.scoreP2 += 2;
  }
  await goToNextRound(s);
}

async function hostResolveRound4(s, ip1, ip2) {
  const r4 = s.r4;
  const actingKey = r4.turn;
  const act = actingKey === "p1" ? ip1 : ip2;
  const timedOut = Date.now() > s.deadlineTs;

  for (const [k, inp] of [["p1", ip1], ["p2", ip2]]) {
    if (inp.type === "r4_final_guess") {
      const target = k === "p1" ? r4.secretForP1 : r4.secretForP2;
      if (fuzzyMatch(inp.value, target.name)) {
        if (k === "p1") s.scoreP1 += 5; else s.scoreP2 += 5;
        return goToNextRound(s);
      }
    }
  }

  if (!act || (!timedOut && act.type !== "r4_question")) return;

  if (act.type === "r4_question") {
    const target = actingKey === "p1" ? r4.secretForP1 : r4.secretForP2;
    const answer = await aiJudgeR4Question(target, act.value);
    r4.history.push({ who: actingKey, q: act.value, a: answer });
  }
  r4.turn = r4.turn === "p1" ? "p2" : "p1";
  s.deadlineTs = Date.now() + roundTimeFor(4) * 1000;
  await commitState(s);
}

let hostResolving = false;
async function hostMaybeResolveSafe(row) {
  if (hostResolving) return;
  hostResolving = true;
  try {
    const s = JSON.parse(JSON.stringify(row.state));
    const ip1 = row.input_p1 || {}, ip2 = row.input_p2 || {};
    if (s.round === 1) { await hostResolveRound1(s, ip1, ip2); if (s._advance) { delete s._advance; await goToNextRound(s); } }
    else if (s.round === 2) await hostResolveRound2(s, ip1, ip2);
    else if (s.round === 3) await hostResolveRound3(s, ip1, ip2);
    else if (s.round === 4) await hostResolveRound4(s, ip1, ip2);
  } finally {
    hostResolving = false;
  }
}

async function hostAdvanceOnTimeout() {
  if (isAiMatch(currentMatch)) { await hostMaybeResolveSafe(currentMatch); return; }
  const { data: row } = await sb.from("matches").select("*").eq("id", currentMatch.id).single();
  if (row) await hostMaybeResolveSafe(row);
}

function aiStepSignature(s) {
  if (s.round === 1) return `1-${s.r1.idx}-${s.r1.phase}`;
  if (s.round === 2) return `2-${s.r2.idx}`;
  if (s.round === 3) return `3`;
  if (s.round === 4) return `4-${s.r4.turn}-${s.r4.history.length}`;
  return "x";
}

function maybeScheduleAiMove() {
  if (!isAiMatch(currentMatch)) return;
  const s = currentMatch.state;
  if (!s || s.finished) return;
  if (s.round === 4 && s.r4.turn !== "p2") return;
  if (s.round === 3 && currentMatch.input_p2?.type === "auction_submit") return;

  const sig = aiStepSignature(s);
  if (aiScheduledSignature === sig) return;
  aiScheduledSignature = sig;

  const roundMs = roundTimeFor(s.round) * 1000;
  const delay = 1500 + Math.random() * Math.max(1500, roundMs * 0.6);
  setTimeout(async () => {
    if (aiScheduledSignature !== sig) return;
    try { await performAiMove(sig); } catch (e) {}
  }, delay);
}

async function performAiMove(expectedSig) {
  const s = currentMatch.state;
  if (aiStepSignature(s) !== expectedSig) return;

  if (s.round === 1) {
    const r1 = s.r1, player = r1.players[r1.idx];
    const field = { position: "position", nationality: "nation", club: "club" }[r1.phase];
    const guess = await aiRound1Guess(r1.phase, player[field]);
    await sendAiInput(guess
      ? { type: "guess", value: guess, ts: Date.now(), step: r1.idx + "-" + r1.phase }
      : { type: "dontknow", ts: Date.now(), step: r1.idx + "-" + r1.phase });

  } else if (s.round === 2) {
    const q = s.r2.questions[s.r2.idx];
    const guess = await aiRound2Answer(q.q);
    await sendAiInput(guess
      ? { type: "guess", value: guess, ts: Date.now(), step: "q" + s.r2.idx }
      : { type: "dontknow", ts: Date.now(), step: "q" + s.r2.idx });

  } else if (s.round === 3) {
    const list = await aiRound3List(s.r3.category.prompt);
    await sendAiInput({ type: "auction_submit", list, ts: Date.now() });

  } else if (s.round === 4 && s.r4.turn === "p2") {
    const ownHistory = s.r4.history.filter(h => h.who === "p2");
    const move = await aiRound4Turn(ownHistory);
    if (move.type === "guess") await sendAiInput({ type: "r4_final_guess", value: move.value, ts: Date.now() });
    else await sendAiInput({ type: "r4_question", value: move.value, ts: Date.now() });
  }
}

async function sendAiInput(payload) {
  currentMatch = { ...currentMatch, input_p2: payload };
  aiScheduledSignature = null;
  renderMatch(currentMatch);
  await hostMaybeResolveSafe(currentMatch);
}

function showResult(match) {
  cleanupMatchChannel();
  const s = match.state;
  const myScore = myKey(match) === "p1" ? s.scoreP1 : s.scoreP2;
  const oppScore = myKey(match) === "p1" ? s.scoreP2 : s.scoreP1;
  document.getElementById("result-score").textContent = `${myScore} - ${oppScore}`;
  const title = document.getElementById("result-title");
  const emoji = document.getElementById("result-emoji");
  const pointsEl = document.getElementById("result-points");
  if (myScore === oppScore) { title.textContent = "تعادل"; emoji.textContent = "🤝"; pointsEl.textContent = "+1 نقطة"; }
  else if (myScore > oppScore) { title.textContent = "فوز!"; emoji.textContent = "🏆"; pointsEl.textContent = "+3 نقاط"; }
  else { title.textContent = "خسارة"; emoji.textContent = "😔"; pointsEl.textContent = "-3 نقاط"; }
  showScreen("screen-result");
}
document.getElementById("btn-back-home").addEventListener("click", async () => {
  const { data: profile } = await sb.from("profiles").select("*").eq("id", me.id).single();
  if (profile) me = profile;
  renderHome();
  showScreen("screen-home");
});


