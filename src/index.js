// UNO Game Server - JavaScript Implementation for Nakama
// This is the main entry point that Nakama will load

// Initialize the module - this is the entry point Nakama calls
function InitModule(ctx, logger, nk, initializer) {
	logger.info("🎮 UNO Game JavaScript module loaded successfully!");

	// Create UNO leaderboard if it doesn't exist
	try {
		nk.leaderboardCreate("uno_leaderboard", false, "desc", "best", {
			title: "UNO Championship",
			description: "Global UNO leaderboard - highest scores win!",
			category: 1,
			duration: 0, // Permanent leaderboard
			join_required: false,
		});
		logger.info("📊 UNO leaderboard created/verified successfully");
	} catch (error) {
		// Leaderboard might already exist, which is fine
		logger.info(
			"📊 UNO leaderboard already exists or creation failed: " + error.message
		);
	}

	// Register RPC functions
	initializer.registerRpc("create_uno_match", createUnoMatch);
	initializer.registerRpc("get_user_stats", getUserStats);

	// Register match handler
	initializer.registerMatch("uno_match", {
		matchInit: matchInit,
		matchJoinAttempt: matchJoinAttempt,
		matchJoin: matchJoin,
		matchLeave: matchLeave,
		matchLoop: matchLoop,
		matchTerminate: matchTerminate,
		matchSignal: matchSignal,
	});

	// Register matchmaker handler
	initializer.registerMatchmakerMatched(matchmakerMatched);

	logger.info("🎯 UNO Game RPCs and match handlers registered successfully");
}

// RPC: Create UNO Match
function createUnoMatch(ctx, logger, nk, payload) {
	var userId = ctx.userId;
	logger.info("Creating UNO match for user: " + userId);

	// Parse payload if it's a string
	logger.info("payload", payload);
	var data = {};
	if (payload && typeof payload === "string") {
		try {
			data = JSON.parse(payload);
		} catch (e) {
			logger.warn("Failed to parse payload: " + e.message);
		}
	} else if (payload && typeof payload === "object") {
		data = payload;
	}

	logger.info("Parsed payload: " + JSON.stringify(data));

	// Create a new match using the registered match handler name
	// This must match the name used in initializer.registerMatch()
	var matchId = nk.matchCreate("uno_match", {
		createdBy: userId,
		maxPlayers: 2,
		minPlayers: 2,
		gameMode: "uno_2p",
	});

	var response = {
		success: true,
		match_id: matchId,
		message: "UNO match created successfully",
	};

	logger.info("UNO match created with ID: " + matchId);
	return JSON.stringify(response);
}

// RPC: Get User Stats
function getUserStats(ctx, logger, nk, payload) {
	var userId = ctx.userId;
	logger.info("Getting stats for user: " + userId);

	// TODO: Implement real stats from database
	var stats = {
		games_played: 0,
		games_won: 0,
		total_score: 0,
		best_score: 0,
	};

	var response = {
		success: true,
		stats: stats,
	};

	return JSON.stringify(response);
}

// Matchmaker handler
function matchmakerMatched(ctx, logger, nk, entries) {
	logger.info("Matchmaker matched " + entries.length + " players");

	// Create a match when users are matched
	var matchId = nk.matchCreate("uno_match", {
		matchmaker: true,
		players: entries.map(function (e) {
			return e.presence.userId;
		}),
	});

	logger.info("Created match from matchmaker: " + matchId);
	return matchId;
}

// Match initialization
function matchInit(ctx, logger, nk, params) {
	logger.info("Initializing UNO match");

	var state = {
		players: {},
		gameStarted: false,
		currentTurn: null,
		deck: [],
		discardPile: [],
		topCard: null,
		direction: 1, // 1 = clockwise, -1 = counterclockwise
		drawCount: 0, // For stacking draw cards
		lastAction: null,
		gamePhase: "waiting", // waiting, playing, finished
		turnStartTime: null, // When current turn started
		turnTimeLimit: 15, // 15 seconds per turn
	};

	var tickRate = 1; // 1 second
	var label = "UNO Game";

	return {
		state: state,
		tickRate: tickRate,
		label: label,
	};
}

// Match join attempt
function matchJoinAttempt(
	ctx,
	logger,
	nk,
	dispatcher,
	tick,
	state,
	presence,
	metadata
) {
	// Allow up to 2 players
	var playerCount = Object.keys(state.players).length;
	if (playerCount >= 2) {
		return {
			state: state,
			accept: false,
			rejectMessage: "Match is full",
		};
	}

	return {
		state: state,
		accept: true,
	};
}

// Match join
function matchJoin(ctx, logger, nk, dispatcher, tick, state, presences) {
	logger.info("Players joining UNO match: " + presences.length);

	for (var i = 0; i < presences.length; i++) {
		var presence = presences[i];

		// Add player to game
		state.players[presence.userId] = {
			userId: presence.userId,
			username: presence.username,
			hand: [],
			ready: false,
			calledUno: false,
			score: 0,
		};

		// Notify all players
		var message = {
			type: "player_joined",
			player_id: presence.userId,
			player_name: presence.username,
			player_count: Object.keys(state.players).length,
		};
		dispatcher.broadcastMessage(1, JSON.stringify(message));
	}

	// Start game if we have 2 players
	var playerCount = Object.keys(state.players).length;
	if (playerCount === 2 && !state.gameStarted) {
		startGame(state, dispatcher, logger);
	}

	return { state: state };
}

// Match leave
function matchLeave(ctx, logger, nk, dispatcher, tick, state, presences) {
	for (var i = 0; i < presences.length; i++) {
		var presence = presences[i];
		delete state.players[presence.userId];

		var message = {
			type: "player_left",
			player_id: presence.userId,
		};
		dispatcher.broadcastMessage(1, JSON.stringify(message));
	}

	// End game if not enough players
	var playerCount = Object.keys(state.players).length;
	if (playerCount < 2 && state.gameStarted) {
		logger.info(
			"🏆 Game ending due to player leaving - calculating final scores"
		);

		// Calculate final scores
		var remainingPlayers = Object.keys(state.players);
		var finalScores = {};

		if (remainingPlayers.length === 1) {
			// One player remains - they win by default
			var winnerId = remainingPlayers[0];
			var winner = state.players[winnerId];

			// Winner gets 100 points (no opponent cards to count)
			finalScores[winnerId] = {
				userId: winnerId,
				username: winner.username,
				score: 100,
				result: "winner",
				reason: "opponent_left",
			};

			logger.info(
				"🏆 Winner by forfeit: " +
					winner.username +
					" (+" +
					finalScores[winnerId].score +
					" points)"
			);
		}

		state.gamePhase = "finished";
		state.finalScores = finalScores;

		var message = {
			type: "game_ended",
			reason: "player_left",
			final_scores: finalScores,
			winner: remainingPlayers.length === 1 ? remainingPlayers[0] : null,
		};

		logger.info(
			"🏆 Broadcasting game end with scores: " + JSON.stringify(finalScores)
		);
		dispatcher.broadcastMessage(1, JSON.stringify(message));
	}

	return { state: state };
}

// Match loop - handles game messages and timer
function matchLoop(ctx, logger, nk, dispatcher, tick, state, messages) {
	// Process incoming messages
	for (var i = 0; i < messages.length; i++) {
		var message = messages[i];
		try {
			// Log raw message data for debugging
			logger.info("🔍 RAW MESSAGE DATA: " + JSON.stringify(message.data));
			logger.info("🔍 MESSAGE DATA TYPE: " + typeof message.data);

			// Convert binary data to string if needed
			var dataString;
			if (typeof message.data === "string") {
				dataString = message.data;
			} else {
				dataString = nk.binaryToString(message.data);
			}
			logger.info("🔍 CONVERTED TO STRING: " + dataString);

			var data = JSON.parse(dataString);
			logger.info("🔍 PARSED JSON: " + JSON.stringify(data));

			var senderId = message.sender.userId;
			logger.info("🔍 SENDER ID: " + senderId);
			logger.info("🔍 MESSAGE TYPE: " + data.type);

			switch (data.type) {
				case "play_card":
					logger.info("🃏 PROCESSING PLAY_CARD: " + JSON.stringify(data.card));
					handlePlayCard(state, dispatcher, senderId, data, logger, nk);
					break;
				case "draw_card":
					logger.info("🎴 PROCESSING DRAW_CARD");
					handleDrawCard(state, dispatcher, senderId, logger);
					break;
				case "call_uno":
					logger.info("🎯 PROCESSING CALL_UNO");
					handleCallUno(state, dispatcher, senderId, logger);
					break;
				case "pass_turn":
					logger.info("⏭️ PROCESSING PASS_TURN");
					handlePassTurn(state, dispatcher, senderId, logger);
					break;
				default:
					logger.warn("❓ UNKNOWN MESSAGE TYPE: " + data.type);
			}
		} catch (error) {
			logger.error("❌ Error processing message: " + error.message);
			logger.error("❌ Raw data: " + JSON.stringify(message.data));
			logger.error("❌ Data type: " + typeof message.data);
		}
	}

	// Handle turn timer (check every second)
	if (
		state.gamePhase === "playing" &&
		state.currentTurn &&
		state.turnStartTime
	) {
		var currentTime = Date.now();
		var timeElapsed = (currentTime - state.turnStartTime) / 1000; // Convert to seconds
		var timeRemaining = state.turnTimeLimit - timeElapsed;

		// Broadcast timer update every second
		if (Math.floor(timeElapsed) !== Math.floor(timeElapsed - 1)) {
			var timerMessage = {
				type: "timer_update",
				current_player: state.currentTurn,
				time_remaining: Math.max(0, Math.ceil(timeRemaining)),
			};
			dispatcher.broadcastMessage(1, JSON.stringify(timerMessage));
		}

		// Auto-play when timer expires
		if (timeElapsed >= state.turnTimeLimit) {
			logger.info(
				"Timer expired for player " + state.currentTurn + ", auto-playing"
			);
			handleAutoPlay(state, dispatcher, logger, nk);
		}
	}

	return { state: state };
}

// Match terminate
function matchTerminate(
	ctx,
	logger,
	nk,
	dispatcher,
	tick,
	state,
	graceSeconds
) {
	logger.info("UNO match terminated");
	return { state: state };
}

// Match signal - handles external signals to the match
function matchSignal(ctx, logger, nk, dispatcher, tick, state, data) {
	logger.info("UNO match received signal");
	return { state: state };
}

// Game logic functions
function startGame(state, dispatcher, logger) {
	logger.info("Starting UNO game");

	// Initialize deck
	state.deck = createDeck();
	logger.info("Created deck with " + state.deck.length + " cards");
	shuffleDeck(state.deck);

	// Deal cards to players
	var playerIds = Object.keys(state.players);
	logger.info("Dealing cards to " + playerIds.length + " players");

	// Initialize hands first - ensure player objects exist
	for (var i = 0; i < playerIds.length; i++) {
		var playerId = playerIds[i];
		if (!state.players[playerId]) {
			logger.error("ERROR: Player object does not exist for " + playerId);
			return;
		}
		state.players[playerId].hand = [];
		logger.info(
			"DEBUG: Initialized hand for " +
				playerId +
				" - hand is now: " +
				JSON.stringify(state.players[playerId].hand)
		);
	}

	// Then deal cards - create new arrays to avoid reference issues
	for (var i = 0; i < playerIds.length; i++) {
		var playerId = playerIds[i];
		logger.info("Dealing 7 cards to player " + playerId);

		// Create a completely new array for this player's hand
		var newHand = [];

		for (var j = 0; j < 7; j++) {
			var card = state.deck.pop();
			newHand.push(card);
			logger.info(
				"Dealt card " +
					(j + 1) +
					" to " +
					playerId +
					": " +
					JSON.stringify(card)
			);
			logger.info("DEBUG: newHand length after push: " + newHand.length);
		}

		// Assign the complete new hand to the player
		state.players[playerId].hand = newHand;

		logger.info(
			"Player " +
				playerId +
				" now has " +
				state.players[playerId].hand.length +
				" cards"
		);
		logger.info(
			"DEBUG: Final hand for " +
				playerId +
				": " +
				JSON.stringify(state.players[playerId].hand)
		);
	}

	// Set first card
	do {
		state.topCard = state.deck.pop();
	} while (
		state.topCard.type === "wild" ||
		state.topCard.type === "wild_draw_four"
	);

	state.discardPile = [state.topCard];

	// Set first player and game state
	state.currentTurn = playerIds[0];
	state.direction = 1; // 1 for clockwise, -1 for counter-clockwise
	state.gameStarted = true;
	state.gamePhase = "playing";
	state.turnStartTime = Date.now(); // Start timer for first player

	// Debug: Check hands before broadcasting
	var playerIds2 = Object.keys(state.players);
	for (var i = 0; i < playerIds2.length; i++) {
		var pid = playerIds2[i];
		logger.info(
			"DEBUG: Before broadcast - Player " +
				pid +
				" has " +
				state.players[pid].hand.length +
				" cards"
		);
		logger.info(
			"DEBUG: Player " +
				pid +
				" hand contents: " +
				JSON.stringify(state.players[pid].hand)
		);
	}

	// Broadcast game state
	broadcastGameState(state, dispatcher, logger);

	var message = {
		type: "game_started",
		message: "UNO game has started!",
	};
	dispatcher.broadcastMessage(1, JSON.stringify(message));
}

function createDeck() {
	var deck = [];
	var colors = ["red", "yellow", "green", "blue"];

	// Number cards (0-9) for each color
	for (var c = 0; c < colors.length; c++) {
		var color = colors[c];

		// One 0 card per color
		deck.push({ color: color, type: "number", value: 0 });

		// Two of each number 1-9 per color
		for (var num = 1; num <= 9; num++) {
			deck.push({ color: color, type: "number", value: num });
			deck.push({ color: color, type: "number", value: num });
		}

		// Two of each action card per color
		var actionTypes = ["skip", "reverse", "draw_two"];
		for (var a = 0; a < actionTypes.length; a++) {
			deck.push({ color: color, type: actionTypes[a], value: null });
			deck.push({ color: color, type: actionTypes[a], value: null });
		}
	}

	// Wild cards (4 of each)
	for (var i = 0; i < 4; i++) {
		deck.push({ color: "wild", type: "wild", value: null });
		deck.push({ color: "wild", type: "wild_draw_four", value: null });
	}

	return deck;
}

function shuffleDeck(deck) {
	for (var i = deck.length - 1; i > 0; i--) {
		var j = Math.floor(Math.random() * (i + 1));
		var temp = deck[i];
		deck[i] = deck[j];
		deck[j] = temp;
	}
}

function broadcastGameState(state, dispatcher, logger) {
	var playerIds = Object.keys(state.players);
	if (logger) {
		logger.info("Broadcasting game state to " + playerIds.length + " players");
		// Debug: Check hands at start of broadcast function
		for (var i = 0; i < playerIds.length; i++) {
			var pid = playerIds[i];
			logger.info(
				"DEBUG: In broadcastGameState - Player " +
					pid +
					" has " +
					state.players[pid].hand.length +
					" cards"
			);
		}
	}

	// Create game state with all player hands
	var gameState = {
		type: "game_state",
		state: {
			players: {},
			current_turn: state.currentTurn,
			top_card: state.topCard,
			direction: state.direction,
			deck_count: state.deck.length,
			game_phase: state.gamePhase,
		},
		player_hands: {}, // All player hands - frontend will filter
	};

	// Add player data and hands
	for (var i = 0; i < playerIds.length; i++) {
		var pid = playerIds[i];
		gameState.state.players[pid] = {
			hand_count: state.players[pid].hand.length,
			username: state.players[pid].username,
			called_uno: state.players[pid].calledUno,
		};
		// Include each player's hand
		gameState.player_hands[pid] = state.players[pid].hand;

		if (logger) {
			logger.info(
				"Player " + pid + " has " + state.players[pid].hand.length + " cards"
			);
		}
	}

	// Send single message to all players
	dispatcher.broadcastMessage(1, JSON.stringify(gameState));

	// Also send individual player hands separately for security
	for (var i = 0; i < playerIds.length; i++) {
		var pid = playerIds[i];
		var playerHandMessage = {
			type: "player_hand",
			player_id: pid,
			hand: state.players[pid].hand,
			playable_cards: getPlayableCards(state, pid, logger),
		};

		// Send to all players using op code 1 (same as other messages)
		dispatcher.broadcastMessage(1, JSON.stringify(playerHandMessage));

		if (logger) {
			logger.info(
				"Sent hand to player " +
					pid +
					": " +
					state.players[pid].hand.length +
					" cards"
			);
		}
	}
}

// Helper function to get playable cards for a player
function getPlayableCards(state, playerId, logger) {
	var playableIndices = [];
	var playerHand = state.players[playerId].hand;
	var topCard = state.topCard;

	if (logger) {
		logger.info("🔍 DEBUG getPlayableCards for player: " + playerId);
		logger.info("  - Top Card: " + JSON.stringify(topCard));
		logger.info("  - Player Hand: " + JSON.stringify(playerHand));
	}

	if (!topCard || !playerHand) {
		if (logger) logger.warn("❌ Missing topCard or playerHand");
		return playableIndices;
	}

	for (var i = 0; i < playerHand.length; i++) {
		var card = playerHand[i];
		var isValid = isValidPlay(card, topCard, logger);
		if (logger) {
			logger.info(
				"  - Card " + i + ": " + JSON.stringify(card) + " -> Valid: " + isValid
			);
		}
		if (isValid) {
			playableIndices.push(i);
		}
	}

	if (logger)
		logger.info(
			"  - Final playable indices: " + JSON.stringify(playableIndices)
		);
	return playableIndices;
}

// Game logic functions
function handlePlayCard(state, dispatcher, playerId, data, logger, nk) {
	logger.info("🃏 ===== HANDLE PLAY CARD START =====");
	logger.info("🃏 Player: " + playerId);
	logger.info("🃏 Card to play: " + JSON.stringify(data.card));
	logger.info("🃏 Current top card: " + JSON.stringify(state.topCard));
	logger.info("🃏 Current turn: " + state.currentTurn);

	// Validate it's the player's turn
	if (state.currentTurn !== playerId) {
		logger.warn("❌ Player " + playerId + " tried to play out of turn");
		logger.warn("❌ Current turn is: " + state.currentTurn);
		return;
	}
	logger.info("✅ Turn validation passed");

	// Validate player has the card
	var playerHand = state.players[playerId].hand;
	logger.info("🃏 Player hand: " + JSON.stringify(playerHand));

	var cardIndex = -1;
	for (var i = 0; i < playerHand.length; i++) {
		logger.info("🔍 Checking card " + i + ": " + JSON.stringify(playerHand[i]));
		if (
			playerHand[i].color === data.card.color &&
			playerHand[i].type === data.card.type &&
			playerHand[i].value === data.card.value
		) {
			cardIndex = i;
			logger.info("✅ Found matching card at index " + i);
			break;
		}
	}

	if (cardIndex === -1) {
		logger.warn(
			"❌ Player " + playerId + " doesn't have the card they're trying to play"
		);
		logger.warn("❌ Requested card: " + JSON.stringify(data.card));
		logger.warn("❌ Player hand: " + JSON.stringify(playerHand));

		// Send error message to player
		var errorMessage = {
			type: "play_card_error",
			error: "card_not_owned",
			message: "You don't have that card in your hand",
		};
		dispatcher.broadcastMessageDeferred(1, JSON.stringify(errorMessage), [
			playerId,
		]);
		return;
	}
	logger.info("✅ Card ownership validation passed");

	// Validate card can be played
	var isValid = isValidPlay(data.card, state.topCard, logger);
	logger.info("🔍 Card validity check: " + isValid);

	if (!isValid) {
		logger.warn("❌ Invalid card play attempt");
		logger.warn("❌ Card: " + JSON.stringify(data.card));
		logger.warn("❌ Top card: " + JSON.stringify(state.topCard));

		// Send error message to player
		var errorMessage = {
			type: "play_card_error",
			error: "invalid_play",
			message: "That card cannot be played on the current top card",
			top_card: state.topCard,
			attempted_card: data.card,
		};
		dispatcher.broadcastMessageDeferred(1, JSON.stringify(errorMessage), [
			playerId,
		]);
		return;
	}
	logger.info("✅ Card validity validation passed");

	// Remove card from player's hand
	var playedCard = playerHand.splice(cardIndex, 1)[0];

	// Update game state
	state.topCard = playedCard;
	state.discardPile.push(playedCard);

	// Check for win condition
	if (playerHand.length === 0) {
		endGame(state, dispatcher, playerId, logger, nk);
		return;
	}

	// Apply card effects and advance turn
	applyCardEffects(state, playedCard, logger);
	advanceTurn(state);

	// Broadcast updated game state
	broadcastGameState(state, dispatcher, logger);

	// Broadcast card played event
	var message = {
		type: "card_played",
		player_id: playerId,
		card: playedCard,
		remaining_cards: playerHand.length,
	};
	dispatcher.broadcastMessage(1, JSON.stringify(message));
}

function handleDrawCard(state, dispatcher, playerId, logger) {
	logger.info("Player " + playerId + " drawing a card");

	// Validate it's the player's turn
	if (state.currentTurn !== playerId) {
		logger.warn("Player " + playerId + " tried to draw out of turn");
		return;
	}

	// Check if deck is empty
	if (state.deck.length === 0) {
		reshuffleDeck(state, logger);
	}

	// Draw card
	var drawnCard = state.deck.pop();
	state.players[playerId].hand.push(drawnCard);

	// Advance turn
	advanceTurn(state);

	// Broadcast updated game state
	broadcastGameState(state, dispatcher, logger);

	// Broadcast card drawn event
	var message = {
		type: "card_drawn",
		player_id: playerId,
		cards_in_hand: state.players[playerId].hand.length,
	};
	dispatcher.broadcastMessage(1, JSON.stringify(message));
}

function handleCallUno(state, dispatcher, playerId, logger) {
	logger.info("Player " + playerId + " called UNO");
	state.players[playerId].calledUno = true;

	var message = {
		type: "player_called_uno",
		player_id: playerId,
		player_name: state.players[playerId].username,
	};
	dispatcher.broadcastMessage(1, JSON.stringify(message));
}

function handlePassTurn(state, dispatcher, playerId, logger) {
	logger.info("Player " + playerId + " passed turn");

	// Validate it's the player's turn
	if (state.currentTurn !== playerId) {
		return;
	}

	advanceTurn(state);
	broadcastGameState(state, dispatcher, logger);
}

// Helper functions
function isValidPlay(card, topCard, logger) {
	if (logger) {
		logger.info("🔍 isValidPlay check:");
		logger.info("  - Card: " + JSON.stringify(card));
		logger.info("  - Top Card: " + JSON.stringify(topCard));
	}

	// Wild cards can always be played
	if (card.type === "wild" || card.type === "wild_draw_four") {
		if (logger) logger.info("  - Result: true (wild card)");
		return true;
	}

	var colorMatch = card.color === topCard.color;
	var valueMatch = card.value === topCard.value;
	var actionMatch = card.type === topCard.type && card.type !== "number";

	if (logger) {
		logger.info(
			"  - Color match (" +
				card.color +
				" === " +
				topCard.color +
				"): " +
				colorMatch
		);
		logger.info(
			"  - Value match (" +
				card.value +
				" === " +
				topCard.value +
				"): " +
				valueMatch
		);
		logger.info(
			"  - Action match (" +
				card.type +
				" === " +
				topCard.type +
				" && " +
				card.type +
				" !== 'number'): " +
				actionMatch
		);
	}

	var result = colorMatch || valueMatch || actionMatch;
	if (logger) logger.info("  - Final result: " + result);

	return result;
}

function advanceTurn(state) {
	var playerIds = Object.keys(state.players);
	var currentIndex = playerIds.indexOf(state.currentTurn);

	if (state.direction === 1) {
		currentIndex = (currentIndex + 1) % playerIds.length;
	} else {
		currentIndex = (currentIndex - 1 + playerIds.length) % playerIds.length;
	}

	state.currentTurn = playerIds[currentIndex];
	state.turnStartTime = Date.now(); // Reset timer for new player
}

// Auto-play function when timer expires
function handleAutoPlay(state, dispatcher, logger, nk) {
	var currentPlayerId = state.currentTurn;
	var playerHand = state.players[currentPlayerId].hand;

	logger.info("Auto-playing for player " + currentPlayerId);

	// Find playable cards
	var playableCards = [];
	for (var i = 0; i < playerHand.length; i++) {
		if (isValidPlay(playerHand[i], state.topCard)) {
			playableCards.push({ card: playerHand[i], index: i });
		}
	}

	if (playableCards.length > 0) {
		// Play the first playable card
		var cardToPlay = playableCards[0];
		logger.info("Auto-playing card: " + JSON.stringify(cardToPlay.card));

		// Remove card from hand
		var playedCard = playerHand.splice(cardToPlay.index, 1)[0];

		// Update game state
		state.topCard = playedCard;
		state.discardPile.push(playedCard);

		// Check for win condition
		if (playerHand.length === 0) {
			endGame(state, dispatcher, currentPlayerId, logger, nk);
			return;
		}

		// Apply card effects and advance turn
		applyCardEffects(state, playedCard, logger);
		advanceTurn(state);

		// Broadcast updated game state
		broadcastGameState(state, dispatcher, logger);

		// Broadcast auto-play event
		var message = {
			type: "auto_play",
			player_id: currentPlayerId,
			card: playedCard,
			remaining_cards: playerHand.length,
		};
		dispatcher.broadcastMessage(1, JSON.stringify(message));
	} else {
		// No playable cards, draw a card
		logger.info(
			"No playable cards, auto-drawing for player " + currentPlayerId
		);

		// Check if deck is empty
		if (state.deck.length === 0) {
			reshuffleDeck(state, logger);
		}

		// Draw card
		var drawnCard = state.deck.pop();
		playerHand.push(drawnCard);

		// Advance turn
		advanceTurn(state);

		// Broadcast updated game state
		broadcastGameState(state, dispatcher, logger);

		// Broadcast auto-draw event
		var message = {
			type: "auto_draw",
			player_id: currentPlayerId,
			cards_in_hand: playerHand.length,
		};
		dispatcher.broadcastMessage(1, JSON.stringify(message));
	}
}

function applyCardEffects(state, card, logger) {
	var playerIds = Object.keys(state.players);
	var currentIndex = playerIds.indexOf(state.currentTurn);

	if (card.type === "skip") {
		// Skip next player
		advanceTurn(state);
		logger.info("Skip card played - next player skipped");
	} else if (card.type === "reverse") {
		// Reverse direction
		state.direction *= -1;
		logger.info("Reverse card played - direction changed");
	} else if (card.type === "draw_two") {
		// Next player draws 2 cards
		advanceTurn(state);
		var nextPlayerId = state.currentTurn;
		for (var i = 0; i < 2; i++) {
			if (state.deck.length > 0) {
				state.players[nextPlayerId].hand.push(state.deck.pop());
			}
		}
		logger.info("Draw Two card played - next player draws 2 cards");
	} else if (card.type === "wild_draw_four") {
		// Next player draws 4 cards
		advanceTurn(state);
		var nextPlayerId = state.currentTurn;
		for (var i = 0; i < 4; i++) {
			if (state.deck.length > 0) {
				state.players[nextPlayerId].hand.push(state.deck.pop());
			}
		}
		logger.info("Wild Draw Four card played - next player draws 4 cards");
	}
}

function reshuffleDeck(state, logger) {
	logger.info("Reshuffling deck");
	// Move discard pile to deck (except top card)
	var topCard = state.discardPile.pop();
	state.deck = state.discardPile.slice();
	state.discardPile = [topCard];
	shuffleDeck(state.deck);
}

function endGame(state, dispatcher, winnerId, logger, nk) {
	logger.info("Game ended - winner: " + winnerId);
	state.gamePhase = "ended";

	// Calculate scores
	var scores = {};
	var finalScores = {};
	var totalOtherCards = 0;
	var playerIds = Object.keys(state.players);

	for (var i = 0; i < playerIds.length; i++) {
		var playerId = playerIds[i];
		var player = state.players[playerId];
		var hand = player.hand;
		var cardValue = 0;

		for (var j = 0; j < hand.length; j++) {
			var card = hand[j];
			if (card.type === "number") {
				cardValue += card.value;
			} else if (
				card.type === "skip" ||
				card.type === "reverse" ||
				card.type === "draw_two"
			) {
				cardValue += 20;
			} else if (card.type === "wild" || card.type === "wild_draw_four") {
				cardValue += 50;
			}
		}

		if (playerId === winnerId) {
			scores[playerId] = 100; // Will add bonus later
		} else {
			scores[playerId] = -cardValue;
			totalOtherCards += cardValue;
		}
	}

	// Add bonus to winner
	scores[winnerId] += totalOtherCards;

	// Create final scores with player info
	for (var i = 0; i < playerIds.length; i++) {
		var playerId = playerIds[i];
		var player = state.players[playerId];
		finalScores[playerId] = {
			userId: playerId,
			username: player.username,
			score: scores[playerId],
			result: playerId === winnerId ? "winner" : "loser",
			reason: "game_completed",
		};
	}

	// Write scores to leaderboard
	if (nk) {
		try {
			logger.info("📊 Writing scores to leaderboard...");
			for (var i = 0; i < playerIds.length; i++) {
				var playerId = playerIds[i];
				var playerScore = scores[playerId];

				// Write to UNO leaderboard
				nk.leaderboardRecordWrite(
					"uno_leaderboard",
					playerId,
					null,
					playerScore,
					0,
					{
						username: state.players[playerId].username,
						game_result: playerId === winnerId ? "win" : "loss",
						opponent_count: playerIds.length - 1,
					}
				);

				logger.info(
					"📊 Leaderboard updated for " +
						state.players[playerId].username +
						": " +
						playerScore +
						" points"
				);
			}
		} catch (error) {
			logger.error("❌ Failed to write to leaderboard: " + error.message);
		}
	}

	state.finalScores = finalScores;

	// Broadcast game over with final scores
	var message = {
		type: "game_ended",
		reason: "game_completed",
		winner_id: winnerId,
		winner_name: state.players[winnerId].username,
		final_scores: finalScores,
		winner: winnerId,
	};

	logger.info(
		"🏆 Broadcasting game end with scores: " + JSON.stringify(finalScores)
	);
	dispatcher.broadcastMessage(1, JSON.stringify(message));
}
