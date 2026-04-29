import m from 'mithril';

class RoomListComponent {
  oninit() {
    this.rooms = [];
    this.loading = true;
    this.error = null;
    this.pollInterval = setInterval(() => this.loadRooms(), 5000);
    this.loadRooms();
  }

  onremove() {
    clearInterval(this.pollInterval);
  }

  loadRooms() {
    m.request({ method: 'GET', url: '/api/rooms' })
      .then((rooms) => {
        this.rooms = rooms;
        this.loading = false;
        this.error = null;
      })
      .catch(() => {
        this.error = 'Failed to load rooms.';
        this.loading = false;
      });
  }

  view() {
    return (
      <div id="room-list">
        <h1>Connect Four</h1>
        <h2>Active Rooms</h2>
        {this.loading ? (
          <p className="room-list-message">Loading rooms...</p>
        ) : this.error ? (
          <p className="room-list-message room-list-error">{this.error}</p>
        ) : this.rooms.length === 0 ? (
          <p className="room-list-message">No rooms available yet.</p>
        ) : (
          <div className="room-list-grid">
            {this.rooms.map((room) => (
              <div className="room-card" key={room.code}>
                <div className="room-card-code">{room.code}</div>
                <div className="room-card-players">
                  {room.players.map((p, i) => (
                    <span key={i} className={`room-card-player ${p.color}`}>
                      {p.name || '?'}
                    </span>
                  ))}
                  {room.playerCount < 2 && (
                    <span className="room-card-player empty">Waiting…</span>
                  )}
                </div>
                <div
                  className={`room-card-status ${room.status === 'inProgress' ? 'in-progress' : room.status === 'finished' ? 'finished' : 'waiting'}`}
                >
                  {room.status === 'inProgress'
                    ? 'In Progress'
                    : room.status === 'finished'
                      ? 'Finished'
                      : 'Waiting for Player'}
                </div>
                <a className="room-card-action" href={`/room/${room.code}`}>
                  {room.status === 'waitingForPlayers' ? 'Join' : 'Watch'}
                </a>
              </div>
            ))}
          </div>
        )}
        <div className="room-list-footer">
          <button onclick={() => this.loadRooms()} disabled={this.loading}>
            Refresh
          </button>
          <a href="/history">Game History</a>
          <a href="/">Home</a>
        </div>
      </div>
    );
  }
}

export default RoomListComponent;
