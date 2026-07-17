console.log("Chess.com Board State Logger + Vosk Initialized");

// Guard against multiple injections of this script
if (window.__CHESS_VOICE_INITIALIZED) {
    console.log("Chess Voice already initialized, skipping duplicate initialization");
} else {
    window.__CHESS_VOICE_INITIALIZED = true;
    initializeChessVoice();
}

function initializeChessVoice() {
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
    "side",
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
let settings = {autoConfirm: false, enableTTS: true, enableVoice: true, autoNextPuzzle: false};

// 1. Setup the listener first
window.addEventListener('CHESS_VOICE_SETTINGS', (event) => {
    const newSettings = event.detail;
    if (newSettings.autoConfirm !== undefined) settings.autoConfirm = newSettings.autoConfirm;
    if (newSettings.enableTTS !== undefined) settings.enableTTS = newSettings.enableTTS;
    if (newSettings.autoNextPuzzle !== undefined) settings.autoNextPuzzle = newSettings.autoNextPuzzle;

    if (newSettings.enableVoice !== undefined) {
        settings.enableVoice = newSettings.enableVoice;

        if (!settings.enableVoice) {
            hideHUD();
        } else {
            showHUD();
        }
    }
});

window.addEventListener('TOGGLE_CHESS_POPUP_DOM', () => {
    toggleSettingsPopup();
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
    // If the user toggled voice off in the popup, stop here.
    if (!settings.enableVoice) return;

    const lowerText = text.toLowerCase().trim();
    updateHUD(`${lowerText}`, 'success');

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
        const isKingside = lowerText.includes("kingside")
            || (lowerText.includes("king") && lowerText.includes("side")) || lowerText.includes("short");

        const legalMoves = chessGame.getLegalMoves();
        // O-O is Kingside, O-O-O is Queenside
        const castleMove = legalMoves.find(m =>
            (isQueenside && m.san === "O-O-O") ||
            (isKingside && m.san === "O-O")
        );

        if (castleMove) {
            if (settings.autoConfirm) {
                chessGame.move({...castleMove, userGenerated: true});
            } else {
                pendingMove = castleMove;
                isAwaitingConfirmation = true;
                speak(`Castle ${isQueenside ? "queenside" : "kingside"}?`);
            }

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

            if (settings.enableVoice) {
                console.log("✅ Vosk 0.0.8 is LIVE and listening!");
                updateHUD("System Live - Listening...", 'success');
                updateModelStatus('Ready');
                speak("Voice system ready.");
            }
        } catch (err) {
            console.error("Vosk Initialization Error:", err);
            updateModelStatus('Error');
            // If you still get 'Failed to fetch', use the Blob/Base64 trick from earlier
        }
    };
}

// Helper for detecting if we're in a puzzle
function isPuzzlePage() {
    return !!document.querySelector('.rated-sidebar-clock-and-rating') || window.location.href.includes('/puzzles/');
}

// Trigger next puzzle function - uses the provided function
function triggerNextPuzzle() {
    // Target by the primary green button classes or text content
    const nextButton = document.querySelector('.ui_v5-button-component.ui_v5-button-primary') || 
                       document.querySelector('.puzzles-next-button') ||
                       Array.from(document.querySelectorAll('button')).find(el => el.textContent.includes('Next') || el.textContent.includes('Continue')) || document.querySelector('[aria-label="Next Puzzle"]');

    if (nextButton) {
        nextButton.click();
        console.log("Advancing to next puzzle via auto-advance.");
    } else {
        console.log("Next puzzle button not found on screen.");
    }
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

            // Auto-advance to next puzzle if enabled and puzzle is finished
            if (settings.autoNextPuzzle && isPuzzlePage()) {
                // Check if the game is over or if we need to wait for puzzle completion UI


                setTimeout(() => {
                    // Add a small delay to ensure puzzle completion is registered
                    const redoButton = document.querySelector('[aria-label="Retry"].cc-button-danger');
                    const isPuzzleFalse = redoButton != null;

                    if (isPuzzleFalse) { // Check if button is visible
                        redoButton.click();
                    } else {
                        triggerNextPuzzle();
                    }
                }, 1200);
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

    // Load saved position or use defaults
    const savedPosition = localStorage.getItem('chess-voice-hud-position');
    let defaultTop = '80%', defaultLeft = '50%', defaultTransform = 'translate(-50%, -50%)';
    
    if (savedPosition) {
        const pos = JSON.parse(savedPosition);
        defaultTop = pos.top;
        defaultLeft = pos.left;
        defaultTransform = pos.transform;
    }

    Object.assign(hudElement.style, {
        position: 'fixed',
        top: defaultTop,
        left: defaultLeft,
        padding: '5px 20px',
        backgroundColor: 'rgba(38, 36, 33, 0.95)',
        color: '#bababa',
        borderRadius: '25px',
        fontSize: '16px',
        fontFamily: 'sans-serif',
        zIndex: '10000',
        border: '2px solid #81b64c',
        boxShadow: 'rgba(0, 0, 0, 0.5) 0px 0px 10px 0px',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        userSelect: 'none',
        cursor: 'grab',
        transform: defaultTransform,
        whiteSpace: 'nowrap'
    });

    hudElement.innerHTML = `<span id="hud-icon">🎤</span> <span id="hud-text">Voice System Ready...</span>`;
    document.body.appendChild(hudElement);

    let isDragging = false;
    let shiftX, shiftY;

    hudElement.addEventListener('mousedown', (e) => {
        isDragging = true;
        hudElement.style.cursor = 'grabbing';

        // Get the current position of the element
        const rect = hudElement.getBoundingClientRect();

        // Calculate the mouse position relative to the element's top-left corner
        shiftX = e.clientX - rect.left;
        shiftY = e.clientY - rect.top;
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;

        // Move the element to the new coordinates, removing the transform
        // We use the calculated shift to ensure the mouse stays at the same
        // spot relative to the div throughout the drag
        hudElement.style.left = `${e.clientX - shiftX}px`;
        hudElement.style.top = `${e.clientY - shiftY}px`;
        hudElement.style.transform = 'none';
    });

    document.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        hudElement.style.cursor = 'grab';
        
        // Save the current position to localStorage
        const position = {
            top: hudElement.style.top,
            left: hudElement.style.left,
            transform: hudElement.style.transform
        };
        localStorage.setItem('chess-voice-hud-position', JSON.stringify(position));
    });
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

function hideHUD() {
    if (!hudElement) return;

    hudElement.classList.add('hide');
}

function showHUD() {
    if (!hudElement) return;

    hudElement.classList.remove('hide');
}

// Initialize HUD on load
createSpeechHUD();

// ============================================
// DOM-BASED SETTINGS POPUP
// ============================================

let settingsPopupElement = null;
let modelStatus = 'Loading...';

function createSettingsPopup() {
    const overlay = document.createElement('div');
    overlay.id = 'chess-voice-settings-overlay';
    Object.assign(overlay.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        width: '100%',
        height: '100%',
        backgroundColor: 'rgba(0, 0, 0, 0)',
        zIndex: '20000',
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'flex-start',
        fontFamily: 'sans-serif',
        padding: '20px',
    });

    const popup = document.createElement('div');
    popup.id = 'chess-voice-settings-popup';
    Object.assign(popup.style, {
        backgroundColor: '#262421',
        color: '#bababa',
        borderRadius: '8px',
        padding: '20px',
        width: '300px',
        maxHeight: '80vh',
        overflow: 'hidden',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.8)',
        border: '2px solid #81b64c',
        zIndex: '20001',
        position: 'relative'
    });

    const coffeeUrl = "https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png";
    const queenImg = "https://raw.githubusercontent.com/stefos96/ChessVoiceControl/refs/heads/master/icons/queen.png";

    popup.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
            <h2 style="color: #81b64c; font-size: 16px; margin: 0; border-bottom: none; padding-bottom: 0;">Vocal Chess Settings</h2>
            <button id="chess-voice-close-btn" style="background: none; border: none; color: #81b64c; font-size: 20px; cursor: pointer; padding: 0; width: 30px; height: 30px;">✕</button>
        </div>

        <div style="margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
            <div>Auto-Confirm</div>
            <input type="checkbox" id="settingsAutoConfirm" style="cursor: pointer; accent-color: #81b64c; box-shadow: 0 0 7px 4px #262421;">
        </div>

        <div style="margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
            <div>Enable TTS</div>
            <input type="checkbox" id="settingsEnableTTS" style="cursor: pointer; accent-color: #81b64c; box-shadow: 0 0 7px 4px #262421;">
        </div>

        <div style="margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
            <div>Enable Voice Input</div>
            <input type="checkbox" id="settingsEnableVoice" style="cursor: pointer; accent-color: #81b64c; box-shadow: 0 0 7px 4px #262421;">
        </div>

        <div style="margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
            <div>Auto Next Puzzle</div>
            <input type="checkbox" id="settingsAutoNextPuzzle" style="cursor: pointer; accent-color: #81b64c; box-shadow: 0 0 7px 4px #262421;">
        </div>

        <div style="color: #7f7f7f; font-size: 12px; background: #262421c7; padding: 3px; border-radius: 10px;">Automatically next puzzle if correct and redo if it was wrong</div>

        <details style="background: rgb(49 46 43 / 0.55); border-radius: 4px; margin-top: 15px; border: 1px solid #444;">
            <summary style="padding: 8px; cursor: pointer; color: #81b64c; font-weight: bold; font-size: 13px; outline: none;">Voice Commands Help</summary>
            <div style="padding: 0 10px 10px 10px; font-size: 12px; line-height: 1.6;">
                <b style="color: #fff; display: block; margin-top: 8px; border-bottom: 1px solid #444;">Basic Moves</b>
                <div style="padding-left: 4px; color: #d3d3d3;">"Rook d8", "Knight f3", "e4"</div>

                <b style="color: #fff; display: block; margin-top: 8px; border-bottom: 1px solid #444;">Disambiguation</b>
                <div style="padding-left: 4px; color: #d3d3d3;">"Rook h 1 to g 1"</div>
                <div style="padding-left: 4px; color: #d3d3d3;">"Eight rook to g 1"</div>

                <b style="color: #fff; display: block; margin-top: 8px; border-bottom: 1px solid #444;">Castling</b>
                <div style="padding-left: 4px; color: #d3d3d3;">"Castle kingside" / "Short"</div>
                <div style="padding-left: 4px; color: #d3d3d3;">"Castle queenside" / "Long"</div>

                <b style="color: #fff; display: block; margin-top: 8px; border-bottom: 1px solid #444;">Promotion</b>
                <div style="padding-left: 4px; color: #d3d3d3;">"Promote a 8 queen"</div>
                <div style="padding-left: 4px; color: #d3d3d3;">"Promote b 8 knight"</div>
                <div style="padding-left: 4px; color: #d3d3d3;">"Promote a 8 (queen automatically)"</div>

                <b style="color: #fff; display: block; margin-top: 8px; border-bottom: 1px solid #444;">Confirmation</b>
                <div style="padding-left: 4px; color: #d3d3d3;">"Yes", "Confirm", "No", "Cancel"</div>
            </div>
        </details>

        <div style="font-size: 11px; color: #777; border-top: 1px solid #444; padding-top: 8px; margin-top: 15px;">
            Vosk Model: <span id="settingsModelStatus" style="color:#81b64c;">${modelStatus}</span>
        </div>

        <div style="margin-top: 15px; text-align: center;">
            <a href="https://buymeacoffee.com/stefanoskarakasis" target="_blank" style="text-decoration: none;">
                <img src="${coffeeUrl}" alt="Buy Me A Coffee" style="height: 35px !important; width: 130px !important;">
            </a>
        </div>
        
        <img src="${queenImg}" alt="queen-image" style="height: auto; width: 100%; position: absolute; bottom: 0; right: -40%; z-index: -2;">
    `;

    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    // Close button handler
    document.getElementById('chess-voice-close-btn').addEventListener('click', toggleSettingsPopup);

    // Click outside to close
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) toggleSettingsPopup();
    });

    // Prevent escape key from closing (optional - can be enabled)
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            toggleSettingsPopup();
        }
    });

    settingsPopupElement = overlay;

    // Load and bind settings
    loadSettingsToPopup();
    bindSettingsCheckboxes();
}

function toggleSettingsPopup() {
    if (settingsPopupElement) {
        settingsPopupElement.remove();
        settingsPopupElement = null;
    } else {
        createSettingsPopup();
    }
}

function loadSettingsToPopup() {
    // Rely on the live in-memory settings content.js already maintains
    document.getElementById('settingsAutoConfirm').checked = settings.autoConfirm || false;
    document.getElementById('settingsEnableTTS').checked = settings.enableTTS !== false;
    document.getElementById('settingsEnableVoice').checked = settings.enableVoice !== false;
    document.getElementById('settingsAutoNextPuzzle').checked = settings.autoNextPuzzle || false;

    // Update model status
    const el = document.getElementById('settingsModelStatus');
    if (el) el.textContent = modelStatus;
}

function bindSettingsCheckboxes() {
    const autoConfirm = document.getElementById('settingsAutoConfirm');
    const enableTTS = document.getElementById('settingsEnableTTS');
    const enableVoice = document.getElementById('settingsEnableVoice');
    const autoNextPuzzle = document.getElementById('settingsAutoNextPuzzle');

    autoConfirm.addEventListener('change', () => saveAndNotify('autoConfirm', autoConfirm.checked));
    enableTTS.addEventListener('change', () => saveAndNotify('enableTTS', enableTTS.checked));
    enableVoice.addEventListener('change', () => saveAndNotify('enableVoice', enableVoice.checked));
    autoNextPuzzle.addEventListener('change', () => saveAndNotify('autoNextPuzzle', autoNextPuzzle.checked));
}

// content.js
function saveAndNotify(key, value) {
    // 1. Instantly update local memory so the UI feels snappy
    settings[key] = value;

    // 2. Dispatch a CustomEvent to let bridge.js save it into actual extension storage
    window.dispatchEvent(new CustomEvent('SAVE_CHESS_SETTING', {
        detail: { key: key, value: value }
    }));

    // 3. Fire your existing handler to immediately toggle UI states (like HUD visibility)
    window.dispatchEvent(new CustomEvent('CHESS_VOICE_SETTINGS', {
        detail: { [key]: value }
    }));
}

function updateModelStatus(status) {
    modelStatus = status;
    const el = document.getElementById('settingsModelStatus');
    if (el) el.textContent = status;
}

// Create settings button/icon in HUD area
function addSettingsButton() {
    const btn = document.createElement('button');
    btn.id = 'chess-voice-settings-btn';
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" data-glyph="utility-cogwheel" aria-hidden="true" viewBox="0 0 24 24"><path fill="#73a045" d="M9.57,20.53 l-1.17,1.27 c-0.37,0.4,-0.67,0.43,-1.13,0.17 l-1.53,-0.87 c-0.47,-0.27,-0.57,-0.57,-0.43,-1.07 l0.53,-1.67 c0.13,-0.5,0.1,-0.87,-0.17,-1.33 l-1.17,-2.07 c-0.27,-0.47,-0.57,-0.67,-1.07,-0.8 l-1.73,-0.4 c-0.5,-0.13,-0.7,-0.37,-0.7,-0.9 l0,-1.77 c0,-0.5,0.2,-0.73,0.7,-0.87 l1.73,-0.4 c0.5,-0.13,0.8,-0.33,1.07,-0.8 l1.17,-2.07 c0.27,-0.47,0.3,-0.83,0.17,-1.33 l-0.53,-1.67 c-0.13,-0.5,-0.03,-0.8,0.43,-1.07 l1.53,-0.87 c0.47,-0.27,0.77,-0.23,1.13,0.17 l1.17,1.27 c0.37,0.4,0.7,0.53,1.23,0.53 l2.43,0 c0.5,0,0.83,-0.13,1.2,-0.53 l1.17,-1.27 c0.37,-0.4,0.67,-0.43,1.13,-0.17 l1.53,0.87 c0.47,0.27,0.57,0.57,0.43,1.07 l-0.53,1.67 c-0.13,0.5,-0.1,0.87,0.17,1.33 l1.17,2.07 c0.27,0.47,0.57,0.67,1.07,0.8 l1.73,0.4 c0.5,0.13,0.7,0.37,0.7,0.87 l0,1.77 c0,0.53,-0.2,0.77,-0.7,0.9 l-1.73,0.4 c-0.5,0.13,-0.8,0.33,-1.07,0.8 l-1.17,2.07 c-0.27,0.47,-0.3,0.83,-0.17,1.33 l0.53,1.67 c0.13,0.5,0.03,0.8,-0.43,1.07 l-1.53,0.87 c-0.47,0.27,-0.77,0.23,-1.13,-0.17 l-1.17,-1.27 c-0.37,-0.4,-0.7,-0.53,-1.2,-0.53 l-2.43,0 c-0.53,0,-0.87,0.13,-1.23,0.53 Z M12.03,15.5 c1.9,0,3.5,-1.57,3.5,-3.53 c0,-1.9,-1.6,-3.47,-3.5,-3.47 c-1.93,0,-3.5,1.57,-3.5,3.47 c0,1.97,1.57,3.53,3.5,3.53 Z M12.03,15.5"></path></svg>';
    Object.assign(btn.style, {
        width: '25px',
        height: '25px',
        borderRadius: '50%',
        border: 'none',
        color: '#262421',
        fontSize: '15px',
        cursor: 'pointer',
        transition: 'all 0.1s',
        zIndex: '10001',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        background: '#101010'
    });

    btn.addEventListener('mouseover', () => btn.style.transform = 'scale(.9)');
    btn.addEventListener('mouseout', () => btn.style.transform = 'scale(1)');
    btn.addEventListener('click', toggleSettingsPopup);

    const voiceHud = document.querySelector('#chess-voice-hud');

    if (voiceHud) {
        voiceHud.appendChild(btn);
    }
}

// Keyboard shortcut: Alt + S to toggle settings
document.addEventListener('keydown', (e) => {
    if ((e.altKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        toggleSettingsPopup();
    }
});

// Add settings button when page loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addSettingsButton);
} else {
    addSettingsButton();
}
}