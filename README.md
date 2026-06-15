# Connect Four

_Copyright 2016-2025 Caleb Evans_  
_Released under the MIT License_

[![tests](https://github.com/caleb531/connect-four/actions/workflows/tests.yml/badge.svg)](https://github.com/caleb531/connect-four/actions/workflows/tests.yml)

<!-- [![Coverage Status](https://coveralls.io/repos/github/caleb531/connect-four/badge.svg?branch=main)](https://coveralls.io/github/caleb531/connect-four?branch=main) -->

This is the slickest Connect Four app around, written using HTML5, JavaScript,
and Mithril (a React-like framework). You can play on your phone or computer,
with a friend or against Mr. A.I.

You can play the app online at:  
https://connectfour.calebevans.me/

## Features

- **1-Player mode** — play against the built-in minimax AI
- **2-Player mode** — local hotseat play
- **Online multiplayer** — share a room link and play with anyone
- **Room List** — browse open rooms and join or spectate live games at `/rooms`
- **Game history** — every completed game and all moves are stored in a local SQLite database
- **Bot / automation API** — a Socket.IO interface for scripted or AI-driven players

## Implementation

### User interface

The entire app UI is constructed and managed in JavaScript using
[Mithril][mithril]. Chip transitions are handled by CSS to maximize performance
and smoothness. The grid layout is styled with CSS Flexbox to enable the
stacking of grid elements from the bottom up.

[mithril]: http://mithril.js.org/

### AI Player

Like many traditional board game AIs, my Connect Four AI uses the
[minimax][minimax] algorithm. For my particular implementation, I've chosen to
use a maximum search depth of three (meaning the AI examines possibilities up to
three turns into the future). This is combined with [alpha-beta pruning][abp] to
dramatically reduce the number of possibilities evaluated.

My scoring heuristic works by counting connections of chips that intersect with
an empty slot, giving exponentially more weight to larger connections. For
example, every single chip touching an empty slot is worth four points, a
connect-two is worth nine points, a connect-three is worth sixteen points, and
so on. A winning connection of four or more chips is given the maximum/minimum
score.

In the app, the AI player is lovingly referred to as "Mr. AI".

[minimax]: https://en.wikipedia.org/wiki/Minimax
[abp]: https://en.wikipedia.org/wiki/Alpha%E2%80%93beta_pruning

### Game storage

All online games are persisted to a local SQLite database (`data/games.db`)
using Node's built-in [`node:sqlite`][node-sqlite] module (available since
Node 22.5, stable in Node 24). Two tables are maintained:

- **`games`** — one row per game, recording both players, the winner, start/end
  times, total move count, and final status (`in_progress`, `completed`, or
  `abandoned`)
- **`game_moves`** — one row per chip placement, recording the player, column,
  row, move number, and timestamp

[node-sqlite]: https://nodejs.org/api/sqlite.html

## Run the project locally

### 1. Install global dependencies

The project requires Node (>= 24), so make sure you have that installed.

### 2. Install project dependencies

This project uses [pnpm][pnpm] (instead of npm) for package installation and
management. From the cloned project directory, run:

[pnpm]: https://pnpm.io/

```bash
npm install -g pnpm
pnpm install
```

### 3. Serve app locally

To serve the app locally, run:

```bash
pnpm dev
```

You will then be able to view the app at `http://localhost:8080`. Any app files
are recompiled automatically when you make changes to them (as long as
`pnpm dev` is still running).

## Real-time API (Socket.IO)

All client/server communication — gameplay, room browsing, and history —
happens over a single [Socket.IO][socket-io] connection. Each request is an
event emitted with an acknowledgement callback; the server replies through that
callback. Connect to the server's origin (e.g. `http://localhost:8080`) and
emit the events below.

[socket-io]: https://socket.io/

### Read-only query events

These power the room list, history, and replay pages and have no side effects.

#### `list-rooms`

```js
socket.emit('list-rooms', {}, (rooms) => { ... });
```

Responds with all currently active rooms:

```json
[
  {
    "code": "ABCD",
    "playerCount": 2,
    "players": [
      { "name": "Alice", "color": "red" },
      { "name": "Bob", "color": "blue" }
    ],
    "status": "inProgress",
    "createdAt": 1714320000000
  }
]
```

`status` is one of `"waitingForPlayers"`, `"inProgress"`, or `"finished"`.

#### `list-games`

```js
socket.emit('list-games', { limit: 50, offset: 0 }, (games) => { ... });
```

Responds with games ordered by start time (newest first). `limit` defaults to
50 (max 200) and `offset` defaults to 0.

#### `get-game`

```js
socket.emit('get-game', { gameId: '...' }, (game) => { ... });
```

Responds with a single game record plus a `moves` array containing every chip
placement in order (or `{ error: 'Game not found' }`):

```json
{
  "id": "...",
  "room_code": "ABCD",
  "player1_name": "Alice",
  "player2_name": "Bob",
  "winner_color": "red",
  "status": "completed",
  "started_at": 1714320000000,
  "ended_at": 1714320300000,
  "total_moves": 12,
  "moves": [{ "move_number": 1, "player_color": "blue", "column_index": 3, "row_index": 0 }]
}
```

### Bot / automation API

Bots play over the same Socket.IO events as the browser client, so they can
compete against each other or against a human; human clients receive the usual
events as moves arrive. The relevant events are:

| Event               | Direction | Purpose                                                       |
| ------------------- | --------- | ------------------------------------------------------------- |
| `open-room`         | emit      | Open a room as Player 1 → `{ roomCode, localPlayer, game }`   |
| `add-player`        | emit      | Join as Player 2 and start the game → `{ localPlayer, game }` |
| `place-chip`        | emit      | Place a chip: `{ roomCode, column }` → `{ status, column }`   |
| `receive-next-move` | listen    | Server pushes `{ column }` when it becomes your turn          |
| `end-game`          | emit      | Signal intent to stop the current game                        |
| `request-new-game`  | emit      | Request or accept a rematch (include `winner`)                |
| `close-room`        | emit      | Remove the room and mark the game abandoned                   |

Every emitted event should include the `roomCode` (and `playerId` once known) in
its payload. Because the winner of a game is determined client-side, both
players must submit a `winner` (or `null` for a draw) via `request-new-game`
before the next game starts.

### Bot client and demo

A reusable bot client lives in [`bot/connect-four-bot.js`](bot/connect-four-bot.js),
and [`bot/play-demo.js`](bot/play-demo.js) uses it to play two bots against each
other. With the app running (`pnpm dev`), in another terminal run:

```
pnpm bot:demo            # plays against http://localhost:8080
pnpm bot:demo <url>      # target a different server
```

The client itself is small:

```js
import ConnectFourBot from './bot/connect-four-bot.js';

const bot = new ConnectFourBot({ name: 'MyBot', color: 'red' });
await bot.connect();
const { roomCode } = await bot.openRoom();

// Drop a chip whenever it becomes our turn
bot.onYourTurn(() => {
  const columns = bot.legalColumns;
  if (columns.length) bot.placeChip(columns[0]);
});
```
