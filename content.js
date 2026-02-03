console.log("Chess.com Board State Logger + Vosk Initialized");

const synth = window.speechSynthesis;
let selectedVoice = null;
let boardArray = [];

let isAwaitingConfirmation = false;
let pendingMove = null;

let chessGame = null; // Placeholder for the chess game object

let hudElement = null;

const chessGrammar = [
    "a", "b", "c", "d", "e", "f", "g", "h",
    "one", "two", "three", "four", "five", "six", "seven", "eight",
    "1", "2", "3", "4", "5", "6", "7", "8",
    "pawn", "knight", "bishop", "rook", "queen", "king", "horse",
    "takes", "capture", "to", "castles", "castle", "kingside", "queenside",
    "short", "long", "promote",
    "yes", "no", "confirm", "cancel", "[unk]" // [unk] handles unknown noise
];

const numberMap = {
    "one": "1", "won": "1",
    "two": "2", "too": "2", "to": "2",
    "three": "3", "tree": "3",
    "four": "4", "for": "4",
    "five": "5",
    "six": "6", "sex": "6",
    "seven": "7",
    "eight": "8", "ate": "8"
};

const alphaMap = {
    "alpha": "a", "bravo": "b", "charlie": "c", "delta": "d", "echo": "e", "foxtrot": "f", "golf": "g", "hotel": "h",
    "see": "c", "sea": "c", "be": "b", "bee": "b", "day": "d", "do": "d"
};

// content.js (MAIN)
let settings = {autoConfirm: false, enableTTS: true};

// 1. Setup the listener first
window.addEventListener('CHESS_VOICE_SETTINGS', (event) => {
    const newSettings = event.detail;
    if (newSettings.autoConfirm !== undefined) settings.autoConfirm = newSettings.autoConfirm;
    if (newSettings.enableTTS !== undefined) settings.enableTTS = newSettings.enableTTS;
});

// 2. Immediate request for settings
window.dispatchEvent(new CustomEvent('REQUEST_CHESS_SETTINGS'));

// 3. Backup request after 500ms (to ensure bridge.js is awake)
setTimeout(() => {
    window.dispatchEvent(new CustomEvent('REQUEST_CHESS_SETTINGS'));
}, 500);

// 1. VOICE SYNTHESIS SETUP
function loadBestVoice() {
    const voices = window.speechSynthesis.getVoices();
    selectedVoice = voices.find(v => v.name === 'Google US English') ||
        voices.find(v => v.name.includes('Natural')) ||
        voices.find(v => v.lang === 'en-US');
}

window.speechSynthesis.onvoiceschanged = loadBestVoice;
loadBestVoice();

function speak(text) {
    if (settings.enableTTS) {
        if (synth.speaking) synth.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        if (selectedVoice) utterance.voice = selectedVoice;
        utterance.rate = 1.1;
        synth.speak(utterance);
    }
}

// 2. BOARD LOGIC
function fenTo2DArray(fen) {
    const setup = fen.split(' ')[0];
    const ranks = setup.split('/');
    return ranks.map(rank => {
        const row = [];
        for (let char of rank) {
            if (isNaN(char)) {
                const color = (char === char.toUpperCase()) ? 'w' : 'b';
                row.push(color + char.toUpperCase());
            } else {
                for (let i = 0; i < parseInt(char); i++) row.push(null);
            }
        }
        return row;
    });
}

function updateBoard() {
    const boardElement = document.querySelector('wc-chess-board');
    if (boardElement && boardElement.game) {
        const fen = boardElement.game.getFEN();
        boardArray = fenTo2DArray(fen);
    }
}

// 3. VOSK VOICE COMMAND PROCESSING
function handleVoiceCommand(text) {
    const lowerText = text.toLowerCase().trim();

    // --- State: Confirmation ---
    if (isAwaitingConfirmation) {
        if (lowerText.includes("yes") || lowerText.includes("confirm")) {
            // 1. Execute the logical move
            chessGame.move({...pendingMove, userGenerated: true});
            chessGame.moveForward();

            updateHUD("Move Confirmed!", 'success');

            speak("Confirmed.");
            isAwaitingConfirmation = false;
            pendingMove = null;
        } else if (lowerText.includes("no") || lowerText.includes("cancel")) {
            speak("Cancelled.");

            updateHUD("Move Cancelled.", 'error');

            isAwaitingConfirmation = false;
            pendingMove = null;
        }
        return;
    }

    // --- NEW: Castling Logic ---
    if (lowerText.includes("castle") || lowerText.includes("castles")) {
        const isQueenside = lowerText.includes("queenside") || lowerText.includes("long");
        const isKingside = lowerText.includes("kingside") || lowerText.includes("short");

        const legalMoves = chessGame.getLegalMoves();
        // O-O is Kingside, O-O-O is Queenside
        const castleMove = legalMoves.find(m =>
            (isQueenside && m.san === "O-O-O") ||
            (isKingside && m.san === "O-O")
        );

        if (castleMove) {
            pendingMove = castleMove;
            isAwaitingConfirmation = true;
            speak(`Castle ${isQueenside ? "queenside" : "kingside"}?`);
            return; // Exit so we don't run normal parsing
        } else {
            speak("Castling is not legal in this position.");
            return;
        }
    }

    // --- State: Parsing New Move ---
    const parsed = parseVoiceMove(text);
    if (!parsed) return;

    updateHUD(`${parsed?.fromFile + getPieceName(parsed.piece)} to ${parsed.targetSquare} ${parsed.promotion != null ? parsed.promotion : ''}`, 'success');

    // Get legal moves from Chess.com's engine
    // (Ensure your 'game' object/controller is accessible here)
    const legalMoves = chessGame.getLegalMoves();

    const matches = legalMoves.filter(m => {
        const matchTarget = m.to === parsed.targetSquare;
        const matchPiece = (m.piece === parsed.piece); // Pawn moves are 'p'
        const matchPromotion = parsed.promotion ? (m.promotion === parsed.promotion) : !m.promotion;

        let matchSource = true;
        if (parsed.fromSquare) {
            matchSource = m.from === parsed.fromSquare;
        } else if (parsed.fromFile) {
            matchSource = m.from.startsWith(parsed.fromFile);
        }

        return matchTarget && matchPiece && matchPromotion && matchSource;
    });

    const moveStr = `${parsed.fromSquare || parsed.fromFile || ""} ${getPieceName(parsed.piece)} to ${parsed.targetSquare}`;

    if (matches.length === 1) {
        pendingMove = matches[0];

        if (settings.autoConfirm) {
            chessGame.move({...pendingMove, userGenerated: true});
            chessGame.moveForward();
            speak("Moving.");
            updateHUD(`Moving: ${moveStr}`, 'success');
        } else {
            isAwaitingConfirmation = true;
            updateHUD(`Confirm: ${moveStr}?`, 'parsing');
            speak(`Move ${getPieceName(parsed.piece)} to ${parsed.targetSquare}?`);
        }
    } else if (matches.length > 1) {
        updateHUD("Ambiguous: Multiple pieces can move there!", 'error');
        speak("Two of your pieces can move there. Please specify which one, for example, say Rook h 1 to g 1.");
    } else {
        updateHUD("Illegal Move", 'error');
    }
}

async function initVosk() {
    const basePath = document.documentElement.getAttribute('data-ext-path');
    if (!basePath) return;

    const script = document.createElement('script');
    script.src = basePath + "lib/vosk.js";
    document.head.appendChild(script);

    script.onload = async () => {
        try {
            const modelPath = basePath + "models/vosk-model-small-en-us-0.15.zip";
            console.log("🛠️ Loading Vosk Model...");

            const model = await Vosk.createModel(modelPath);
            // 0.0.8 requires the sample rate (16000) here
            const recognizer = new model.KaldiRecognizer(16000, JSON.stringify(chessGrammar));

            // 1. Get the Microphone
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    channelCount: 1,
                    sampleRate: 16000,
                },
            });

            // 2. Setup the Audio Context
            // We force 16000Hz to match the Vosk model's requirement
            const audioContext = new (window.AudioContext || window.webkitAudioContext)({sampleRate: 16000});
            const source = audioContext.createMediaStreamSource(stream);

            // 3. Create a Processor Node (The bridge to Vosk)
            // Buffer size 4096, 1 input channel, 1 output channel
            const recognizerNode = audioContext.createScriptProcessor(4096, 1, 1);

            recognizerNode.onaudioprocess = (event) => {
                try {
                    // Send the audio buffer directly to the recognizer
                    recognizer.acceptWaveform(event.inputBuffer);
                } catch (error) {
                    console.error('Vosk Processing Error:', error);
                }
            };

            // 4. Connect the chain
            // Mic -> RecognizerNode -> Destination (Muted output)
            source.connect(recognizerNode);
            recognizerNode.connect(audioContext.destination);

            // 5. Handle Recognition Results
            recognizer.on("result", (message) => {
                if (message.result && message.result.text) {
                    handleVoiceCommand(message.result.text);
                }
            });

            console.log("✅ Vosk 0.0.8 is LIVE and listening!");
            updateHUD("System Live - Listening...", 'success');
            speak("Voice system ready.");

        } catch (err) {
            console.error("Vosk Initialization Error:", err);
            // If you still get 'Failed to fetch', use the Blob/Base64 trick from earlier
        }
    };
}

// 5. MAIN BOOTSTRAP
const initInterval = setInterval(() => {
    const boardElement = document.querySelector('wc-chess-board');

    if (boardElement && boardElement.game) {
        console.log('Success! Game object found.');

        chessGame = boardElement.game;

        boardElement.game.on('Move', (event) => {
            updateBoard();
            // Handle TTS for opponent/own moves
            if (event?.data?.move?.san) {
                speak(translateMoveToSpeech(event.data.move.san));
            }
        });

        updateBoard();
        initVosk(); // Start Vosk instead of the native API
        clearInterval(initInterval);
    }
}, 1000);

// Helper for TTS
function translateMoveToSpeech(san) {
    const pieceNames = {'N': 'Knight', 'B': 'Bishop', 'R': 'Rook', 'Q': 'Queen', 'K': 'King'};
    if (san === 'O-O') return "Castles kingside";
    if (san === 'O-O-O') return "Castles queenside";

    let speech = "";
    if (pieceNames[san[0]]) {
        speech += pieceNames[san[0]] + " ";
        san = san.substring(1);
    }
    if (san.includes('x')) {
        speech += "takes ";
        san = san.split('x')[1];
    }
    speech += san.replace(/[+#]/g, "");
    return speech;
}

function parseVoiceMove(text) {
    let raw = text.toLowerCase().trim();

    // 1. Map words to numbers/letters
    Object.keys(numberMap).forEach(word => {
        raw = raw.replace(new RegExp(`\\b${word}\\b`, 'g'), numberMap[word]);
    });
    Object.keys(alphaMap).forEach(word => {
        raw = raw.replace(new RegExp(`\\b${word}\\b`, 'g'), alphaMap[word]);
    });

    const isPromotion = raw.includes("promote");

    // 2. Cleanup noise but keep letters/numbers together
    let condensed = raw.replace(/\b(move|the|to|piece|square|takes|castle|castles|promote)\b/g, "");
    condensed = condensed.replace(/\s+/g, "");

    // If we see an '8' followed by a number (e.g., '83'),
    // it's actually the H-file (e.g., 'h3').
    condensed = condensed.replace(/8(?=[1-8])/g, 'h');
    condensed = condensed.replaceAll(" ", "");

    // 3. Coordinate Extraction (e.g., "a8", "b1b4")
    // We do this BEFORE the H-fix to protect valid ranks like a8
    const coordMatches = condensed.match(/[a-h][1-8]/g);

    let fromSquare = null;
    let targetSquare = null;

    if (coordMatches && coordMatches.length >= 2) {
        fromSquare = coordMatches[0];
        targetSquare = coordMatches[1];
    } else if (coordMatches && coordMatches.length === 1) {
        targetSquare = coordMatches[0];
    }

    let fromFile = "";
    if (!fromSquare) {
        // Look for a standalone file letter for disambiguation (e.g., "a pawn to a8")
        const fileMatch = raw.match(/\b([a-h])\b/);
        if (fileMatch && (!targetSquare || fileMatch[1] !== targetSquare[0])) {
            fromFile = fileMatch[1];
        }
    }

    // 5. Piece Selection
    let piece = "p"; // Default to pawn

    // CRITICAL FIX: If it's a promotion, the moving piece MUST be a pawn.
    // We only look for other pieces if 'promote' was NOT said.
    if (!isPromotion) {
        if (raw.match(/\b(knight|night|horse)\b/)) piece = "n";
        else if (raw.includes("bishop")) piece = "b";
        else if (raw.includes("rook") || raw.includes("tower")) piece = "r";
        else if (raw.includes("queen")) piece = "q";
        else if (raw.includes("king")) piece = "k";
    }

    // 6. Promotion Piece Detection
    let promotion = null;
    if (isPromotion) {
        if (raw.includes("queen")) promotion = "q";
        else if (raw.includes("knight") || raw.includes("horse")) promotion = "n";
        else if (raw.includes("rook")) promotion = "r";
        else if (raw.includes("bishop")) promotion = "b";
        else promotion = "q"; // Standard default
    }

    if (!targetSquare) return null;

    return {
        piece: piece.toLowerCase(),
        targetSquare: targetSquare.toLowerCase(),
        fromSquare: fromSquare,
        fromFile: fromFile,
        promotion: promotion
    };
}

/**
 * Converts chess shorthand (N, B, R, Q, K) to full names.
 * @param {string} symbol - The piece symbol (e.g., 'n', 'N', 'b', or '')
 * @returns {string} The full piece name.
 */
function getPieceName(symbol) {
    // 1. Clean the input: lowercase it and take just the first character
    const char = symbol ? symbol.toLowerCase().trim().charAt(0) : 'p';

    const pieceMap = {
        'n': 'knight',
        'b': 'bishop',
        'r': 'rook',
        'q': 'queen',
        'k': 'king',
        'p': 'pawn'
    };

    // 2. Return the name, defaulting to 'pawn' if the symbol is empty or unknown
    return pieceMap[char] || 'pawn';
}

function createSpeechHUD() {
    hudElement = document.createElement('div');
    hudElement.id = 'chess-voice-hud';

    // Styling the bubble to match Chess.com's dark theme
    Object.assign(hudElement.style, {
        position: 'fixed',
        bottom: '20px',
        left: '50%',
        transform: 'translateX(-50%)',
        padding: '12px 20px',
        backgroundColor: 'rgba(38, 36, 33, 0.95)',
        color: '#bababa',
        borderRadius: '25px',
        fontSize: '16px',
        fontFamily: 'sans-serif',
        zIndex: '10000',
        border: '2px solid #81b64c',
        boxShadow: '0 4px 15px rgba(0,0,0,0.5)',
        transition: 'all 0.3s ease',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        pointerEvents: 'none'
    });

    hudElement.innerHTML = `<span id="hud-icon">🎤</span> <span id="hud-text">Voice System Ready...</span>`;
    document.body.appendChild(hudElement);
}

function updateHUD(text, type = 'neutral') {
    if (!hudElement) createSpeechHUD();
    const textEl = document.getElementById('hud-text');

    textEl.innerText = text;

    // Visual feedback colors
    if (type === 'success') hudElement.style.borderColor = '#81b64c'; // Green
    if (type === 'error') hudElement.style.borderColor = '#fa4343';   // Red
    if (type === 'parsing') hudElement.style.borderColor = '#ffaa00'; // Orange
}

// Initialize HUD on load
createSpeechHUD();