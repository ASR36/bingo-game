# Local Network Bingo

A lightweight Bingo experience so friends on the same Wi‑Fi / LAN can join from their browsers. The Node.js server keeps rooms, cards, draws, and winners in sync via Socket.IO.

## Prerequisites

- [nvm for Windows](https://github.com/coreybutler/nvm-windows) (already installed per your setup)
- Node.js 20+. Express 5 requires Node 18+, so switch with:
  ```powershell
  nvm install 20
  nvm use 20
  ```

## Install & Run

```bash
npm install
npm run dev        # http://localhost:3000, restarts on change
```

| Script          | What it does                                   |
| --------------- | ---------------------------------------------- |
| `npm start`     | Start the server                               |
| `npm run dev`   | Start with auto-restart (nodemon)              |
| `npm test`      | Real-socket server tests                       |
| `npm run check` | Syntax check of every JS file                  |
| `npm run ci`    | Everything CI runs                             |

## How to Play

1. The host enters a display name and clicks **Create room**. Share the 4‑letter room code.
2. Friends enter their names, the room code, and click **Join room** (need at least 2 players).
3. The host chooses a board size (5×5, 6×6, or 10×10) and presses **Start round** to distribute fresh cards and shuffle the turn order.
4. Players take **rotational turns**. When it's your turn, click a number on your card to call it. Every player who has that number gets it auto-marked.
5. On phones, the board comes first; use the **Leaderboard · Players · Called · Room** tabs below it.
6. Complete lines to earn points:
   - **1 point** for each completed line (vertical, horizontal, or diagonal “X” pattern)
   - Tiles glow when you complete a line; the server validates the claim automatically
   - Click **Declare Bingo** once you’ve completed a line to lock in your points
6. **Win condition**: First player to reach **5 points wins**!
7. **Lose condition**: Last player standing (if others drop out) loses.
8. The host can **remove disruptive players**, **change board size** between rounds, and **reset** whenever they’re ready for the next game.

## Play with the Computer

From the lobby choose **1–3 computer opponents** and a level, then tap **Play with computer**. The game starts straight away.

- **Easy** calls random numbers from its card.
- **Medium** works on its most complete line.
- **Hard** builds several lines at once and always finishes a line when it can.

Computer players only look at their own card. They run on the server, so refreshing keeps your game. Computer games are private (nobody can join by code) and close when you leave. Use **Reset game** then **Start round** for a rematch.

## Room Chat

Every room has a live chat panel on the right side of the screen.

- Messages are only visible to players in the same room; the last 50 are kept so late joiners see recent history.
- Join/leave/kick events appear as system messages.
- A typing indicator ("Alice is typing…") shows who is composing a message; it clears when they send, stop typing for 3 seconds, or leave.
- Messages are limited to 300 characters and 5 messages per 5 seconds per player (anti-spam), and are rendered as plain text (no HTML injection).
- **Responsive:** on wide screens (≥1200px) chat is a third column; on tablets and phones it becomes a slide-in drawer opened with the 💬 button, which shows an unread-message badge.

## Refresh-safe rooms

Each browser tab gets a private id kept in `sessionStorage`. Refreshing the page, or losing signal, puts you straight back in your seat with the same card and marks. If you don't come back within 60 seconds you're removed from the room. The private id is never sent to other players; they only see a random public id.

Use **Leave** to exit a room on purpose.

## Branches, CI and deployment (Render, free plan)

- Branches: `dev` → `uat` → `main`. Only **`main`** is deployed (production).
- **CI** (`.github/workflows/ci.yml`) runs a syntax check and the tests on Node 20 and 22 for every push and pull request to `dev`, `uat` and `main`.
- **CD**: Render deploys `main` only after CI passes (`autoDeployTrigger: checksPass` in `render.yaml`). Health check: `/healthz`.
- `ARENA_URL` (optional) shows a "← Arena" link back to the Arena Games hub.
- Rooms and chat are kept in memory, so they reset when the free instance restarts or sleeps.

## Scripts

See **Install & Run** above.

## Tech Notes

- Server: Express + Socket.IO with in-memory room registry
- Client: Vanilla HTML/CSS/JS for easy hosting and zero build step
- Numbers range from 1 up to _boardSize²_ (25, 36, or 100) depending on the selected grid
- Data stays local; no persistence is written to disk

