import { io } from 'socket.io-client';

const COLUMN_COUNT = 7;
const ROW_COUNT = 6;

// A reusable Connect Four bot that plays over the same Socket.IO protocol used
// by the browser client (see server/index.js). Construct one bot per player,
// call connect(), then either openRoom() to host or joinRoom(code) to join.
//
// The bot maintains a local `heights` array (chips per column) so it can choose
// legal moves, since the server only echoes individual moves over the wire
// rather than the full board state on every turn.
class ConnectFourBot {
  constructor({ url = 'http://localhost:8080', name, color } = {}) {
    if (!name || !color) {
      throw new Error('A bot requires both a name and a color');
    }
    this.url = url;
    this.name = name;
    this.color = color;
    this.roomCode = null;
    this.playerId = null;
    this.game = null;
    this.heights = new Array(COLUMN_COUNT).fill(0);
    this.onTurnHandler = null;
  }

  // Establish the socket connection and wire up the events the bot reacts to
  connect() {
    this.socket = io(this.url);

    // The server pushes the full game state when the second player joins or a
    // rematch starts; refresh our local snapshot from it
    const refreshGame = ({ game } = {}) => {
      if (game) this.syncFromGame(game);
    };
    this.socket.on('add-player', refreshGame);
    this.socket.on('start-new-game', refreshGame);

    // When the opponent moves, the server tells us which column they played
    // (and that it is now our turn)
    this.socket.on('receive-next-move', ({ column }) => {
      if (typeof column === 'number') this.heights[column] += 1;
      // The server only signals our own socket when it is our turn, so reflect
      // that in the local snapshot
      if (this.game) this.game.currentPlayer = this.color;
      if (this.onTurnHandler) this.onTurnHandler();
    });

    return new Promise((resolve) => this.socket.on('connect', resolve));
  }

  // Promise-based wrapper around an emit + acknowledgement round trip
  request(eventName, data = {}) {
    return new Promise((resolve, reject) => {
      this.socket.emit(
        eventName,
        { roomCode: this.roomCode, playerId: this.playerId, ...data },
        (response = {}) => {
          if (response.error || response.status === 'roomNotFound') {
            reject(new Error(response.error || response.status));
          } else {
            resolve(response);
          }
        }
      );
    });
  }

  // Rebuild the local board snapshot and column heights from a serialized game
  syncFromGame(game) {
    this.game = game;
    if (game.grid && game.grid.columns) {
      this.heights = game.grid.columns.map((column) => column.length);
    }
  }

  // Host a new room as Player 1 and wait for an opponent
  async openRoom() {
    const res = await this.request('open-room', {
      player: { name: this.name, color: this.color }
    });
    this.roomCode = res.roomCode;
    this.playerId = res.localPlayer.id;
    this.syncFromGame(res.game);
    return res;
  }

  // Join an existing room as Player 2; this starts the game immediately
  async joinRoom(roomCode) {
    this.roomCode = roomCode;
    const res = await this.request('add-player', {
      player: { name: this.name, color: this.color }
    });
    this.playerId = res.localPlayer.id;
    this.syncFromGame(res.game);
    return res;
  }

  get inProgress() {
    return Boolean(this.game && this.game.inProgress);
  }

  // True when the game is live and it is this bot's turn to move
  get myTurn() {
    return this.inProgress && this.game.currentPlayer === this.color;
  }

  // Columns that still have room for another chip
  get legalColumns() {
    const columns = [];
    for (let c = 0; c < COLUMN_COUNT; c += 1) {
      if (this.heights[c] < ROW_COUNT) columns.push(c);
    }
    return columns;
  }

  // Drop a chip into the given column and update the local snapshot
  async placeChip(column) {
    const res = await this.request('place-chip', { column });
    if (typeof res.column === 'number') {
      this.heights[res.column] += 1;
      // The current player flips to the opponent once we've moved
      if (this.game) this.game.currentPlayer = this.opponentColor;
    }
    return res;
  }

  get opponentColor() {
    return this.color === 'red' ? 'blue' : 'red';
  }

  // Register a callback to run whenever the opponent finishes their move (i.e.
  // it is now this bot's turn)
  onYourTurn(handler) {
    this.onTurnHandler = handler;
  }

  close() {
    return this.request('close-room');
  }

  disconnect() {
    if (this.socket) this.socket.disconnect();
  }
}

export default ConnectFourBot;
