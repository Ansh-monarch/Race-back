const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Root route - fixes "Cannot GET /" error
app.get('/', (req, res) => {
  res.json({ 
    message: '🚗 Boost Dash Backend is Running!',
    status: 'Ready for racing',
    endpoints: {
      health: '/health',
      websocket: 'Available on /socket.io'
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'Boost Dash backend is running!' });
});

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Store connected players and active races
const players = new Map();
const activeRaces = new Map();

// Race game class
class RaceGame {
  constructor(roomId, player1Id, player2Id) {
    this.roomId = roomId;
    this.player1 = { id: player1Id, progress: 0, boost: 100, isDrifting: false, username: players.get(player1Id)?.username };
    this.player2 = { id: player2Id, progress: 0, boost: 100, isDrifting: false, username: players.get(player2Id)?.username };
    this.startTime = Date.now();
    this.finished = false;
    this.winner = null;
  }

  handlePlayerAction(playerId, action) {
    const player = this.player1.id === playerId ? this.player1 : this.player2;
    
    switch (action) {
      case 'accelerate':
        player.progress += 2;
        break;
      case 'boost':
        if (player.boost >= 20) {
          player.boost -= 20;
          player.progress += 10;
        }
        break;
      case 'drift-start':
        player.isDrifting = true;
        break;
      case 'drift-end':
        player.isDrifting = false;
        player.boost = Math.min(100, player.boost + 15);
        break;
    }
    
    // Regenerate boost
    if (!player.isDrifting) {
      player.boost = Math.min(100, player.boost + 0.5);
    }
    
    // Check for winner (first to 1000 progress)
    if (player.progress >= 1000 && !this.finished) {
      this.finished = true;
      this.winner = playerId;
      return true; // Race finished
    }
    
    return false; // Race ongoing
  }

  getGameState() {
    return {
      player1: { ...this.player1 },
      player2: { ...this.player2 },
      finished: this.finished,
      winner: this.winner
    };
  }
}

// Socket connection handling
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // Player joins the lobby
  socket.on('join-lobby', (username) => {
    players.set(socket.id, { 
      id: socket.id, 
      username: username || `Player${socket.id.slice(-4)}`
    });
    
    console.log(`${username} joined lobby`);
    
    // Send updated online players list to everyone
    const onlinePlayers = Array.from(players.values()).map(p => ({
      id: p.id,
      username: p.username
    }));
    
    io.emit('online-players', onlinePlayers);
  });

  // Challenge another player
  socket.on('challenge-player', (targetPlayerId) => {
    const challenger = players.get(socket.id);
    const targetPlayer = players.get(targetPlayerId);
    
    if (!challenger || !targetPlayer) {
      socket.emit('error', 'Player not found');
      return;
    }
    
    console.log(`${challenger.username} challenging ${targetPlayer.username}`);
    
    // Send challenge to target player
    io.to(targetPlayerId).emit('challenge-received', {
      challengerId: challenger.id,
      challengerName: challenger.username
    });
    
    socket.emit('challenge-sent', targetPlayer.username);
  });

  // Accept a challenge
  socket.on('accept-challenge', (challengerId) => {
    const acceptor = players.get(socket.id);
    const challenger = players.get(challengerId);
    
    if (!acceptor || !challenger) {
      socket.emit('error', 'Player not available');
      return;
    }
    
    console.log(`Creating race between ${challenger.username} and ${acceptor.username}`);
    
    // Create a new race game
    const raceId = `race_${Date.now()}`;
    const race = new RaceGame(raceId, challenger.id, acceptor.id);
    activeRaces.set(raceId, race);
    
    // Notify both players to start the game
    io.to(challenger.id).to(acceptor.id).emit('race-start', {
      roomId: raceId,
      player1: race.player1,
      player2: race.player2
    });
    
    // Remove from online players list during race
    players.delete(challenger.id);
    players.delete(acceptor.id);
    io.emit('online-players', Array.from(players.values()));
  });

  // Decline a challenge
  socket.on('decline-challenge', (challengerId) => {
    const challenger = players.get(challengerId);
    if (challenger) {
      challenger.socket.emit('challenge-declined');
    }
  });

  // Player action during race
  socket.on('player-action', (data) => {
    const { roomId, action } = data;
    const race = activeRaces.get(roomId);
    
    if (race) {
      const raceFinished = race.handlePlayerAction(socket.id, action);
      const gameState = race.getGameState();
      
      // Send updated game state to both players
      io.to(race.player1.id).to(race.player2.id).emit('game-update', gameState);
      
      // If race finished, clean up after delay
      if (raceFinished) {
        setTimeout(() => {
          activeRaces.delete(roomId);
          // Add players back to lobby
          players.set(race.player1.id, { id: race.player1.id, username: race.player1.username });
          players.set(race.player2.id, { id: race.player2.id, username: race.player2.username });
          io.emit('online-players', Array.from(players.values()));
        }, 5000);
      }
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    const player = players.get(socket.id);
    if (player) {
      console.log(`${player.username} disconnected`);
      players.delete(socket.id);
      io.emit('online-players', Array.from(players.values()));
    }
    
    // Clean up any races this player was in
    for (const [raceId, race] of activeRaces) {
      if (race.player1.id === socket.id || race.player2.id === socket.id) {
        activeRaces.delete(raceId);
        // Notify other player
        const otherPlayerId = race.player1.id === socket.id ? race.player2.id : race.player1.id;
        io.to(otherPlayerId).emit('opponent-disconnected');
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚗 Boost Dash backend running on port ${PORT}`);
  console.log(`🎮 Ready for racing action!`);
});
