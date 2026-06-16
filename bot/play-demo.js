import ConnectFourBot from './connect-four-bot.js';

// Demo: two bots play a full game against each other over Socket.IO, choosing a
// random legal column each turn. Run the app (`pnpm dev`) in another terminal,
// then run `node bot/play-demo.js`. Pass a URL as the first argument to target a
// non-default server, e.g. `node bot/play-demo.js https://example.com`.

const url = process.argv[2] || 'http://localhost:8080';
const MOVE_DELAY_MS = 400;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function randomChoice(items) {
  return items[Math.floor(Math.random() * items.length)];
}

async function main() {
  const bot1 = new ConnectFourBot({ url, name: 'Bot1', color: 'red' });
  const bot2 = new ConnectFourBot({ url, name: 'Bot2', color: 'blue' });

  await Promise.all([bot1.connect(), bot2.connect()]);

  let finished = false;
  let finish;
  const gameOver = new Promise((resolve) => {
    finish = resolve;
  });

  // Have a bot take its turn: pick a random legal column, or end the game if the
  // board is full
  async function takeTurn(bot) {
    if (finished || !bot.myTurn) return;
    const columns = bot.legalColumns;
    if (columns.length === 0) {
      finished = true;
      finish();
      return;
    }
    const column = randomChoice(columns);
    await wait(MOVE_DELAY_MS);
    await bot.placeChip(column);
    console.log(`${bot.name} (${bot.color}) → column ${column + 1}`);
  }

  bot1.onYourTurn(() => takeTurn(bot1));
  bot2.onYourTurn(() => takeTurn(bot2));

  const { roomCode } = await bot1.openRoom();
  console.log(`Room ${roomCode} opened by ${bot1.name}`);
  await bot2.joinRoom(roomCode);
  console.log(`${bot2.name} joined; game started`);

  // Kick off whichever bot the server chose to move first
  await takeTurn(bot1);
  await takeTurn(bot2);

  await gameOver;
  console.log('Board full — game over');

  await bot1.close();
  bot1.disconnect();
  bot2.disconnect();
}

main().catch((err) => {
  console.error('Bot demo failed:', err);
  process.exit(1);
});
