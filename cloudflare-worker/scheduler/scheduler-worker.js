/*
  Leo -- on-time workflow starter (DEC-20261017-05).

  WHY
  GitHub's own schedule starts Leo's workflows 3 to 6 hours late. The runs
  themselves take 15-30 seconds; the delay is GitHub queueing the start. On
  Oct 11 the 7:00am NFL gather started at 12:34pm, and the 9:30am London
  game (PHI @ JAX) got no pre-game read at all.

  WHAT
  One Cloudflare Cron Trigger fires every 15 minutes. The worker checks the
  table below against the current Eastern time (Intl handles daylight
  saving, so the Nov 1 change needs no edit) and, when a slot matches, asks
  GitHub to start that workflow now through the workflow_dispatch API. The
  workflows already accept a manual run with a date; this is the same button
  pressed on time.

  SETUP (Lynold; Cloudflare dashboard or wrangler, from this folder)
    1. Create a fine-grained GitHub token: repository flychico/lydiaslab only,
       permission "Actions: Read and write". Nothing else.
    2. npx wrangler deploy -c wrangler.toml
    3. npx wrangler secret put GITHUB_TOKEN -c wrangler.toml   (paste the token)
    4. Watch one slot fire (Actions tab shows "workflow_dispatch" runs on time).
    5. Then remove the `schedule:` blocks from the five workflows listed in
       SLOTS, so each run happens once and odds credits are not spent twice.
       Until step 5, a gather can run twice; that only costs credits.
  GET https://<worker-url>/ shows what would fire in the current slot.
*/
const OWNER = "flychico", REPO = "lydiaslab";

// [days (0=Sun..6=Sat, "*" = every day), "HH:MM" Eastern, workflow file, send today's date?]
const SLOTS = [
  // NFL gather (spends odds credits) and publish (free), as in DEC-20261003-04
  ["*",   "09:00", "nfl-prepare-slate.yml", true],
  ["*",   "09:15", "nfl-publish-picks.yml", true],
  [[4,1], "13:00", "nfl-prepare-slate.yml", true],   // Thursday and Monday nights
  [[4,1], "13:15", "nfl-publish-picks.yml", true],
  [[0],   "07:00", "nfl-prepare-slate.yml", true],   // Sunday waves; covers 9:30am London kicks
  [[0],   "07:15", "nfl-publish-picks.yml", true],
  [[0],   "10:00", "nfl-prepare-slate.yml", true],
  [[0],   "10:15", "nfl-publish-picks.yml", true],
  [[0],   "12:30", "nfl-prepare-slate.yml", true],   // last capture before the 1pm kicks
  [[0],   "14:00", "nfl-prepare-slate.yml", true],
  [[0],   "14:15", "nfl-publish-picks.yml", true],
  [[0],   "18:00", "nfl-prepare-slate.yml", true],
  [[0],   "18:15", "nfl-publish-picks.yml", true],
  // NFL grading (free). Blank date = yesterday and today.
  ["*",   "06:00", "nfl-grade-results.yml", false],
  [[1,2], "11:00", "nfl-grade-results.yml", false],
  [[1],   "00:00", "nfl-grade-results.yml", false]
];

function easternNow(d = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short"
  }).formatToParts(d).map(p => [p.type, p.value]));
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  // Round down to the 15-minute slot the cron fired in (a trigger can land a few seconds late).
  const mins = Math.floor(Number(parts.minute) / 15) * 15;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, dow,
           hhmm: `${parts.hour}:${String(mins).padStart(2, "0")}` };
}

function due(now) {
  return SLOTS.filter(([days, hhmm]) => hhmm === now.hhmm && (days === "*" || days.includes(now.dow)));
}

async function dispatch(env, file, date) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${file}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "leo-scheduler"
    },
    body: JSON.stringify({ ref: "main", inputs: date ? { date } : {} })
  });
  return { file, date, status: res.status, ok: res.status === 204 };
}

export default {
  async scheduled(event, env, ctx) {
    const now = easternNow(new Date(event.scheduledTime));
    const jobs = due(now);
    if (!jobs.length) return;
    if (!env.GITHUB_TOKEN) { console.log("GITHUB_TOKEN not set; nothing dispatched"); return; }
    const out = [];
    for (const [, , file, withDate] of jobs) out.push(await dispatch(env, file, withDate ? now.date : null));
    console.log(JSON.stringify({ slot: now, dispatched: out }));
  },
  // Read-only status: what this slot would start. Never dispatches.
  async fetch(request) {
    const now = easternNow();
    return new Response(JSON.stringify({ eastern: now, due: due(now).map(s => s[2]), slots: SLOTS.length }, null, 2),
      { headers: { "content-type": "application/json" } });
  }
};
