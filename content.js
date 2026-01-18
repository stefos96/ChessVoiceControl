// ==========================
// content.js
// ==========================

let floatingDiv;
let recognition;
let autoResumeTimer = null;
let manualStop = false; // when true, do not auto-restart recognition

// Vocabulary
const SPECIAL_COMMANDS = [
    'clear',
    'castle kingside', 'castle queenside', 'castle short', 'castle long', 'short castle', 'long castle',
    'o-o', 'o-o-o',
    'resign', 'resign game', 'offer draw', 'offer a draw', 'accept draw', 'accept the draw', 'decline draw', 'takeback', 'undo'
];

// ==========================
// Helper Functions
// ==========================

// Reset floating window input
function resetInput() {
    if (!floatingDiv) return;
    // Preserve the last user's transcript in #voiceText; only clear the notation
    const chessNotation = floatingDiv.querySelector('#chessNotation');
    if (chessNotation) chessNotation.textContent = '';
}

// Clear both the transcript and notation in the floating UI
function clearUI() {
    if (!floatingDiv) return;
    const voiceText = floatingDiv.querySelector('#voiceText');
    const chessNotation = floatingDiv.querySelector('#chessNotation');
    if (voiceText) voiceText.textContent = '';
    if (chessNotation) chessNotation.textContent = '';
}

function cancelAutoTimer() {
    if (autoResumeTimer) {
        clearTimeout(autoResumeTimer);
        autoResumeTimer = null;
    }
}

// Clear UI and immediately expect a new voice input (restart recognition unless the user stopped it)
function clearAndRestart() {
    try {
        // Cancel any pending auto-restart timer and clear visible UI
        cancelAutoTimer();
        clearUI();

        // If user explicitly stopped recording, don't auto-restart
        if (manualStop) return;

        // Update UI to show we're waiting for new input
        if (floatingDiv) {
            const voiceText = floatingDiv.querySelector('#voiceText');
            if (voiceText) voiceText.textContent = 'Listening...';
            const chessNotation = floatingDiv.querySelector('#chessNotation');
            if (chessNotation) chessNotation.textContent = '';
        }

        // Try to stop any current capture/recognition first to ensure a clean restart
        try { window.postMessage({ source: 'voiceChessContent', type: 'stop' }, '*'); } catch (e) { /* ignore */ }

        // Small delay to allow the page script to fully stop before starting again
        const restartDelay = 250;
        setTimeout(() => {
            try {
                if (typeof voskModeEnabled !== 'undefined' && voskModeEnabled) {
                    // Vosk mode: ensure worker/page are started correctly
                    if (!voskWorker) {
                        try { startVoskMode(); } catch (e) { console.warn('Failed to start Vosk mode', e); }
                    } else {
                        try { window.postMessage({ source: 'voiceChessContent', type: 'start', mode: 'vosk' }, '*'); } catch (e) { /* ignore */ }
                    }
                } else {
                    // Normal web SpeechRecognition mode: (re)start recognition
                    try { startRecognition(); } catch (e) { console.warn('Failed to start recognition', e); }
                }
            } catch (e) {
                console.warn('clearAndRestart (delayed start) failed:', e);
            }
        }, restartDelay);
    } catch (e) {
        console.warn('clearAndRestart failed:', e);
    }
}

// normalize transcript fallback (in case injected script doesn't provide normalizedTranscript)
function normalizeFallback(text) {
    if (!text) return '';
    let s = text.toLowerCase().trim();

    // remove filler words
    s = s.replace(/\b(please|the|a|an|hey|hi|um|uh|like|so|move)\b/g, ' ');

    // common mis-hearings
    s = s.replace(/\bnight\b/g, 'knight');
    s = s.replace(/\bfor\b/g, '4');

    // map number words to digits
    const numMap = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', to: '' };
    s = s.replace(/\b(one|two|three|four|five|six|seven|eight|to)\b/g, (m) => numMap[m] || m);

    // normalize piece words and common synonyms
    s = s.replace(/\bqueen\b/g, 'queen');
    s = s.replace(/\brook\b/g, 'rook');
    s = s.replace(/\bknight\b/g, 'knight');
    s = s.replace(/\bbishop\b/g, 'bishop');
    s = s.replace(/\bking\b/g, 'king');
    s = s.replace(/\bpawn\b/g, 'pawn');

    // normalize castling phrases
    s = s.replace(/\bcastle\s*(short|kingside)?\b/g, 'castle kingside');
    s = s.replace(/\bcastle\s*(long|queenside)?\b/g, 'castle queenside');
    s = s.replace(/\bshort\s+castle\b/g, 'castle kingside');
    s = s.replace(/\blong\s+castle\b/g, 'castle queenside');
    s = s.replace(/\bo\s*-?\s*o\b/g, 'o-o');
    s = s.replace(/\bo\s*-?\s*o\s*-?\s*o\b/g, 'o-o-o');

    // capture synonyms
    s = s.replace(/\btakes\b|\btake\b|\bcaptures\b|\bcapture\b|\bxto\b/g, 'x');

    // promotions: "promote to queen", "=queen"
    s = s.replace(/\bpromote\s*(to)?\s*(queen|rook|bishop|knight)\b/g, (m, p1, p2) => '=' + p2[0]);

    // map letter + space + digit to contiguous square (e.g. 'e four' -> 'e4')
    s = s.replace(/\b([a-h])\s*([1-8])\b/g, '$1$2');

    // remove leftover multiple spaces
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}

// Helper: map spoken forms to chess squares robustly (e.g. 'h two' -> 'h2', 'aitch two' -> 'h2')
const rankWordMap = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8' };
const fileWordMap = {
    a: ['a', 'ay', 'alpha'],
    b: ['b', 'bee', 'be'],
    c: ['c', 'see', 'sea', 'cee'],
    d: ['d', 'dee'],
    e: ['e', 'ee'],
    f: ['f', 'ef', 'eff'],
    g: ['g', 'gee', 'jee'],
    h: ['h', 'aitch', 'age']
};

function normalizeFileToken(tok) {
    tok = tok.toLowerCase().replace(/[^a-z]/g, '');
    // direct a-h
    if (/^[a-h]$/.test(tok)) return tok;
    for (const f in fileWordMap) {
        if (fileWordMap[f].includes(tok)) return f;
    }
    return null;
}

function normalizeRankToken(tok) {
    tok = tok.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (/^[1-8]$/.test(tok)) return tok;
    if (rankWordMap[tok]) return rankWordMap[tok];
    return null;
}

function toSquare(text) {
    if (!text) return null;
    text = String(text).toLowerCase().trim();
    // common separators -> spaces
    text = text.replace(/[\-_,]/g, ' ');
    // collapse multiple spaces
    text = text.replace(/\s+/g, ' ').trim();

    // quick match a1, e4, etc.
    const direct = text.match(/\b([a-h])([1-8])\b/);
    if (direct) return direct[1] + direct[2];

    const parts = text.split(' ');
    if (parts.length >= 2) {
        const file = normalizeFileToken(parts[0]);
        const rank = normalizeRankToken(parts[1]);
        if (file && rank) return file + rank;
        // sometimes recognition returns 'e' then 'four' as separate tokens: try last two tokens
        const last = parts[parts.length - 1];
        const secondLast = parts[parts.length - 2];
        const f2 = normalizeFileToken(secondLast);
        const r2 = normalizeRankToken(last);
        if (f2 && r2) return f2 + r2;
    }

    // fallback: try to find any file letter followed by rank digit in the text
    const any = text.match(/([a-h]).*?([1-8])/);
    if (any) return any[1] + any[2];

    return null;
}

// Build a Vosk grammar JSON array string containing squares and a few commands
function buildVoskGrammar() {
    const files = ['a','b','c','d','e','f','g','h'];
    const ranks = ['1','2','3','4','5','6','7','8'];
    const rankWords = { '1':'one','2':'two','3':'three','4':'four','5':'five','6':'six','7':'seven','8':'eight' };
    const phrases = [];

    // include square forms: 'e4', 'e 4', 'e four'
    for (const f of files) {
        for (const r of ranks) {
            phrases.push(f + r);
            phrases.push(f + ' ' + r);
            phrases.push(f + ' ' + rankWords[r]);
        }
    }

    // common commands
    const commands = ['clear','castle kingside','castle queenside','o-o','o-o-o','resign','offer draw','accept draw','undo','takeback','promote to queen','promote to rook','promote to bishop','promote to knight'];
    for (const c of commands) phrases.push(c);

    // Also allow piece names (optional) and file-only (for SAN-like inputs)
    const pieces = ['pawn','knight','bishop','rook','queen','king','n','b','r','q','k'];
    for (const p of pieces) phrases.push(p);

    return JSON.stringify(Array.from(new Set(phrases)));
}

// Parse voice command into move (simplified algebraic: e2e4 or special commands)
function parseChessCommand(text) {
    if (!text) return null;
    // prefer already-normalized forms
    text = text.toLowerCase().trim();

    // quick check for special commands (castling, clear, resign, etc.)
    if (SPECIAL_COMMANDS.includes(text)) {
        // normalize a few common variants
        if (/castle\s*(kingside|short)/.test(text)) return 'o-o';
        if (/castle\s*(queenside|long)/.test(text)) return 'o-o-o';
        if (/^o-o-o$/.test(text)) return 'o-o-o';
        if (/^o-o$/.test(text)) return 'o-o';
        return text;
    }

    // a) full from-to like 'e2e4' or 'e2 e4' or 'e2-e4' or spoken 'e two to e four'
    // normalize spoken 'to' => space
    const cleaned = text.replace(/\bto\b/g, ' ').replace(/[-_]/g, ' ');
    const fromTo = cleaned.match(/([a-h][1-8])\s*[-xto]*\s*([a-h][1-8])(?:\s*=([qrbn]|queen|rook|bishop|knight))?/);
    if (fromTo) {
        const from = fromTo[1];
        const to = fromTo[2];
        const promo = fromTo[3];
        if (promo) {
            const p = promo[0];
            return from + to + p;
        }
        return from + to;
    }

    // Try spoken patterns like 'e two e four' -> split and map
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    // look for patterns file rank file rank
    if (tokens.length >= 4) {
        const maybeFrom = toSquare(tokens[0] + ' ' + tokens[1]);
        const maybeTo = toSquare(tokens[2] + ' ' + tokens[3]);
        if (maybeFrom && maybeTo) return maybeFrom + maybeTo;
    }

    // b) piece (optional) + (from)? + to : "knight f3", "knight b d two" etc.
    const pieceMove = text.match(/(?:pawn|knight|bishop|rook|queen|king|n|b|r|q|k)\s*(?:from\s*([a-h][1-8])\s*)?(?:to|x|takes|)?\s*([a-h][1-8])/);
    if (pieceMove) {
        const from = pieceMove[1];
        const to = pieceMove[2];
        if (from && to) return from + to;
        if (to) return to;
    }

    // c) SAN-like short forms (Nf3, Bxe6) - try to extract destination square
    const san = text.match(/([nbrqk])?x?\s*([a-h][1-8])/);
    if (san) return san[2];

    // d) Try to compact spoken forms like 'e two' -> 'e2' then retry
    const compact = text.replace(/\b([a-h])\s+(one|two|three|four|five|six|seven|eight)\b/g, (m, f, r) => {
        const map = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8' };
        return f + (map[r] || r);
    }).replace(/\s+/g, ' ').trim();
    if (compact !== text) return parseChessCommand(compact);

    // e) As a last resort, look for any explicit square tokens in the text. If there are two,
    // treat them as from/to; if only one, return it as a single-square move.
    const squareMatches = text.match(/\b([a-h][1-8])\b/g);
    if (squareMatches && squareMatches.length >= 2) {
        return squareMatches[0] + squareMatches[1];
    }
    if (squareMatches && squareMatches.length === 1) {
        return squareMatches[0];
    }

    // f) Try to use toSquare on the whole phrase as a final fallback
    const singleSquare = toSquare(text);
    if (singleSquare) return singleSquare;

    return null;
}

// Simulate move on chess.com board
function playMoveOnChessDotCom(move) {
    if (!move || move.length !== 4) return;
    const from = move.slice(0,2);
    const to = move.slice(2,4);

    simulateCanvasMove(from, to);

    console.log(`Move played: ${from} → ${to}`);

    // After a move is played, clear the UI and resume listening for the next voice input.
    try {
        // Use clearAndRestart to clear UI (including transcript) and resume listening
        clearAndRestart();
    } catch (e) {
        console.warn('post-move handling failed:', e);
    }
}

function simulateCanvasMove(from, to, orientation = "white") {
    // Select the most likely board canvas: choose the largest canvas element on the page
    const canvases = Array.from(document.querySelectorAll('canvas'));
    if (!canvases || canvases.length === 0) {
        console.error("Chess board canvas not found");
        return;
    }
    let board = canvases[0];
    try {
        let maxArea = 0;
        for (const c of canvases) {
            const r = c.getBoundingClientRect();
            const area = (r.width || 0) * (r.height || 0);
            if (area > maxArea) { maxArea = area; board = c; }
        }
    } catch (e) {
        board = canvases[0];
    }

    const start = squareToCanvasXY(from, board, orientation);
    const end = squareToCanvasXY(to, board, orientation);

    const opts = (type, x, y) =>
        new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerType: "mouse",
            clientX: x,
            clientY: y,
            buttons: 1,
        });

    board.dispatchEvent(opts("pointerdown", start.x, start.y));

    // small delay = more human-like
    setTimeout(() => {
        board.dispatchEvent(opts("pointermove", end.x, end.y));
        board.dispatchEvent(opts("pointerup", end.x, end.y));
    }, 80);
}

function squareToCanvasXY(square, canvas, orientation = "white") {
    const file = square.charCodeAt(0) - 97; // a=0
    const rank = parseInt(square[1], 10) - 1; // 1=0

    const rect = canvas.getBoundingClientRect();
    const squareSize = rect.width / 8;

    let x, y;

    if (orientation === "white") {
        x = rect.left + (file + 0.5) * squareSize;
        y = rect.top + (7 - rank + 0.5) * squareSize;
    } else {
        x = rect.left + (7 - file + 0.5) * squareSize;
        y = rect.top + (rank + 0.5) * squareSize;
    }

    return { x, y };
}


// Attempt to play a destination-only move (e.g. 'e4') by trying all candidate from-squares.
// Uses a MutationObserver to detect board changes after each attempt.
async function playDestinationOnChessDotCom(dest) {
    if (!dest || dest.length !== 2) return false;

    const squares = Array.from(document.querySelectorAll('[data-square]'));
    if (!squares.length) {
        console.warn('No board squares found');
        return false;
    }

    const squareMap = new Map(squares.map(s => [s.getAttribute('data-square'), s]));
    const destEl = squareMap.get(dest);
    if (!destEl) {
        console.warn('Destination square not found:', dest);
        return false;
    }

    // Find board root to observe changes; prefer a container that encloses squares
    let boardRoot = squares[0].closest('[data-board]') || squares[0].parentElement;
    if (!boardRoot) boardRoot = document.body;

    // Candidate from squares: those that currently contain something and are not the destination
    const candidateFrom = squares.filter(s => s.getAttribute('data-square') !== dest && s.innerHTML.trim() !== '');

    // Helper: wait for board change compared to 'before' or timeout
    function waitForBoardChange(before, timeout = 1000) {
        return new Promise((resolve) => {
            if (boardRoot.innerHTML !== before) return resolve(true);
            const obs = new MutationObserver(() => {
                if (boardRoot.innerHTML !== before) {
                    obs.disconnect();
                    resolve(true);
                }
            });
            obs.observe(boardRoot, { childList: true, subtree: true, characterData: true });
            setTimeout(() => { obs.disconnect(); resolve(false); }, timeout);
        });
    }

    for (const fromEl of candidateFrom) {
        const prevSnapshot = boardRoot.innerHTML;

        // Try clicking from -> to (same sequence as playMoveOnChessDotCom)
        try {
            ['mousedown','mouseup','click'].forEach(evtType => {
                fromEl.dispatchEvent(new MouseEvent(evtType, { bubbles:true, cancelable:true }));
                destEl.dispatchEvent(new MouseEvent(evtType, { bubbles:true, cancelable:true }));
            });
        } catch (e) {
            console.warn('Dispatch failed for', fromEl, destEl, e);
        }

        const changed = await waitForBoardChange(prevSnapshot, 1000);
        if (changed) {
            // Check if dest now contains a piece (non-empty) and differs from before
            const nowContent = destEl.innerHTML.trim();
            const beforeContent = (() => {
                // try to extract previous dest content from prevSnapshot string
                try {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(prevSnapshot, 'text/html');
                    const prev = doc.querySelector(`[data-square="${dest}"]`);
                    return prev ? prev.innerHTML.trim() : '';
                } catch (e) { return ''; }
            })();

            if (nowContent && nowContent !== beforeContent) {
                console.log('Move to', dest, 'succeeded from candidate', fromEl.getAttribute('data-square'));
                return true;
            }

            // Some boards update in a different way; as a heuristic, consider any change a success
            // if the destination contains anything now.
            if (nowContent) {
                console.log('Move to', dest, 'likely succeeded (heuristic)');
                return true;
            }
        }

        // else continue trying other pieces
    }

    console.warn('Unable to play destination move:', dest);
    return false;
}

// ==========================
// Floating Window
// ==========================
function createFloatingWindow() {
    if (!document.body) {
        // Retry if body not ready
        setTimeout(createFloatingWindow, 100);
        return;
    }

    floatingDiv = document.createElement('div');
    floatingDiv.style.position = 'fixed';
    floatingDiv.style.bottom = '20px';
    floatingDiv.style.right = '20px';
    floatingDiv.style.width = '320px';
    floatingDiv.style.backgroundColor = 'white';
    floatingDiv.style.border = '1px solid #333';
    floatingDiv.style.padding = '10px';
    floatingDiv.style.zIndex = 9999;
    floatingDiv.style.boxShadow = '0 0 12px rgba(0,0,0,0.5)';
    // Removed confirm button - moves will now be played automatically when recognition is final
    floatingDiv.innerHTML = `
        <div id="voiceText">Listening...</div>
        <div id="chessNotation" style="margin-top:5px; font-weight:bold;"></div>
    `;
    document.body.appendChild(floatingDiv);
}

// ==========================
// Voice Recognition
// ==========================
// We'll run SpeechRecognition in the page context (content scripts run in an
// isolated world where some WebAPIs like webkitSpeechRecognition are unreliable).
// injectPageScript() places a small script into the page which owns the
// SpeechRecognition instance and communicates back via window.postMessage.

function injectPageScript() {
    if (document.getElementById('voiceChessPageScript')) return;

    // Load external script via chrome.runtime.getURL to avoid CSP issues with inline scripts
    try {
        const scriptUrl = chrome.runtime.getURL('injected_page_script.js');
        const s = document.createElement('script');
        s.id = 'voiceChessPageScript';
        s.src = scriptUrl;
        s.onload = () => { console.log('voiceChess: injected page script loaded:', scriptUrl); };
        s.onerror = (e) => { console.error('voiceChess: failed to load injected script', e); };
        (document.documentElement || document.body || document).appendChild(s);
    } catch (e) {
        // fallback to inline injection if chrome.runtime.getURL isn't available
        const pageScript = `(() => {
            if (window.__voiceChessInjected) return;
            window.__voiceChessInjected = true;

            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            if (!SpeechRecognition) {
                window.postMessage({ source: 'voiceChessPage', type: 'error', error: 'SpeechRecognition not available' }, '*');
                return;
            }

            let recognition = null;
            let shouldKeepRunning = false;

            function createRecognition() {
                recognition = new SpeechRecognition();
                recognition.lang = 'en-US';
                recognition.continuous = true;
                recognition.interimResults = true;

                recognition.onstart = () => window.postMessage({ source: 'voiceChessPage', type: 'state', state: 'started' }, '*');
                recognition.onerror = (e) => window.postMessage({ source: 'voiceChessPage', type: 'error', error: e && e.error ? e.error : (e && e.message) || String(e) }, '*');
                recognition.onend = () => {
                    window.postMessage({ source: 'voiceChessPage', type: 'state', state: 'ended' }, '*');
                    // auto-restart only when we intend to keep running
                    if (shouldKeepRunning) {
                        try { recognition.start(); } catch (e) { /* ignore */ }
                    }
                };

                recognition.onresult = (event) => {
                    const transcript = Array.from(event.results)
                        .map(r => r[0].transcript)
                        .join('')
                        .trim();
                    const isFinal = event.results[event.results.length - 1].isFinal;
                    window.postMessage({ source: 'voiceChessPage', type: 'result', transcript, isFinal }, '*');
                };
            }

            window.addEventListener('message', (ev) => {
                const d = ev.data || {};
                if (!d || d.source !== 'voiceChessContent') return;
                if (d.type === 'start') {
                    shouldKeepRunning = true;
                    if (!recognition) createRecognition();
                    try { recognition.start(); } catch (e) { /* ignore if already started */ }
                }
                if (d.type === 'stop') {
                    shouldKeepRunning = false;
                    if (recognition) {
                        try { recognition.stop(); } catch (e) { /* ignore */ }
                        recognition = null;
                    }
                }
            }, false);

            // cleanup helper (callable by injected code removal if needed)
            window.__voiceChessInjectedCleanup = () => {
                shouldKeepRunning = false;
                if (recognition) {
                    try { recognition.stop(); } catch (e) {}
                    recognition = null;
                }
                window.__voiceChessInjected = false;
            };
        })();`;
        const s = document.createElement('script');
        s.id = 'voiceChessPageScript';
        s.textContent = pageScript;
        (document.documentElement || document.body || document).appendChild(s);
    }
}

// Vosk worker (client-side) handling
let voskWorker = null;
let voskModeEnabled = false;

function startVoskMode() {
    // Ensure page script is injected
    injectPageScript();

    // Create worker from extension resource
    try {
        const workerUrl = chrome.runtime.getURL('vosk-worker.js');
        voskWorker = new Worker(workerUrl);
        voskWorker.onmessage = (ev) => {
            const d = ev.data || {};
            console.log('voskWorker message', d);
            if (d.type === 'ready') {
                // notify UI
                window.postMessage({ source: 'voiceChessContent', type: 'state', state: 'vosk-ready' }, '*');
            }
            if (d.type === 'result') {
                // translate worker result to same message format used by the page script
                const transcript = (d.final || d.partial || '').trim();
                // produce a normalizedTranscript: prefer worker-normalized if provided, else run our fallback
                let normalized = normalizeFallback(transcript);
                // If normalized looks like a spoken square, map it
                const tsq = toSquare(transcript);
                if (tsq) normalized = tsq;

                window.postMessage({ source: 'voiceChessPage', type: 'result', transcript, normalizedTranscript: normalized, isFinal: !!d.final }, '*');
            }
        };

        // Initialize worker with a model path (extension resource URL) and grammar
        try {
            const modelUrl = chrome.runtime.getURL('vosk-model');
            const grammar = buildVoskGrammar();
            voskWorker.postMessage({ type: 'init', modelPath: modelUrl, grammar });
        } catch (e) { console.warn('Unable to post init to vosk worker', e); }

        // tell page script to start capturing audio in Vosk mode
        window.postMessage({ source: 'voiceChessContent', type: 'start', mode: 'vosk' }, '*');

        // forward audio-chunk messages from the page to the worker
        window._voiceChessVoskAudioHandler = function handleAudio(ev) {
            const d = ev.data || {};
            if (!d || d.source !== 'voiceChessPage') return;
            if (d.type === 'audio-chunk') {
                if (voskWorker) {
                    // include assumed sampleRate 16000 (injected page captures at native sample rate; worker may resample)
                    voskWorker.postMessage({ type: 'audio-chunk', chunk: d.chunk, mimeType: d.mimeType, sampleRate: 16000 });
                }
            }
        };
        window.addEventListener('message', window._voiceChessVoskAudioHandler);

        voskModeEnabled = true;
    } catch (e) {
        console.error('Failed to start Vosk worker', e);
        window.postMessage({ source: 'voiceChessContent', type: 'error', error: 'Failed to start Vosk: ' + e.message }, '*');
    }
}

function stopVoskMode() {
    try {
        // stop page capture
        window.postMessage({ source: 'voiceChessContent', type: 'stop' }, '*');
        if (voskWorker) {
            voskWorker.postMessage({ type: 'shutdown' });
            voskWorker.terminate();
            voskWorker = null;
        }
        if (window._voiceChessVoskAudioHandler) {
            try { window.removeEventListener('message', window._voiceChessVoskAudioHandler); } catch (e) {}
            window._voiceChessVoskAudioHandler = null;
        }
    } catch (e) { /* ignore */ }
    voskModeEnabled = false;
}

// Message handler for results coming from the page script
function handlePageMessage(event) {
    const d = event.data || {};
    if (!d || d.source !== 'voiceChessPage') return;

    console.log('voiceChess: page message received', d);

    if (!floatingDiv) return;
    const voiceTextEl = floatingDiv.querySelector('#voiceText');
    const chessNotationEl = floatingDiv.querySelector('#chessNotation');

    if (d.type === 'error') {
        if (voiceTextEl) voiceTextEl.textContent = 'Error: ' + (d.error || 'unknown');
        return;
    }

    if (d.type === 'state') {
        // Do not overwrite the user's transcript in #voiceText here; preserve it.
        return;
    }

    if (d.type === 'result') {
        // prefer normalizedTranscript from injected script; fallback to raw transcript normalization
        const rawTranscript = (d.transcript || '').trim();
        const normalized = (d.normalizedTranscript && d.normalizedTranscript.trim()) || normalizeFallback(rawTranscript);

        if (voiceTextEl) voiceTextEl.textContent = rawTranscript || 'Listening...';

        // Do not auto-clear the transcript; preserve it until user clears or stops.

        if (normalized.toLowerCase().includes('clear')) {
            // User asked to clear; clear notation and transcript and expect new input
            clearAndRestart();
            return;
        }

        const move = parseChessCommand(normalized);
        if (!move) {
            // show interim transcript but don't set notation
            // If final and cannot parse, leave transcript visible for user to correct
            return;
        }

        // If we have a parsed move, show it in the notation element
        if (chessNotationEl) {
            // display user-friendly spacing for from-to moves
            if (typeof move === 'string' && move.length >= 4) {
                // e.g. 'e1f2' or promotions 'e7e8q'
                const from = move.slice(0,2);
                const to = move.slice(2,4);
                chessNotationEl.textContent = from + ' ' + to + (move.length > 4 ? ' ' + move.slice(4) : '');
            } else {
                chessNotationEl.textContent = move;
            }
        }

        // Reset/start an inactivity timer: if no further commands within 5s, clear and restart
        cancelAutoTimer();
        autoResumeTimer = setTimeout(() => { clearAndRestart(); }, 5000);

        // Auto-play only when we have a full 4-char move (e.g. e2e4) and the
        // recognition result is final.
        if (d.isFinal) {
            try {
                // Only attempt to play standard from-to moves
                if (typeof move === 'string' && move.length === 4) {
                    // cancel inactivity timer — we are executing the move now
                    cancelAutoTimer();
                    playMoveOnChessDotCom(move);
                    // playMoveOnChessDotCom will resume listening afterwards
                } else if (typeof move === 'string' && move.length === 2) {
                    // destination-only like 'e4' -> try to find source and play
                    playDestinationOnChessDotCom(move).then(success => { if (success) resetInput(); }).catch(e => console.error(e));
                } else {
                    // Not a 4-char or 2-char move (e.g. "castle kingside") - do not auto-play these; display notation for user awareness
                }
            } catch (e) {
                console.error('Failed to play move:', e);
            }
        }
    }
}

function startRecognition() {
    // Ensure we have our message listener before injecting the page script
    console.log('voiceChess: starting recognition - adding listener and injecting script');
    window.removeEventListener('message', handlePageMessage);
    window.addEventListener('message', handlePageMessage);

    // Inject page script which will open the microphone in page context
    injectPageScript();

    // Tell the page script to start listening
    try { window.postMessage({ source: 'voiceChessContent', type: 'start' }, '*'); } catch (e) { console.error(e); }
}

function stopRecognition(manual = false) {
    if (manual) manualStop = true;
    console.log('voiceChess: stopping recognition');
    // Tell the page script to stop
    try { window.postMessage({ source: 'voiceChessContent', type: 'stop' }, '*'); } catch (e) { console.error(e); }

    // Remove injected page script and cleanup
    try { removeInjectedPageScript(); } catch (e) { /* ignore */ }

    // Remove our listener
    try { window.removeEventListener('message', handlePageMessage); } catch (e) {}

    recognition = null;
}

// ==========================
// Event listeners
// ==========================
window.addEventListener('voiceChessStart', () => {
    console.log('voiceChess: received voiceChessStart event');
    if (floatingDiv) return;
    manualStop = false; // user started, allow auto-restarts
    createFloatingWindow();
    // decide mode based on user-config in chrome.storage
    chrome.storage && chrome.storage.sync && chrome.storage.sync.get(['useVosk'], (cfg) => {
        const useVosk = cfg && cfg.useVosk;
        if (useVosk) {
            startVoskMode();
        } else {
            startRecognition();
        }
    });
});

window.addEventListener('voiceChessStop', () => {
    console.log('voiceChess: received voiceChessStop event');
    manualStop = true; // user requested stop; prevent auto-restart
    if (voskModeEnabled) stopVoskMode();
    stopRecognition(true);
    if (floatingDiv) {
        floatingDiv.remove();
        floatingDiv = null;
    }
});

// ==========================
// Board tracking (8x8) - parse chess.com move list and keep board state
// ==========================
// board[row][col] where row 0 = rank 8, row 7 = rank 1; col 0 = file a, col 7 = file h
let boardArray = null;

function createEmptyBoard() {
    const b = [];
    for (let r = 0; r < 8; r++) {
        const row = new Array(8).fill(null);
        b.push(row);
    }
    return b;
}

function initStartingBoard() {
    const b = createEmptyBoard();
    const back = ['r','n','b','q','k','b','n','r'];
    for (let c = 0; c < 8; c++) b[0][c] = back[c]; // black back rank (row 0 = rank8)
    for (let c = 0; c < 8; c++) b[1][c] = 'p'; // black pawns
    for (let c = 0; c < 8; c++) b[6][c] = 'P'; // white pawns
    const backW = ['R','N','B','Q','K','B','N','R'];
    for (let c = 0; c < 8; c++) b[7][c] = backW[c]; // white back rank
    boardArray = b;
    return b;
}

function getBoardArray() {
    if (!boardArray) initStartingBoard();
    return boardArray;
}

function squareToRC(sq) {
    if (!sq || sq.length !== 2) return null;
    const file = sq[0].toLowerCase();
    const rank = parseInt(sq[1], 10);
    if (!file.match(/[a-h]/) || isNaN(rank) || rank < 1 || rank > 8) return null;
    const col = file.charCodeAt(0) - 97;
    const row = 8 - rank;
    return { r: row, c: col };
}

function setPiece(square, piece) {
    const rc = squareToRC(square);
    if (!rc) return;
    getBoardArray()[rc.r][rc.c] = piece;
}

function removePiece(square) {
    const rc = squareToRC(square);
    if (!rc) return;
    getBoardArray()[rc.r][rc.c] = null;
}

function inBounds(r,c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

function isPathClear(fromR, fromC, toR, toC) {
    const dr = Math.sign(toR - fromR);
    const dc = Math.sign(toC - fromC);
    let r = fromR + dr, c = fromC + dc;
    while (r !== toR || c !== toC) {
        if (!inBounds(r,c)) return false;
        if (getBoardArray()[r][c] !== null) return false;
        r += dr; c += dc;
    }
    return true;
}

function canPieceMoveBasic(pieceType, fromR, fromC, toR, toC, color) {
    const dr = toR - fromR;
    const dc = toC - fromC;
    const absdr = Math.abs(dr);
    const absdc = Math.abs(dc);
    switch (pieceType.toUpperCase()) {
        case 'P': {
            // pawns: color 'w' moves up (row--), 'b' moves down (row++)
            const dir = color === 'w' ? -1 : 1;
            // capture
            if (dr === dir && Math.abs(dc) === 1) return true;
            // single step
            if (dr === dir && dc === 0 && getBoardArray()[toR][toC] === null) return true;
            // double step from starting rank
            const startRow = color === 'w' ? 6 : 1;
            if (fromR === startRow && dr === 2*dir && dc === 0) {
                // must be clear path
                const midR = fromR + dir;
                if (getBoardArray()[midR][fromC] === null && getBoardArray()[toR][toC] === null) return true;
            }
            return false;
        }
        case 'N':
            return (absdr === 1 && absdc === 2) || (absdr === 2 && absdc === 1);
        case 'B':
            if (absdr === absdc && absdr > 0) return isPathClear(fromR, fromC, toR, toC);
            return false;
        case 'R':
            if ((absdr === 0 && absdc > 0) || (absdc === 0 && absdr > 0)) return isPathClear(fromR, fromC, toR, toC);
            return false;
        case 'Q':
            if ((absdr === absdc && absdr > 0) || (absdr === 0 && absdc > 0) || (absdc === 0 && absdr > 0)) return isPathClear(fromR, fromC, toR, toC);
            return false;
        case 'K':
            if (Math.max(absdr, absdc) === 1) return true;
            // castling handled separately
            return false;
    }
    return false;
}

function findCandidateSources(pieceLetter, color, toSquareStr) {
    const res = [];
    const to = squareToRC(toSquareStr);
    if (!to) return res;
    const pUpper = pieceLetter.toUpperCase();
    const b = getBoardArray();
    for (let r=0;r<8;r++) for (let c=0;c<8;c++) {
        const p = b[r][c];
        if (!p) continue;
        const pColor = isUpper(p) ? 'w' : 'b';
        if (pColor !== color) continue;
        if (p.toUpperCase() !== pUpper) continue;
        // skip if destination has friendly piece
        const destPiece = b[to.r][to.c];
        if (destPiece && (isUpper(destPiece) ? 'w' : 'b') === color) continue;
        if (canPieceMoveBasic(pUpper, r, c, to.r, to.c, color)) {
            res.push({r,c});
        }
    }
    return res;
}

function applyMoveSAN(moveRaw, color) {
    if (!moveRaw) return false;
    let move = moveRaw.trim();
    // strip annotations and trailing + # ? ! (fixed: remove each annotation char)
    move = move.replace(/[!?+#]/g, '');
    if (move === '' ) return false;
    // normalize 0-0 variants
    if (/^0-0(-0)?$/i.test(move) || /^o-o(-o)?$/i.test(move)) move = move.replace(/0/g,'O');

    // Castling
    if (/^O-O-O$/i.test(move)) {
        // long castle
        if (color === 'w') {
            // white: king e1 -> c1, rook a1 -> d1
            setPiece('c1','K'); setPiece('d1','R'); removePiece('e1'); removePiece('a1');
        } else {
            setPiece('c8','k'); setPiece('d8','r'); removePiece('e8'); removePiece('a8');
        }
        return true;
    }
    if (/^O-O$/i.test(move)) {
        // short castle
        if (color === 'w') {
            setPiece('g1','K'); setPiece('f1','R'); removePiece('e1'); removePiece('h1');
        } else {
            setPiece('g8','k'); setPiece('f8','r'); removePiece('e8'); removePiece('h8');
        }
        return true;
    }

    // Promotion syntax like e8=Q, e8Q, exd8=Q, exd8Q
    const promoMatch = move.match(/^([a-h][18])=?([NBRQKnbrqk])?$/);
    if (promoMatch) {
        const dest = promoMatch[1].toLowerCase();
        const prom = promoMatch[2] ? promoMatch[2].toUpperCase() : 'Q';
        const colorPiece = color === 'w' ? prom.toUpperCase() : prom.toLowerCase();
        const to = squareToRC(dest);
        if (!to) return false;
        const dir = color === 'w' ? -1 : 1;
        const fromR = to.r - dir;
        // Try possible from-files: same file (advance) or adjacent (capture)
        for (let dc = -1; dc <= 1; dc++) {
            const fc = to.c + dc;
            if (!inBounds(fromR, fc)) continue;
            const p = getBoardArray()[fromR][fc];
            if (!p) continue;
            if ((color === 'w' && p === 'P') || (color === 'b' && p === 'p')) {
                // remove pawn and place promotion
                removePiece(String.fromCharCode(97 + fc) + (8 - fromR));
                removePiece(dest);
                setPiece(dest, colorPiece);
                return true;
            }
        }
        // if not found, still place promotion on dest (best effort)
        removePiece(dest);
        setPiece(dest, colorPiece);
        return true;
    }

    // Pawn capture, possibly with promotion handled above
    const pawnCapture = move.match(/^([a-h])x([a-h][1-8])$/i);
    if (pawnCapture) {
        const fromFile = pawnCapture[1].toLowerCase();
        const dest = pawnCapture[2].toLowerCase();
        const to = squareToRC(dest);
        if (!to) return false;
        // find pawn on fromFile that can capture dest
        const c = fromFile.charCodeAt(0) - 97;
        for (let r = 0; r < 8; r++) {
            const p = getBoardArray()[r][c];
            if (!p) continue;
            if ((color==='w' && p==='P') || (color==='b' && p==='p')) {
                if (canPieceMoveBasic('P', r, c, to.r, to.c, color)) {
                    // do capture
                    removePiece(String.fromCharCode(97 + c) + (8 - r));
                    removePiece(dest);
                    setPiece(dest, color === 'w' ? 'P' : 'p');
                    return true;
                }
            }
        }
        return false;
    }

    // pawn quiet move e4
    const pawnMove = move.match(/^([a-h][1-8])$/i);
    if (pawnMove) {
        const dest = pawnMove[1].toLowerCase();
        const to = squareToRC(dest);
        if (!to) return false;
        const colorPiece = color === 'w' ? 'P' : 'p';
        const candidates = [];
        for (let r=0;r<8;r++) for (let c=0;c<8;c++) {
            const p = getBoardArray()[r][c];
            if (!p) continue;
            if ((color==='w' && p==='P') || (color==='b' && p==='p')) {
                if (canPieceMoveBasic('P', r, c, to.r, to.c, color)) candidates.push({r,c});
            }
        }
        if (candidates.length === 1) {
            const fr = candidates[0].r, fc = candidates[0].c;
            removePiece(String.fromCharCode(97 + fc) + (8 - fr));
            setPiece(dest, colorPiece);
            return true;
        }
        if (candidates.length > 0) {
            const chosen = candidates[0];
            removePiece(String.fromCharCode(97 + chosen.c) + (8 - chosen.r));
            setPiece(dest, colorPiece);
            return true;
        }
        return false;
    }

    // Piece move
    const pieceMoveMatch = move.match(/^([NBRQK])([a-h1-8]?)([a-h1-8]?)(x?)([a-h][1-8])(?:=?([NBRQK]))?$/i);
    if (pieceMoveMatch) {
        const pieceLetter = pieceMoveMatch[1].toUpperCase();
        const dis1 = pieceMoveMatch[2] || '';
        const dis2 = pieceMoveMatch[3] || '';
        const dest = pieceMoveMatch[5].toLowerCase();
        let candidates = findCandidateSources(pieceLetter, color, dest);
        // apply disambiguation
        if (dis1) {
            candidates = candidates.filter(p => {
                const file = String.fromCharCode(97 + p.c);
                const rank = (8 - p.r).toString();
                return file === dis1 || rank === dis1;
            });
        }
        if (dis2) {
            candidates = candidates.filter(p => {
                const file = String.fromCharCode(97 + p.c);
                const rank = (8 - p.r).toString();
                return file === dis2 || rank === dis2;
            });
        }
        if (candidates.length === 0) return false;
        const chosen = candidates[0];
        const fromSq = String.fromCharCode(97 + chosen.c) + (8 - chosen.r);
        // perform move
        removePiece(fromSq);
        removePiece(dest);
        const placed = (color === 'w') ? pieceLetter.toUpperCase() : pieceLetter.toLowerCase();
        setPiece(dest, placed);
        return true;
    }

    // Fallback: unrecognized move
    return false;
}

// ==========================
// Board syncing from chess.com move list
// ==========================
// Expose for debug/testing
window.getChessBoardArray = getBoardArray;
window.updateChessBoardFromDom = updateBoardFromDom;
window.applyMoveSAN = applyMoveSAN;
// start observing when the script loads (if DOM present)
setTimeout(observeMoveList, 500);
