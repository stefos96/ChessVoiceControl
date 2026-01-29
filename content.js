console.log("Chess.com Board State Logger + Vosk Initialized");

const synth = window.speechSynthesis;
let selectedVoice = null;
let boardArray = [];

const EXT_URL = document.currentScript ?
    document.currentScript.src.split('content.js')[0] :
    "";

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
    const boardElement = document.querySelector('wc-chess-board');
    if (!boardElement || !boardElement.game) return;

    console.log("Vosk heard:", text);

    // Normalize text: "bishop to b7" -> "bb7", "knight f3" -> "nf3"
    let cleanText = text.toLowerCase()
        .replace("to", "")
        .replace("two", "2")
        .replace("four", "4")
        .replace("for", "4")
        .replace("eight", "8")
        .replace("night", "n") // Very common mishearing
        .replace(/\s+/g, "");

    const legalMoves = boardElement.game.getLegalMoves();

    // Strategy: Find a move where the lowercase SAN (e.g., 'nf3', 'e4', 'b7')
    // matches the cleaned voice string.
    const matchedMove = legalMoves.find(m => {
        const san = m.san.toLowerCase().replace(/[x+#-]/g, "");
        return san === cleanText || san.includes(cleanText);
    });

    if (matchedMove) {
        console.log("Executing Move:", matchedMove.san);
        boardElement.game.move(matchedMove.san);
    } else {
        console.warn("No legal move match for:", cleanText);
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
            const recognizer = new model.KaldiRecognizer(16000);

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
            const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
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
    const pieceNames = { 'N': 'Knight', 'B': 'Bishop', 'R': 'Rook', 'Q': 'Queen', 'K': 'King' };
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