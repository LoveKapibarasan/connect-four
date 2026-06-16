import open from 'open';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';

import createHttpServer from './http-server.js';
import db from './db.js';
import { roomManager } from './room-manager.js';

// Socket.IO server
async function createServer() {
  await db.init();
  const httpServer = await createHttpServer();
  const io = new Server(httpServer);

  // A wrapper around RoomManager.getRoom() to run the given callback if the
  // specified room exists, otherwise responding with an error message if the room
  // does not exist
  function getRoom(callback) {
    return async (options, fn) => {
      options.room = roomManager.getRoom(options.roomCode);
      if (options.room) {
        await callback(options, fn);
      } else {
        console.log(`room ${options.roomCode} not found`);
        fn({ status: 'roomNotFound' });
      }
    };
  }

  io.on('connection', (socket) => {
    console.log(`connected: ${socket.id}`);

    // Room events

    socket.on('open-room', ({ player }, fn) => {
      console.log(`open room by player ${player.name}`);
      const room = roomManager.openRoom();
      const localPlayer = room.addPlayer({ player, socket });
      fn({
        status: 'waitingForPlayers',
        roomCode: room.code,
        game: room.game,
        localPlayer
      });
    });

    socket.on(
      'join-room',
      getRoom(({ room, playerId }, fn) => {
        console.log(`join room by ${playerId}`);
        roomManager.markRoomAsActive(room);
        const localPlayer = room.connectPlayer({ playerId, socket });
        let status;
        if (localPlayer) {
          if (room.players.length === 1) {
            status = 'waitingForPlayers';
          } else if (room.game.pendingNewGame && localPlayer === room.game.requestingPlayer) {
            status = 'requestingNewGame';
          } else if (room.game.pendingNewGame && localPlayer !== room.game.requestingPlayer) {
            status = 'newGameRequested';
          } else {
            status = 'returningPlayer';
          }
          // If this join-room call represents a player reconnecting to the game
          // (where they were previously disconnected), inform the other player that
          // they have reconnected
          delete localPlayer.lastDisconnectReason;
          localPlayer.broadcast('player-reconnected', {
            // If the game is still pending, make sure to stay in a pending state,
            // otherwise we can clear the status message
            status: room.game.pendingNewGame ? null : 'playerReconnected'
          });
        } else if (room.players.length === 2) {
          // If both players are currently connected, all future connections
          // represent spectators
          status = 'watchingGame';
        } else {
          status = 'newPlayer';
        }
        fn({
          status,
          game: room.game,
          localPlayer
        });
      })
    );

    socket.on(
      'close-room',
      getRoom(async ({ room }, fn) => {
        if (room.game.dbId) {
          try {
            await db.run(
              `UPDATE games SET status = 'abandoned', ended_at = ? WHERE id = ? AND status = 'in_progress'`,
              Date.now(),
              room.game.dbId
            );
          } catch (e) {
            console.error('DB error marking game abandoned:', e);
          }
        }
        roomManager.closeRoom(room);
        fn({ status: 'closedRoom' });
      })
    );

    socket.on(
      'decline-new-game',
      getRoom(({ playerId, room }, fn) => {
        console.log(`decline new game by ${playerId}`);
        const localPlayer = room.getPlayerById(playerId);
        localPlayer.lastDisconnectReason = 'newGameDeclined';
        room.game.pendingNewGame = false;
        fn({ status: 'declinedNewGame' });
      })
    );

    socket.on(
      'add-player',
      getRoom(async ({ room, player }, fn) => {
        console.log(`add player to room ${room.code}`);
        const localPlayer = room.addPlayer({ player, socket });
        room.game.startGame();
        // Automatically update first player's screen when second player joins
        localPlayer.broadcast('add-player', {
          status: 'addedPlayer',
          game: room.game
        });
        // Record game start in DB
        try {
          const gameId = uuidv4();
          room.game.dbId = gameId;
          room.game.moveCount = 0;
          await db.run(
            `
            INSERT INTO games (id, room_code, player1_id, player1_name, player1_color, player2_id, player2_name, player2_color, started_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
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
          console.error('DB error recording game start:', e);
        }
        fn({
          status: 'startedGame',
          game: room.game,
          localPlayer
        });
      })
    );

    // Gameplay events

    socket.on(
      'align-pending-chip',
      getRoom(({ room, column }, fn) => {
        room.game.pendingChipColumn = column;
        room.game.currentPlayer.broadcast('align-pending-chip', { column });
        fn({});
      })
    );

    socket.on(
      'place-chip',
      getRoom(async ({ room, column, playerId }, fn) => {
        console.log(`place chip ${room.code}`);
        // Validate the move server-side rather than trusting the client: the
        // game must be in progress, it must actually be the requesting player's
        // turn, and the target column must be a real, non-full column. This
        // prevents a malicious or buggy client from moving out of turn or into
        // an invalid column.
        const player = room.getPlayerById(playerId);
        const grid = room.game.grid;
        if (!room.game.inProgress) {
          fn({ status: 'error', error: 'Game is not in progress' });
          return;
        }
        if (!player || !room.game.currentPlayer || room.game.currentPlayer.id !== player.id) {
          fn({ status: 'error', error: 'Not your turn' });
          return;
        }
        if (
          !Number.isInteger(column) ||
          column < 0 ||
          column >= grid.columnCount ||
          grid.columns[column].length >= grid.rowCount
        ) {
          fn({ status: 'error', error: 'Invalid column' });
          return;
        }
        room.game.placeChip({ column });
        // After placeChip() is called, the turn ends for the player who placed
        // the chip, making the other player the new current player
        column = room.game.grid.lastPlacedChip.column;
        if (room.game.currentPlayer && room.game.currentPlayer.socket) {
          console.log('receive next move');
          room.game.currentPlayer.socket.emit('receive-next-move', { column });
        } else {
          console.log('did not receive next move');
          console.log('current player:', room.game.currentPlayer);
        }
        // Record move in DB
        if (room.game.dbId) {
          try {
            room.game.moveCount += 1;
            const lastChip = room.game.grid.lastPlacedChip;
            const placingPlayer = room.players.find((p) => p.color === lastChip.player);
            await db.run(
              `
                INSERT INTO game_moves (id, game_id, player_id, player_color, column_index, row_index, move_number, placed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              `,
              uuidv4(),
              room.game.dbId,
              placingPlayer ? placingPlayer.id : null,
              lastChip.player,
              lastChip.column,
              lastChip.row,
              room.game.moveCount,
              Date.now()
            );
            await db.run(
              `UPDATE games SET total_moves = ? WHERE id = ?`,
              room.game.moveCount,
              room.game.dbId
            );
          } catch (e) {
            console.error('DB error recording move:', e);
          }
        }
        fn({ status: 'placedChip', column });
      })
    );

    // Game management events

    socket.on(
      'end-game',
      getRoom(async ({ playerId, room }, fn) => {
        console.log('end game', playerId);
        room.game.endGame();
        const localPlayer = room.getPlayerById(playerId);
        room.game.requestingPlayer = localPlayer;
        if (room.game.dbId) {
          try {
            await db.run(
              `UPDATE games SET status = 'abandoned', ended_at = ? WHERE id = ? AND status = 'in_progress'`,
              Date.now(),
              room.game.dbId
            );
          } catch (e) {
            console.error('DB error marking game abandoned on end-game:', e);
          }
        }
        room.broadcast('end-game', {
          status: 'endedGame',
          requestingPlayer: room.game.requestingPlayer
        });
        fn({
          status: 'endedGame',
          requestingPlayer: localPlayer
        });
      })
    );

    socket.on(
      'request-new-game',
      getRoom(async ({ playerId, room, winner }, fn) => {
        console.log('request new game', playerId);
        const localPlayer = room.getPlayerById(playerId);
        localPlayer.lastSubmittedWinner = winner;
        // When either player requests to start a new game, each player must
        // submit the winner for that game, if any; this is because the logic
        // which analyzes the grid for a winner is client-side, at least for now;
        // to accomplish this, each player's submitted winner will be stored on
        // the respective player object;
        const submittedWinners = room.players.map((player) => player.lastSubmittedWinner);
        // If the local player is the first to request a new game, ask the other
        // player if they'd like to start a new game
        if (!room.game.pendingNewGame) {
          room.game.requestingPlayer = localPlayer;
          room.game.pendingNewGame = true;
          localPlayer.broadcast('request-new-game', {
            status: 'newGameRequested',
            requestingPlayer: room.game.requestingPlayer
          });
          // Inform the local player (who requested the new game) that their
          // request is pending
          fn({ status: 'requestingNewGame', localPlayer });
        } else if (submittedWinners.length === 2 && localPlayer !== room.game.requestingPlayer) {
          // If the other player accepts the original request to play again, start
          // a new game and broadcast the new game state to both players
          room.game.declareWinner();
          // Record winner for the completed game
          if (room.game.dbId) {
            try {
              await db.run(
                `UPDATE games SET winner_id = ?, winner_color = ?, status = 'completed', ended_at = ? WHERE id = ?`,
                room.game.winner ? room.game.winner.id : null,
                room.game.winner ? room.game.winner.color : null,
                Date.now(),
                room.game.dbId
              );
            } catch (e) {
              console.error('DB error recording winner:', e);
            }
          }
          room.game.resetGame();
          room.game.startGame();
          // Record the new game start
          try {
            const newGameId = uuidv4();
            room.game.dbId = newGameId;
            room.game.moveCount = 0;
            await db.run(
              `
              INSERT INTO games (id, room_code, player1_id, player1_name, player1_color, player2_id, player2_name, player2_color, started_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
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
            console.error('DB error recording new game start:', e);
          }
          room.broadcast('start-new-game', {
            status: 'startedGame',
            game: room.game
          });
          fn({ status: 'startedGame', localPlayer });
        }
      })
    );

    // Read-only query events (formerly the GET /api/* REST endpoints); each
    // responds via its Socket.IO acknowledgement callback

    socket.on('list-rooms', (data, fn) => {
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
      fn(rooms);
    });

    socket.on('list-games', async ({ limit, offset } = {}, fn) => {
      const resolvedLimit = Math.min(parseInt(limit) || 50, 200);
      const resolvedOffset = parseInt(offset) || 0;
      const games = await db.all(
        'SELECT * FROM games ORDER BY started_at DESC LIMIT ? OFFSET ?',
        resolvedLimit,
        resolvedOffset
      );
      fn(games);
    });

    socket.on('get-game', async ({ gameId }, fn) => {
      const game = await db.get('SELECT * FROM games WHERE id = ?', gameId);
      if (!game) {
        fn({ error: 'Game not found' });
        return;
      }
      const moves = await db.all(
        'SELECT * FROM game_moves WHERE game_id = ? ORDER BY move_number ASC',
        gameId
      );
      fn({ ...game, moves });
    });

    // Reaction events

    socket.on(
      'send-reaction',
      getRoom(({ playerId, room, reaction }, fn) => {
        const localPlayer = room.getPlayerById(playerId);
        localPlayer.lastReaction = reaction;
        room.broadcast('send-reaction', { reaction, reactingPlayer: localPlayer });
        fn({});
      })
    );

    socket.on('disconnect', async () => {
      console.log(`disconnected: ${socket.id}`);
      // Indicate that this player is now disconnected
      if (socket.player) {
        console.log('unset player socket');
        socket.player.broadcast('player-disconnected', {
          disconnectedPlayer: socket.player
        });
        socket.player.socket = null;
      }
      // As soon as both players disconnect from the room (making it completely
      // empty), mark the room for deletion
      if (socket.room && socket.room.isEmpty()) {
        await roomManager.markRoomAsInactive(socket.room);
      }
    });
  });

  // Allow us to open browser
  if (process.argv.includes('--open') || process.argv.includes('-o')) {
    await open(`http://localhost:${httpServer.address().port}`);
  }
}
createServer();
