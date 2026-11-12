# IPL TRUMP 2026

A two-player, real-time cricket Trump-card game: build an IPL squad through a live auction from a ₹120 Cr purse, then play a 14-match tournament where each match is 11 rounds of private card duels.

Dependency-free: Node.js 18+ built-ins only (`http`, `crypto`, `fs`, `node:test`). No `npm install` is needed.

```bash
npm start          # http://localhost:3000  (PORT=… to change)
npm test           # 25 engine + HTTP/SSE tests
```

Open the app in two browser windows (or two browsers). Window A creates a room and reads out the code. Window B joins with that code.

## What is implemented

| Area | Status |
|---|---|
| Landing, create / join room by code | Done |
| Lobby with both names, connection dots, waiting state; start only when both are connected | Done |
| Team selection for 10 IPL franchises; the same team cannot be taken twice | Done |
| Live auction: one lot at a time, countdown, bid increments, pass, SOLD / UNSOLD stamps, purse enforcement, no double purchase | Done |
| Squad review with role counts, spend, balance and validation; invalid squads cannot enter the tournament; host can restart the auction | Done |
| 14-match schedule, 11 rounds per match, standings with tie-breaks, champion screen | Done |
| Private round cards and category choices (server stores them; each stream only ever receives that player's own view) | Done, tested over HTTP |
| Server-side random card draws, server-side normalised comparison, auto-pick on timeout | Done |
| Disconnect / reconnect (stored token, state persisted to disk, survives server restart) | Done |
| Duplicate-action suppression (`actionId`) | Done |
| Real IPL player data | **Not included** – see "Player data" |
| Player photographs, official team logos | **Not included** – initials avatars and generated crests are used |
| Accounts / passwords | **Not included** – a name plus a random session token identifies a player |
| Database engine | JSON file with atomic writes (`data/rooms.json`); `lib/store.js` is the swap point |
| Browser-level testing | Not performed in this build. The two-session test drives two independent HTTP/SSE clients, not real browsers |

## Player data

`data/players.json` is **absent**, so the game loads a deterministic **synthetic test roster** of 40 players named `Test Batter 01` … `Test Wicketkeeper 08`. Every synthetic record has `dataSource: "SYNTHETIC_TEST"` and shows a TEST DATA badge. These numbers do not describe real cricketers.

To use verified data, create `data/players.json` as an array (or `{ "players": [...] }`) of records:

```json
{
  "id": "ORG-0001",
  "name": "Full Name",
  "role": "Batter | Bowler | All-rounder | Wicketkeeper",
  "nationality": "India",
  "iplTeams": ["CSK", "MI"],
  "basePrice": 200,
  "dataSource": "IPL_OFFICIAL_2026",
  "photo": "/photos/ORG-0001.jpg",
  "stats": {
    "matches": 0, "runs": 0, "battingAverage": null, "strikeRate": null,
    "highestScore": null, "centuries": 0, "halfCenturies": 0,
    "wickets": 0, "bowlingAverage": null, "oversBowled": 0,
    "economyRate": null, "catches": 0
  }
}
```

`basePrice` is in **lakh** (1 Cr = 100), so `200` means ₹2 Cr. `null` means "statistic not applicable", and that category is not offered for the player. The loader rejects malformed records at start-up.

## Rules

**Money.** All amounts are integer lakh. Starting purse ₹120 Cr (12,000). Bid increments: ₹5 lakh below ₹1 Cr, ₹10 lakh below ₹5 Cr, ₹25 lakh above that.

**Auction.** Each lot opens with a 12 s window. Each bid resets the countdown to 8 s. A lot closes when the non-leading bidder passes (the leader cannot pass), or when the countdown expires. Bids are capped at the purse. A bid must also leave ₹0.5 Cr for every squad slot still needed, so a squad can always be filled. Unsold players are re-offered in up to 10 cycles while a squad is short. A seat that is short must keep bidding when the remaining lots only just cover its need.

**Squad rules.** 15–18 players, at least 4 batters, 4 bowlers and 1 wicketkeeper.

**Tournament.** Two players meet in 14 matches. A match win scores 2 points, a draw 1 point each, and a loss 0. Standings are ranked by points, then match wins, then round wins. If all three are equal the players are joint champions.

**Round.** Each side draws a random card from its squad, excluding cards already used in that match where possible. Each side then independently locks one category from those its card has. Selections are auto-picked after 30 s. Once both have locked, both cards and choices are revealed together. A round point goes to the higher normalised score. Equal scores award no point.

**Categories and normalisation.** Each raw statistic is mapped linearly onto 0–100 using a fixed window and clamped at both ends (`lib/rules.js`):

| Category | Better | Window (worst → best) | Offered when |
|---|---|---|---|
| Matches | higher | 0 → 300 | always |
| Runs | higher | 0 → 8000 | always |
| Batting Average | higher | 0 → 60 | runs > 0 |
| Strike Rate | higher | 0 → 200 | runs > 0 |
| Highest Score | higher | 0 → 180 | runs > 0 |
| Centuries | higher | 0 → 10 | always |
| Half Centuries | higher | 0 → 60 | always |
| Wickets | higher | 0 → 250 | overs bowled > 0 |
| Bowling Average | **lower** | 50 → 15 | wickets > 0 |
| Economy Rate | **lower** | 11 → 6 | overs bowled > 0 |
| Catches | higher | 0 → 150 | always |

The windows are a documented design choice. They make a 150-run innings and a 3-wicket spell comparable, but they are a judgement call that can be tuned in one place.

## Architecture

```
lib/rules.js   pure rules: categories, normalisation, comparison, squad validation
lib/room.js    authoritative state machine + per-player viewFor() projection
lib/data.js    teams, player loader, synthetic test roster
lib/store.js   atomic JSON persistence (swap point for a real DB)
lib/server.js  HTTP + SSE + POST actions, background ticker
public/        dependency-free client (index.html, app.js, styles.css)
test/          engine.test.js (21), server.test.js (4)
```

**Why SSE + POST rather than WebSockets.** The environment could not reach the npm registry, so no `ws` package was available. SSE gives one private server-to-client stream per player, and POST carries the actions. This is a deliberate trade-off; swapping in WebSockets only changes `server.js`.

**Privacy model.** The client renders only what the server sends. `viewFor(room, seat)` is the only object sent to a client. It contains an opponent's card and choice only at the `revealed` stage. The `round` and `match` payloads are tested not to contain the opponent's card ID before reveal, over real HTTP. Squads are public, as the brief requires for the auction dashboard. An opponent's round card is drawn server-side at random, so it cannot be inferred from the squad list.

**Server authority.** Every rule above is enforced in `lib/room.js`. The browser sends intents only (`bid 12.5 Cr`, `lock runs`). It cannot set scores, purchases or purse values.

**Timers.** Bid countdowns, the 30 s selection timeout, round and match pacing are all driven by the server's ticker, and each deadline is a server timestamp. A reconnecting browser is re-synchronised by the next view.

## Known limitations and open decisions

- **Auth is not production-grade.** Anyone with a room code can join while a seat is open. Tokens are stored in `localStorage`. Add accounts before any public deployment.
- **Concurrency.** Node processes one action at a time, so races inside a process are impossible. Running multiple instances would need a shared store and a sticky route.
- **Auction outcomes can still be invalid.** If both players pass a lot repeatedly and cycles run out, a squad may remain short. The UI then offers *Restart auction*. The restart keeps teams and resets purses.
- **Single room, one process.** `data/rooms.json` grows without bound; archive finished rooms in production.
- **Layout.** Designed for desktop and tablet widths. Mobile is responsive but not hand-tuned.
