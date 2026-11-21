import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, home, readTextFile, checking, exec, window as appWindow } from "herdr";
import * as fs from "fs/promises";

const POLL_MS = 5 * 60 * 1000;
const STALE_MS = 60 * 60 * 1000;
const WEEK = 604800;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function localClock(ms) {
  const d = new Date(Math.round(ms / 60000) * 60000);
  const h = d.getHours();
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${DAYS[d.getDay()]} ${h % 12 || 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
}

function span(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function ageText(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  return `${span(ms)} ago`;
}

function parseIso(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?(Z|([+-])(\d\d):?(\d\d))?$/);
  if (!m) return null;
  const frac = m[7] ? Number("0." + m[7]) * 1000 : 0;
  let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + frac;
  if (m[9]) ms -= (m[9] === "+" ? 1 : -1) * ((+m[10]) * 60 + (+m[11])) * 60000;
  return ms;
}

function toMs(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v < 1e11 ? v * 1000 : v;
  return parseIso(v);
}

function windowName(seconds) {
  if (!seconds) return "Window";
  if (seconds === 18000) return "5-hour";
  if (seconds === 604800) return "Weekly";
  if (seconds % 86400 === 0) return `${seconds / 86400}-day`;
  return `${Math.round(seconds / 3600)}-hour`;
}

function thousands(n) {
  const [i, f] = String(n).split(".");
  const s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return f && Number(f) !== 0 ? `${s}.${f.slice(0, 2)}` : s;
}

function errText(e) {
  return String((e && e.message) || e).slice(0, 160);
}

class Expired extends Error {}
class NoLogin extends Error {}

function isMac() {
  const w = appWindow();
  if (w && w.platform) return w.platform === "macos";
  return home().startsWith("/Users/");
}

function paceOf(r, now) {
  if (!r.secs || r.reset === null || r.reset === undefined || r.reset <= now) return null;
  const len = r.secs * 1000;
  const elapsed = Math.max(0, Math.min(1, (now - (r.reset - len)) / len));
  const at = Math.round(elapsed * 1000) / 10;
  const gap = Math.round(at - r.pct);
  const left = Math.max(0, 100 - r.pct);
  const msLeft = r.reset - now;
  const target = msLeft >= 86400000
    ? `use ${Math.round(left / (msLeft / 86400000))}% a day to finish`
    : `use ${Math.round(left)}% in ${span(msLeft)} to finish`;
  if (gap > 2) return { at, behind: true, text: `${gap}% behind pace · ${target}` };
  if (gap < -2) return { at, behind: false, text: `${-gap}% ahead of pace · ${target}` };
  return { at, behind: false, text: `on pace · ${target}` };
}

function problem(reason, app, what) {
  if (reason instanceof NoLogin) return { text: reason.message, soft: true };
  if (reason instanceof Expired) return { text: `${reason.message} Open ${app} to renew it.`, soft: false };
  return { text: `Can't read ${what} usage: ${errText(reason)}`, soft: false };
}

function claudePlan(o) {
  const m = String(o.rateLimitTier || "").match(/max_(\d+x)/);
  if (m) return `Max ${m[1]}`;
  const s = o.subscriptionType || "";
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

async function claudeCredentials() {
  const text = await readTextFile(home() + "/.claude/.credentials.json");
  if (text !== null) return JSON.parse(text);
  if (isMac()) {
    let r = null;
    try {
      r = await exec("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeout: 60000 });
    } catch {
      r = null;
    }
    if (r && r.code === 0 && r.stdout.trim()) return JSON.parse(r.stdout.trim());
  }
  throw new NoLogin("Not signed in to Claude Code. Run claude and log in.");
}

async function fetchClaude() {
  const cred = await claudeCredentials();
  const o = cred.claudeAiOauth;
  if (!o || !o.accessToken) throw new NoLogin("Claude Code isn't signed in with a Claude plan.");
  if (o.expiresAt && o.expiresAt < Date.now()) throw new Expired("Claude token expired.");
  const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { Authorization: `Bearer ${o.accessToken}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
  });
  if (r.status === 401 || r.status === 403) throw new Expired("Claude token rejected.");
  if (!r.ok) throw new Error(`Claude usage API returned ${r.status}.`);
  const j = await r.json();
  const rows = [];
  if (j.seven_day) rows.push({ name: "Weekly", pct: j.seven_day.utilization, reset: toMs(j.seven_day.resets_at), secs: WEEK });
  const scoped = (j.limits || []).filter((l) => l.kind === "weekly_scoped");
  for (const l of scoped) {
    const model = l.scope && l.scope.model && (l.scope.model.display_name || l.scope.model.id);
    rows.push({ name: `Weekly ${model || "scoped"}`, pct: l.percent, reset: toMs(l.resets_at), secs: WEEK });
  }
  if (!scoped.length) {
    for (const [k, label] of [["seven_day_opus", "Opus"], ["seven_day_sonnet", "Sonnet"]]) {
      const w = j[k];
      if (w && w.utilization !== null && w.utilization !== undefined) rows.push({ name: `Weekly ${label}`, pct: w.utilization, reset: toMs(w.resets_at), secs: WEEK });
    }
  }
  return { plan: claudePlan(o), rows, at: Date.now(), source: "api" };
}

function codexRows(windows, credits) {
  const rows = windows.filter((w) => w && w.pct !== null && w.pct !== undefined && w.secs !== 18000)
    .sort((a, b) => (a.secs || 0) - (b.secs || 0))
    .map((w) => ({ name: windowName(w.secs), pct: w.pct, reset: toMs(w.reset), secs: w.secs }));
  if (credits) {
    const bal = credits.unlimited ? "Unlimited" : credits.has_credits && credits.balance !== null && credits.balance !== undefined
      ? thousands(Number(credits.balance)) : "None";
    rows.push({ name: "Credits", value: bal });
  }
  return rows;
}

async function fetchCodexApi(auth) {
  const t = auth.tokens || {};
  if (!t.access_token) throw new NoLogin("Codex isn't signed in with ChatGPT.");
  const headers = { Authorization: `Bearer ${t.access_token}`, Accept: "application/json" };
  if (t.account_id) headers["ChatGPT-Account-Id"] = t.account_id;
  const r = await fetch("https://chatgpt.com/backend-api/wham/usage", { headers });
  if (r.status === 401 || r.status === 403) throw new Expired("Codex token rejected.");
  if (!r.ok) throw new Error(`Codex usage API returned ${r.status}.`);
  const j = await r.json();
  const rl = j.rate_limit || {};
  const win = (w) => w && { pct: w.used_percent, secs: w.limit_window_seconds, reset: w.reset_at };
  const plan = j.plan_type ? j.plan_type[0].toUpperCase() + j.plan_type.slice(1) : "";
  return { plan, rows: codexRows([win(rl.primary_window), win(rl.secondary_window)], j.credits), at: Date.now(), source: "api" };
}

async function listDesc(dir, re) {
  try {
    return (await fs.readdir(dir)).filter((n) => re.test(n)).sort().reverse();
  } catch {
    return [];
  }
}

async function fetchCodexLog() {
  const root = home() + "/.codex/sessions";
  const files = [];
  for (const y of await listDesc(root, /^\d{4}$/)) {
    for (const m of await listDesc(`${root}/${y}`, /^\d\d$/)) {
      for (const d of await listDesc(`${root}/${y}/${m}`, /^\d\d$/)) {
        for (const f of await listDesc(`${root}/${y}/${m}/${d}`, /^rollout-.*\.jsonl$/)) files.push(`${root}/${y}/${m}/${d}/${f}`);
        if (files.length >= 8) break;
      }
      if (files.length >= 8) break;
    }
    if (files.length >= 8) break;
  }
  let best = null;
  for (const f of files.slice(0, 8)) {
    let text;
    try { text = await fs.readFile(f, "utf8"); } catch { continue; }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let o;
      try { o = JSON.parse(lines[i]); } catch { continue; }
      const rl = o.payload && o.payload.rate_limits;
      if (!rl) continue;
      const at = parseIso(o.timestamp);
      if (at && (!best || at > best.at)) best = { at, rl };
      break;
    }
  }
  if (!best) throw new Error("No rate limits in the Codex logs.");
  const rl = best.rl;
  const win = (w) => w && { pct: w.used_percent, secs: (w.window_minutes || 0) * 60, reset: w.resets_at };
  const plan = rl.plan_type ? rl.plan_type[0].toUpperCase() + rl.plan_type.slice(1) : "";
  return { plan, rows: codexRows([win(rl.primary), win(rl.secondary)], rl.credits), at: best.at, source: "log" };
}

async function fetchCodex() {
  let apiError;
  try {
    const text = await readTextFile(home() + "/.codex/auth.json");
    if (text === null) throw new NoLogin("Not signed in to Codex. Run codex and log in.");
    return { data: await fetchCodexApi(JSON.parse(text)), note: null };
  } catch (e) {
    apiError = e;
  }
  let data;
  try {
    data = await fetchCodexLog();
  } catch (e) {
    throw apiError instanceof NoLogin || apiError instanceof Expired ? apiError : e;
  }
  const note = apiError instanceof NoLogin ? apiError.message
    : apiError instanceof Expired ? `${apiError.message} Open Codex to renew it.` : `API failed: ${errText(apiError)}`;
  return { data, note };
}

export default class PlanUsage extends View {
  init(_props, cx) {
    this.claude = null;
    this.codex = null;
    this.claudeError = null;
    this.codexError = null;
    this.codexNote = null;
    this.busy = false;
    if (checking()) return;
    cx.timer.every(POLL_MS, (cx) => this.refresh(cx));
    cx.timer.every(60000, (cx) => cx.notify());
    this.refresh(cx);
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const [c, x] = await Promise.allSettled([fetchClaude(), fetchCodex()]);
      if (c.status === "fulfilled") {
        this.claude = c.value;
        this.claudeError = null;
      } else {
        this.claudeError = problem(c.reason, "Claude Code", "Claude");
      }
      if (x.status === "fulfilled") {
        this.codex = x.value.data;
        this.codexNote = x.value.note;
        this.codexError = null;
      } else {
        this.codexError = problem(x.reason, "Codex", "Codex");
      }
      this.busy = false;
      cx.notify();
    });
  }

  bar(t, pct, grey, pace) {
    const p = Math.max(0, Math.min(100, pct));
    const color = grey ? t.dim : p >= 90 ? t.ansi1 : p >= 75 ? t.ansi3 : t.accent;
    return div().relative().h(4).w_full().rounded(2).bg(t.raised)
      .child(div().h(4).rounded(2).bg(color).w(`${p}%`))
      .when(!!pace, (el) => el.child(div().absolute().top(-2).left(`${pace.at}%`).w(2).h(8).rounded(1)
        .bg(grey ? t.dim : t.foreground)));
  }

  row(t, key, r, at, now) {
    const grey = now - at > STALE_MS;
    const fg = grey ? t.dim : t.foreground;
    const sub = grey ? t.dim : t.muted;
    const asOf = `as of ${ageText(now - at)}`;
    if (r.value !== undefined) {
      return h_flex().id(key).justify_between().items_center().gap(6).py(2)
        .child(div().text_size(11.5).text_color(fg).child(r.name))
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(11.5).text_color(fg).child(r.value))
          .child(div().text_size(10.5).text_color(t.dim).child(asOf)));
    }
    const pct = Math.round(r.pct * 10) / 10;
    const pace = paceOf(r, now);
    const reset = r.reset === null || r.reset === undefined ? "no reset time"
      : r.reset <= now ? `reset ${localClock(r.reset)}` : `resets in ${span(r.reset - now)} · ${localClock(r.reset)}`;
    return v_flex().id(key).gap(3).py(3)
      .child(h_flex().justify_between().items_center().gap(6)
        .child(div().text_size(11.5).text_color(fg).child(r.name))
        .child(div().text_size(11.5).font_semibold().text_color(fg).child(`${pct}% used`)))
      .child(this.bar(t, pct, grey, pace))
      .child(h_flex().justify_between().gap(6)
        .child(div().text_size(10.5).text_color(sub).child(reset))
        .child(div().text_size(10.5).text_color(t.dim).child(asOf)))
      .when(!!pace, (el) => el.child(div().text_size(10.5)
        .text_color(grey ? t.dim : pace.behind ? t.ansi3 : t.ansi2).child(pace.text)));
  }

  section(t, id, title, data, error, note, now) {
    const head = data && data.plan ? `${title} (${data.plan})` : title;
    return v_flex().id(id).gap(2)
      .child(h_flex().justify_between().items_center()
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child(head))
        .when(!!data && data.source === "log", (el) => el.child(div().text_size(10.5).text_color(t.ansi3).child("from log"))))
      .when(!!error, (el) => el.child(div().text_size(10.5).text_color(error.soft ? t.muted : t.ansi1).child(error.text)))
      .when(!!note, (el) => el.child(div().text_size(10.5).text_color(t.ansi3).child(note)))
      .when(!data && !error, (el) => el.child(div().text_size(11).text_color(t.dim).child("Loading.")))
      .children(data ? data.rows.map((r, i) => this.row(t, `${id}-${i}`, r, data.at, now)) : []);
  }

  render(cx) {
    const t = theme();
    const now = Date.now();
    return v_flex().id("root").size_full().bg(t.chrome).border_l(1).border_t(1).border_color(t.border).p(10).gap(8)
      .child(h_flex().justify_between().items_center()
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Plan usage"))
        .child(div().id("refresh").text_size(11).text_color(t.accent).hover((st) => st.text_color(t.foreground))
          .on_click((_e, cx) => this.refresh(cx)).child(this.busy ? "Refreshing" : "Refresh")))
      .child(v_flex().id("list").flex_1().gap(10).overflow_y_scrollbar()
        .child(this.section(t, "claude", "Claude Code", this.claude, this.claudeError, null, now))
        .child(this.section(t, "codex", "Codex", this.codex, this.codexError, this.codexNote, now)));
  }
}
