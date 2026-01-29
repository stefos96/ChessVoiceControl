console.log("Chess.com Board State Logger + Vosk Initialized");

const synth = window.speechSynthesis;
let selectedVoice = null;
let boardArray = [];

let isAwaitingConfirmation = false;
let pendingMove = null;

let chessGame = null; // Placeholder for the chess game object

const chessGrammar = [
    "a", "b", "c", "d", "e", "f", "g", "h",
    "one", "two", "three", "four", "five", "six", "seven", "eight",
    "1", "2", "3", "4", "5", "6", "7", "8",
    "pawn", "knight", "bishop", "rook", "queen", "king", "horse",
    "takes", "capture", "to", "castles", "kingside", "queenside",
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

const phoneticMap = {
    "do": "d",
    "the": "d",
    "de": "d",
    "day": "d",
    "three": "3",
    "tree": "3",
    "to": "2",
    "two": "2",
    "too": "2",
    "for": "4",
    "four": "4",
    "ate": "8",
    "eight": "8",
    "see": "c",
    "sea": "c",
    "be": "b",
    "bee": "b",
    "alpha": "a",
    "bravo": "b",
    "delta": "d",
    "echo": "e"
};

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
    if (synth.speaking) synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    if (selectedVoice) utterance.voice = selectedVoice;
    utterance.rate = 1.1;
    synth.speak(utterance);
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
        console.log("Current Board State:");
        console.table(boardArray);
    }
}

// 3. VOSK VOICE COMMAND PROCESSING
function handleVoiceCommand(text) {
    console.log("🎤 Vosk heard:", text);
    const lowerText = text.toLowerCase().trim();

    // --- State: Confirmation ---
    if (isAwaitingConfirmation) {
        if (lowerText.includes("yes") || lowerText.includes("confirm")) {
            // 1. Execute the logical move
            chessGame.move(pendingMove);
            chessGame.moveForward();

            speak("Confirmed.");
            isAwaitingConfirmation = false;
            pendingMove = null;
        } else if (lowerText.includes("no") || lowerText.includes("cancel")) {
            speak("Cancelled.");
            isAwaitingConfirmation = false;
            pendingMove = null;
        }
        return;
    }

    // --- State: Parsing New Move ---
    const parsed = parseVoiceMove(text);
    if (!parsed) return;

    // Get legal moves from Chess.com's engine
    // (Ensure your 'game' object/controller is accessible here)
    const legalMoves = chessGame.getLegalMoves();

    let matches = [];
    if (parsed.fromFile !== "") {
        matches = legalMoves.filter(m =>
            m.to === parsed.targetSquare &&
            (parsed.piece === "" || m.piece === parsed.piece) &&
            m.from.charAt(0) === parsed.fromFile
        );
    } else {
        // Filter moves by the target square and piece type
        matches = legalMoves.filter(m =>
            m.to === parsed.targetSquare &&
            (parsed.piece === "" || m.piece === parsed.piece)
        );
    }


    if (matches.length === 1) {
        pendingMove = matches[0];
        isAwaitingConfirmation = true;
        speak(`Move ${getPieceName(parsed.piece)} to ${parsed.targetSquare}? Say yes or no.`);
    } else if (matches.length > 1) {
        speak("Multiple pieces can move there. Please specify which one.");
    } else {
        console.log("❌ No legal move match for:", parsed.targetSquare);
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
    console.log('0. Raw input:', raw);

    // 1. Replace word-numbers (six -> 6)
    Object.keys(numberMap).forEach(word => {
        const regex = new RegExp(`\\b${word}\\b`, 'g');
        raw = raw.replace(regex, numberMap[word]);
    });

    // 3. Replace phonetic letters (alpha -> a)
    Object.keys(alphaMap).forEach(word => {
        const regex = new RegExp(`\\b${word}\\b`, 'g');
        raw = raw.replace(regex, alphaMap[word]);
    });

    // 4. Remove "noise" and spaces
    // We keep letters and numbers only
    let condensed = raw.replace(/move|the|to|piece|square|takes|\s/g, "");

    // 2. THE FIX: Handle the "8" vs "H" ambiguity
    // If we see an '8' followed by a number (e.g., '83'),
    // it's actually the H-file (e.g., 'h3').
    condensed = condensed.replace(/8(?=[1-8])/g, 'h');

    console.log('1. Condensed input:', condensed);

    // 5. Extract Destination (Matches a letter followed by a digit)
    const match = condensed.match(/[a-h][1-8]/);
    if (!match) {
        console.log("❌ No coordinate found in:", condensed);
        return null;
    }

    const fileRegex = condensed.match(/^([a-h])(?=pawn|knight|bishop|rook|queen|king|horse)/i);
    const fromFile = fileRegex ? fileRegex[1] : "";
    console.log('2. fromFile:', fromFile);

    let targetSquare = match[0];
    console.log('✅ Found targetSquare:', targetSquare);

    // 5. Extract Piece
    let piece = ""; // Default to pawn
    if (condensed.includes("knight") || condensed.includes("night") || condensed.includes("horse")) piece = "N";
    else if (condensed.includes("bishop")) piece = "B";
    else if (condensed.includes("rook") || condensed.includes("tower")) piece = "R";
    else if (condensed.includes("queen")) piece = "Q";
    else if (condensed.includes("king")) piece = "K";
    else if (condensed.includes("pawn")) piece = "P";

    piece = piece.toLowerCase();
    targetSquare = targetSquare.toLowerCase();

    return {piece, targetSquare, fromFile};
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