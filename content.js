console.log("Chess.com Board State Logger Initialized");

const synth = window.speechSynthesis;
let selectedVoice = null;

let boardArray = [];

function loadBestVoice() {
    const voices = window.speechSynthesis.getVoices();

    // Priority list: Look for "Google" first, then "Natural", then any US English
    selectedVoice = voices.find(v => v.name === 'Google US English') ||
        voices.find(v => v.name.includes('Natural')) ||
        voices.find(v => v.lang === 'en-US');

    if (selectedVoice) {
        console.log("Selected Human Voice: " + selectedVoice.name);
    }
}

// Voices are loaded asynchronously, so we must listen for this event
window.speechSynthesis.onvoiceschanged = loadBestVoice;
loadBestVoice(); // Try immediate load too

// Converts FEN to your specific ['bR', 'wP'] format
function fenTo2DArray(fen) {
    const setup = fen.split(' ')[0];
    const ranks = setup.split('/');

    return ranks.map(rank => {
        const row = [];
        for (let char of rank) {
            if (isNaN(char)) {
                // If uppercase, it's White ('w'), if lowercase, it's Black ('b')
                const color = (char === char.toUpperCase()) ? 'w' : 'b';
                const piece = char.toUpperCase();
                row.push(color + piece);
            } else {
                for (let i = 0; i < parseInt(char); i++) {
                    row.push(null);
                }
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

const initInterval = setInterval(() => {
    const boardElement = document.querySelector('wc-chess-board');

    if (boardElement) {
        // Log the element itself to see its properties in the console
        if (boardElement.game) {
            console.log('Success! Game object found.');
            boardElement.game.on('Move', (event) => {
                updateBoard();

                // Chess.com passes a 'data' object with 'san' (e.g., 'Nf3')
                if (event && event.data && event.data.move && event.data.move.san) {
                    const humanMove = translateMoveToSpeech(event.data.move.san);
                    speak(humanMove);
                }
            });
            updateBoard();
            clearInterval(initInterval);
        } else {
            // Some versions of the board use a 'controller' or 'item' wrapper
            const potentialGame = boardElement.controller || boardElement.board;
            if (potentialGame && potentialGame.game) {
                console.log('Found game via controller wrapper');
                // ... handle initialization
            }
            console.log('boardElement found, but .game is still undefined. Waiting...');
        }
    } else {
        console.log('Searching for <wc-chess-board>...');
    }
}, 1000);

function translateMoveToSpeech(san) {
    const pieceNames = { 'N': 'Knight', 'B': 'Bishop', 'R': 'Rook', 'Q': 'Queen', 'K': 'King' };

    if (san === 'O-O') return "Castles kingside";
    if (san === 'O-O-O') return "Castles queenside";

    let speech = "";
    const firstChar = san[0];

    if (pieceNames[firstChar]) {
        speech += pieceNames[firstChar] + " ";
        san = san.substring(1);
    }

    if (san.includes('x')) {
        speech += "takes ";
        san = san.split('x')[1];
    } else if (!pieceNames[firstChar]) {
        // It's a pawn move
        speech += ""; // "e4" sounds better than "Pawn to e4" for fast play
    }

    // Clean up symbols and speak the square
    const targetSquare = san.replace('+', '').replace('#', '');
    speech += targetSquare;

    if (san.includes('#')) speech += ". Checkmate.";
    else if (san.includes('+')) speech += ". Check.";

    return speech;
}

function speak(text) {
    const synth = window.speechSynthesis;
    if (synth.speaking) synth.cancel(); // Stop if user is moving fast

    const utterance = new SpeechSynthesisUtterance(text);

    if (selectedVoice) {
        utterance.voice = selectedVoice;
    }

    // Settings for a "human" feel
    utterance.rate = 1.0;  // 1.0 is normal human speed
    utterance.pitch = 1.0; // 1.0 is natural pitch
    utterance.volume = 1.0;

    synth.speak(utterance);
}