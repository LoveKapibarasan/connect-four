import io from 'socket.io-client';

// A single shared socket used for one-shot, read-only query events (room list,
// game history, replay data). These pages don't need the full Session lifecycle
// used by live gameplay; they just emit an event and await the server's
// acknowledgement. The connection is created lazily on first use and reused.
let socket = null;

function getSocket() {
  if (!socket) {
    socket = io.connect(window.location.origin);
  }
  return socket;
}

// Emit a query event and resolve with the server's acknowledgement payload.
// Rejects if the server responds with an `error` field.
export default function query(eventName, data = {}) {
  return new Promise((resolve, reject) => {
    getSocket().emit(eventName, data, (response = {}) => {
      if (response && response.error) {
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
    });
  });
}
