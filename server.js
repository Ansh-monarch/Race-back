const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const GameManager = require('./game/GameManager');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const gameManager = new GameManager();

// Store connected players
const players = new Map();

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'Boost Dash backend is running!' });
});

// Socket connection handling
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // Player joins the lobby
  socket.on('join-lobby', (username) => {
    players.set(socket.id, { 
      id: socket.id, 
      username: username || `Player${socket.id.slice(-4)}`,
      socket: socket 
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
    targetPlayer.socket.emit('challenge-received', {
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
    const race = gameManager.createRace(challenger.id, acceptor.id);
    
    // Notify both players to start the game
    io.to(challenger.id).to(acceptor.id).emit('race-start', {
      roomId: race.roomId,
      opponent: acceptor.username,
      track: race.track
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
    const race = gameManager.getRace(roomId);
    
    if (race && race.isPlayerInRace(socket.id)) {
      race.handlePlayerAction(socket.id, action);
      
      // Send updated game state to both players
      const gameState = race.getGameState();
      io.to(race.player1.id).to(race.player2.id).emit('game-update', gameState);
    }
  });

  // Player finished race
  socket.on('race-finish', (data) => {
    const { roomId, finishTime } = data;
    const race = gameManager.getRace(roomId);
    
    if (race) {
      const result = race.playerFinish(socket.id, finishTime);
      if (result.finished) {
        // Race is over, send final results
        io.to(race.player1.id).to(race.player2.id).emit('race-end', {
          winner: result.winner,
          times: result.times,
          winnerName: players.get(result.winner)?.username || 'Unknown'
        });
        
        // Clean up the race after a delay
        setTimeout(() => {
          gameManager.removeRace(roomId);
        }, 10000);
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
    gameManager.handlePlayerDisconnect(socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚗 Boost Dash backend running on port ${PORT}`);
  console.log(`🎮 Ready for racing action!`);
});
