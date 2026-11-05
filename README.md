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

From `E:\New folder (7)\bingo-game`:

```powershell
npm install
npm run dev
```

The server listens on `http://localhost:3000`. Everyone on the local network can join via `http://<your-local-ip>:3000`.

## How to Play

1. The host enters a display name and clicks **Create room**. Share the 4‑letter room code.
2. Friends enter their names, the room code, and click **Join room** (need at least 2 players).
3. The host chooses a board size (5×5, 6×6, or 10×10) and presses **Start round** to distribute fresh cards and shuffle the turn order.
4. Players take **rotational turns**. When it's your turn, click a number on your card to call it. Every player who has that number gets it auto-marked.
5. Complete lines to earn points:
   - **1 point** for each completed line (vertical, horizontal, or diagonal “X” pattern)
   - Tiles glow when you complete a line; the server validates the claim automatically
   - Click **Declare Bingo** once you’ve completed a line to lock in your points
6. **Win condition**: First player to reach **5 points wins**!
7. **Lose condition**: Last player standing (if others drop out) loses.
8. The host can **remove disruptive players**, **change board size** between rounds, and **reset** whenever they’re ready for the next game.

## Room Chat

Every room has a live chat panel on the right side of the screen.

- Messages are only visible to players in the same room; the last 50 are kept so late joiners see recent history.
- Join/leave/kick events appear as system messages.
- Messages are limited to 300 characters and 5 messages per 5 seconds per player (anti-spam), and are rendered as plain text (no HTML injection).
- **Responsive:** on wide screens (≥1200px) chat is a third column; on tablets and phones it becomes a slide-in drawer opened with the 💬 button, which shows an unread-message badge.

## Deploying to Render

The app runs as a single long-lived Node web service (required for Socket.IO websockets).

- `render.yaml` is included as a Blueprint: **Build** `npm install`, **Start** `npm start`, health check `/healthz`.
- The server reads Render's `PORT` env var automatically.
- Rooms and chat are kept in memory, so they reset when the service restarts or the free instance spins down.

## Scripts

- `npm run dev` – start the server with hot reload (nodemon)
- `npm start` – start the server once with Node

## Tech Notes

- Server: Express + Socket.IO with in-memory room registry
- Client: Vanilla HTML/CSS/JS for easy hosting and zero build step
- Numbers range from 1 up to _boardSize²_ (25, 36, or 100) depending on the selected grid
- Data stays local; no persistence is written to disk

