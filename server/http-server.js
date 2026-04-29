import compression from 'compression';
import express from 'express';
import expressEnforcesSSL from 'express-enforces-ssl';
import helmet from 'helmet';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { createServer as createViteServer } from 'vite';
import cspDirectives from './csp.js';
import db from './db.js';
import { roomManager } from './room-manager.js';

// __dirname is not available in ES modules natively, so we must define it
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Ensure that we serve the correct index.html path depending upon the
// environment/context
const indexPath =
  process.env.NODE_ENV === 'production'
    ? path.join(path.dirname(__dirname), 'dist', 'index.html')
    : path.join(path.dirname(__dirname), 'index.html');

// Transform page HTML using both EJS and Vite
async function transformHtml(vite, req, res, htmlPath, params) {
  res.render(htmlPath, params, async (err, html) => {
    if (err) {
      console.log(err);
      res.status(500);
      res.send('');
      return;
    }
    if (vite) {
      html = await vite.transformIndexHtml(req.originalUrl, html);
    }
    res.status(200);
    res.send(html);
  });
}

// Express server
async function createHttpServer() {
  const app = express();

  // Use EJS as view engine, regardless of file extension (i.e. we need
  // index.html instead of index.ejs so Vite can recognize entry point)
  app.set('view engine', 'html');
  app.engine('html', (await import('ejs')).renderFile);

  // Force HTTPS on production
  if (process.env.NODE_ENV === 'production' && !process.env.DISABLE_SSL) {
    app.enable('trust proxy');
    app.use(expressEnforcesSSL());
  }
  // Add the recommended security headers
  app.use(
    helmet({
      // Helmet's default value of require-corp for Cross-Origin-Embedder-Policy
      // breaks the caching of the Google Fonts CSS via the service worker,
      // supposedly because Google Fonts serves an opaque response for the CSS
      // which, per the nature of opaque responses, is not explicitly marked as
      // loadable from another origin
      crossOriginEmbedderPolicy: false,
      // Define relatively-strict Content Security Policy (CSP)
      contentSecurityPolicy: {
        useDefaults: false,
        directives: cspDirectives
      }
    })
  );

  // Serve assets using gzip compression
  app.use(compression());

  // Setting vite outside of the conditional so that we can later check if it's
  // undefined (because in Production mode, we don't want to have Vite transform
  // the HTML)
  let vite = null;
  if (process.env.NODE_ENV !== 'production') {
    // I've found that Vite's middleware does not play nicely with the service
    // worker; for example, if they are both active at the same time, Vite's
    // middleware will wrap the app's CSS contents in a JavaScript wrapper when
    // the service worker tries to fetch CSS, thus causing all styles to break
    // (because the associated <link /> tag receives JS, not raw CSS);
    // therefore, we need to remove Vite as the middleman when serving
    // Production so that the service worker can fetch the static files directly
    // (the middleware can be safely disabled in Production because we use Vite
    // to pre-build the project anyway)
    vite = await createViteServer({
      server: { middlewareMode: true, allowedHosts: process.env.VITE_ALLOWED_HOSTS ? process.env.VITE_ALLOWED_HOSTS.split(',') : true },
      appType: 'custom'
    });
    app.use(vite.middlewares);
  }

  // REST API

  const apiRouter = express.Router();
  app.use('/api', express.json(), apiRouter);

  // Room list — only show rooms with at least one connected player
  apiRouter.get('/rooms', (req, res) => {
    const rooms = Object.values(roomManager.roomsByCode)
      .filter((room) => !room.isEmpty())
      .map((room) => {
        let status;
        if (room.game.inProgress) {
          status = 'inProgress';
        } else if (room.players.length < 2) {
          status = 'waitingForPlayers';
        } else {
          status = 'finished';
        }
        return {
          code: room.code,
          playerCount: room.players.filter((p) => p.connected).length,
          players: room.players.map((p) => ({ name: p.name, color: p.color })),
          status,
          createdAt: room.createdAt
        };
      });
    res.json(rooms);
  });

  // Game history
  apiRouter.get('/games', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const games = db
      .prepare('SELECT * FROM games ORDER BY started_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset);
    res.json(games);
  });

  apiRouter.get('/games/:id', (req, res) => {
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
    if (!game) {
      res.status(404).json({ error: 'Game not found' });
      return;
    }
    const moves = db
      .prepare('SELECT * FROM game_moves WHERE game_id = ? ORDER BY move_number ASC')
      .all(req.params.id);
    res.json({ ...game, moves });
  });

  // Bot API — REST interface for automated players/bots

  // Open a room as a bot (becomes Player 1, waits for Player 2)
  apiRouter.post('/bot/open-room', (req, res) => {
    const { player } = req.body || {};
    if (!player?.name || !player?.color) {
      return res.status(400).json({ error: 'player.name and player.color are required' });
    }
    const room = roomManager.openRoom();
    const localPlayer = room.addPlayer({ player, socket: null });
    res.json({ roomCode: room.code, playerId: localPlayer.id, game: room.game });
  });

  // Join a room as a bot (becomes Player 2 and starts the game immediately)
  apiRouter.post('/bot/join-room', (req, res) => {
    const { roomCode, player } = req.body || {};
    if (!roomCode) return res.status(400).json({ error: 'roomCode is required' });
    if (!player?.name || !player?.color) {
      return res.status(400).json({ error: 'player.name and player.color are required' });
    }
    const room = roomManager.getRoom(roomCode);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.players.length >= 2) return res.status(400).json({ error: 'Room is full' });

    const localPlayer = room.addPlayer({ player, socket: null });
    room.game.startGame();

    // Record game start in DB
    try {
      const gameId = uuidv4();
      room.game.dbId = gameId;
      room.game.moveCount = 0;
      db.prepare(`
        INSERT INTO games (id, room_code, player1_id, player1_name, player1_color, player2_id, player2_name, player2_color, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        gameId,
        room.code,
        room.players[0].id,
        room.players[0].name,
        room.players[0].color,
        room.players[1].id,
        room.players[1].name,
        room.players[1].color,
        Date.now()
      );
    } catch (e) {
      console.error('DB error recording bot game start:', e);
    }

    // Notify Player 1 via WebSocket if they are connected
    if (room.players[0].socket) {
      room.players[0].socket.emit('add-player', {
        status: 'addedPlayer',
        game: room.game,
        localPlayer: room.players[0]
      });
    }

    res.json({ playerId: localPlayer.id, game: room.game });
  });

  // Get current game state for a bot (poll this to detect your turn)
  apiRouter.get('/bot/state/:roomCode', (req, res) => {
    const room = roomManager.getRoom(req.params.roomCode);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const { playerId } = req.query;
    const player = playerId ? room.getPlayerById(playerId) : null;

    res.json({
      game: room.game,
      yourTurn: player ? room.game.currentPlayer?.id === player.id : null,
      playerCount: room.players.length
    });
  });

  // Place a chip as a bot
  apiRouter.post('/bot/place-chip', (req, res) => {
    const { roomCode, playerId, column } = req.body || {};
    if (!roomCode || !playerId || column === undefined || column === null) {
      return res.status(400).json({ error: 'roomCode, playerId, and column are required' });
    }
    const room = roomManager.getRoom(roomCode);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!room.game.inProgress) return res.status(400).json({ error: 'Game is not in progress' });

    const player = room.getPlayerById(playerId);
    if (!player) return res.status(403).json({ error: 'Player not found in room' });
    if (room.game.currentPlayer?.id !== player.id) {
      return res.status(400).json({ error: 'Not your turn' });
    }

    const colIndex = parseInt(column);
    if (isNaN(colIndex) || colIndex < 0 || colIndex >= room.game.grid.columnCount) {
      return res.status(400).json({ error: 'Invalid column (0–6)' });
    }
    if (room.game.grid.columns[colIndex].length >= room.game.grid.rowCount) {
      return res.status(400).json({ error: 'Column is full' });
    }

    room.game.placeChip({ column: colIndex });
    const placedColumn = room.game.grid.lastPlacedChip.column;

    // Record move in DB
    if (room.game.dbId) {
      try {
        room.game.moveCount += 1;
        const lastChip = room.game.grid.lastPlacedChip;
        db.prepare(`
          INSERT INTO game_moves (id, game_id, player_id, player_color, column_index, row_index, move_number, placed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          uuidv4(),
          room.game.dbId,
          player.id,
          lastChip.player,
          lastChip.column,
          lastChip.row,
          room.game.moveCount,
          Date.now()
        );
        db.prepare(`UPDATE games SET total_moves = ? WHERE id = ?`).run(
          room.game.moveCount,
          room.game.dbId
        );
      } catch (e) {
        console.error('DB error recording bot move:', e);
      }
    }

    // Notify the other player via WebSocket if connected
    if (room.game.currentPlayer?.socket) {
      room.game.currentPlayer.socket.emit('receive-next-move', { column: placedColumn });
    }

    res.json({ status: 'placedChip', column: placedColumn, game: room.game });
  });

  // End the current game as a bot (signals intent to stop playing)
  apiRouter.post('/bot/end-game', (req, res) => {
    const { roomCode, playerId } = req.body || {};
    if (!roomCode || !playerId) {
      return res.status(400).json({ error: 'roomCode and playerId are required' });
    }
    const room = roomManager.getRoom(roomCode);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const player = room.getPlayerById(playerId);
    if (!player) return res.status(403).json({ error: 'Player not found in room' });

    room.game.endGame();
    room.game.requestingPlayer = player;

    // Notify connected players
    room.players.forEach((p) => {
      if (p !== player && p.socket) {
        p.socket.emit('end-game', {
          status: 'endedGame',
          requestingPlayer: room.game.requestingPlayer,
          localPlayer: p
        });
      }
    });

    res.json({ status: 'endedGame' });
  });

  // Request a new game or accept an existing request (submit winner to record result)
  apiRouter.post('/bot/new-game', (req, res) => {
    const { roomCode, playerId, winner } = req.body || {};
    if (!roomCode || !playerId) {
      return res.status(400).json({ error: 'roomCode and playerId are required' });
    }
    const room = roomManager.getRoom(roomCode);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const localPlayer = room.getPlayerById(playerId);
    if (!localPlayer) return res.status(403).json({ error: 'Player not found in room' });

    localPlayer.lastSubmittedWinner = winner || null;
    const submittedWinners = room.players.map((p) => p.lastSubmittedWinner || {});

    if (!room.game.pendingNewGame) {
      room.game.requestingPlayer = localPlayer;
      room.game.pendingNewGame = true;
      room.players.forEach((p) => {
        if (p !== localPlayer && p.socket) {
          p.socket.emit('request-new-game', {
            status: 'newGameRequested',
            requestingPlayer: room.game.requestingPlayer,
            localPlayer: p
          });
        }
      });
      return res.json({ status: 'requestingNewGame' });
    }

    if (submittedWinners.length === 2 && localPlayer !== room.game.requestingPlayer) {
      room.game.declareWinner();

      // Record the completed game
      if (room.game.dbId) {
        try {
          db.prepare(
            `UPDATE games SET winner_id = ?, winner_color = ?, status = 'completed', ended_at = ? WHERE id = ?`
          ).run(
            room.game.winner ? room.game.winner.id : null,
            room.game.winner ? room.game.winner.color : null,
            Date.now(),
            room.game.dbId
          );
        } catch (e) {
          console.error('DB error recording bot game winner:', e);
        }
      }

      room.game.resetGame();
      room.game.startGame();

      // Record the new game start
      try {
        const newGameId = uuidv4();
        room.game.dbId = newGameId;
        room.game.moveCount = 0;
        db.prepare(`
          INSERT INTO games (id, room_code, player1_id, player1_name, player1_color, player2_id, player2_name, player2_color, started_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          newGameId,
          room.code,
          room.players[0].id,
          room.players[0].name,
          room.players[0].color,
          room.players[1].id,
          room.players[1].name,
          room.players[1].color,
          Date.now()
        );
      } catch (e) {
        console.error('DB error recording bot new game:', e);
      }

      room.players.forEach((p) => {
        if (p.socket) {
          p.socket.emit('start-new-game', { status: 'startedGame', game: room.game, localPlayer: p });
        }
      });
      return res.json({ status: 'startedGame', game: room.game });
    }

    res.json({ status: 'pendingNewGame' });
  });

  // Close a room as a bot host
  apiRouter.post('/bot/close-room', (req, res) => {
    const { roomCode, playerId } = req.body || {};
    if (!roomCode || !playerId) {
      return res.status(400).json({ error: 'roomCode and playerId are required' });
    }
    const room = roomManager.getRoom(roomCode);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!room.getPlayerById(playerId)) {
      return res.status(403).json({ error: 'Player not found in room' });
    }
    if (room.game.dbId) {
      try {
        db.prepare(
          `UPDATE games SET status = 'abandoned', ended_at = ? WHERE id = ? AND status = 'in_progress'`
        ).run(Date.now(), room.game.dbId);
      } catch (e) {
        console.error('DB error marking bot room as abandoned:', e);
      }
    }
    roomManager.closeRoom(room);
    res.json({ status: 'closedRoom' });
  });

  // SPA Routes

  app.get('/rooms', async (req, res) => {
    await transformHtml(vite, req, res, indexPath, { pageTitle: 'Browse Rooms - Connect Four' });
  });

  app.get('/history', async (req, res) => {
    await transformHtml(vite, req, res, indexPath, { pageTitle: 'Game History - Connect Four' });
  });

  app.get('/room/:roomCode', async (req, res) => {
    const room = roomManager.getRoom(req.params.roomCode);
    if (room) {
      const inviteeName = room.players[0] ? room.players[0].name : 'Someone';
      await transformHtml(vite, req, res, indexPath, {
        pageTitle: `${inviteeName} invited you to play!`
      });
    } else {
      await transformHtml(vite, req, res, indexPath, {
        pageTitle: "Room doesn't exist"
      });
    }
  });
  app.get('/room', (req, res) => {
    res.redirect(301, '/');
  });
  // We need to specify /index.html in addition to / so that the service worker
  // caches the index.html file that EJS has already processed via
  // transformHtml()
  app.get(['/', '/index.html'], async (req, res) => {
    await transformHtml(vite, req, res, indexPath, {
      pageTitle: 'Caleb Evans'
    });
  });

  // Vite not being defined implies that NODE_ENV === production, per the
  // createViteServer() conditional earlier in the file
  if (!vite) {
    // Since we changed the name of the service worker when integrating Vite PWA
    // (from service-worker.js to sw.js), we need to preserve backwards
    // compatibility with users whose have already registered with
    // service-worker.js, since they won't ever look for sw.js when checking for
    // updates; we can solve this by making both /sw.js and /service-worker.js
    // point to the same static file on the server
    app.use(
      '/sw.js',
      express.static(path.join(path.dirname(__dirname), 'dist', 'service-worker.js'))
    );
    // We set this *after* the / route above because that / route needs to take
    // precedence (so that Vite/EJS can process index.html)
    app.use(express.static(path.join(path.dirname(__dirname), 'dist')));
  }

  // HTTP server wrapper

  const server = http.Server(app);
  // Warning: app.listen(8080) will not work here; see
  // <https://github.com/socketio/socket.io/issues/2075>
  server.listen(process.env.PORT || 8080, () => {
    console.log(`Server started. Listening on port ${server.address().port}`);
  });

  return server;
}

export default createHttpServer;
