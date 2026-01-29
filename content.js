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
    'cancel',
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
    const commands = ['clear', 'cancel','castle kingside','castle queenside','o-o','o-o-o','resign','offer draw','accept draw','undo','takeback','promote to queen','promote to rook','promote to bishop','promote to knight'];
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

// Parse phrases like "king to e1", "bishop takes e3", "knight f3" -> { piece: 'king', dest: 'e1' }
function parsePieceAndDestFromNormalized(normText) {
    if (!normText) return null;
    const s = normText.toLowerCase().trim();
    // look for patterns: piece [takes|x|to]? square
    const m = s.match(/\b(king|queen|rook|bishop|knight|pawn|k|q|r|b|n|p)\b(?:\s*(?:to|x|takes|take|captures|capture)\s*)?([a-h][1-8])/i);
    if (m) {
        let piece = m[1].toLowerCase();
        // normalize single-letter forms
        if (piece.length === 1) {
            const map = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
            piece = map[piece] || piece;
        }
        const dest = m[2] ? m[2].toLowerCase() : null;
        if (dest) return { piece, dest };
    }
    return null;
}

// Heuristic: try to determine the piece letter (PNBRQK) for a square DOM element's contents
function guessPieceLetterFromSquareElement(squareEl) {
    if (!squareEl) return null;
    const html = (squareEl.innerHTML || '').toLowerCase();
    const classNames = (squareEl.className || '').toLowerCase();

    // Common chess.com piece image alt/text patterns
    if (html.indexOf('king') !== -1 || classNames.indexOf('king') !== -1 || html.indexOf('wk') !== -1 || html.indexOf('bk') !== -1) return 'K';
    if (html.indexOf('queen') !== -1 || classNames.indexOf('queen') !== -1 || html.indexOf('wq') !== -1 || html.indexOf('bq') !== -1) return 'Q';
    if (html.indexOf('rook') !== -1 || classNames.indexOf('rook') !== -1 || html.indexOf('wr') !== -1 || html.indexOf('br') !== -1) return 'R';
    if (html.indexOf('bishop') !== -1 || classNames.indexOf('bishop') !== -1 || html.indexOf('wb') !== -1 || html.indexOf('bb') !== -1) return 'B';
    if (html.indexOf('knight') !== -1 || classNames.indexOf('knight') !== -1 || html.indexOf('wn') !== -1 || html.indexOf('bn') !== -1 || html.indexOf('horse') !== -1) return 'N';
    if (html.indexOf('pawn') !== -1 || classNames.indexOf('pawn') !== -1 || html.indexOf('wp') !== -1 || html.indexOf('bp') !== -1) return 'P';

    // fallback: look for common single-letter classes like 'wp', 'bp'
    if (/\bwp\b/.test(classNames) || /\bwp\b/.test(html)) return 'P';
    if (/\bbp\b/.test(classNames) || /\bbp\b/.test(html)) return 'P';

    return null;
}

function isUpper(ch) {
    // Return true when the given piece character appears uppercase (white piece)
    if (!ch || typeof ch !== 'string') return false;
    const c = ch.charAt(0);
    return /^[A-Z]$/.test(c);
}

// Attempt to play a move where the user specified a piece and destination (e.g. "king to e1").
// This narrows candidate from-squares to only those that contain that piece type.
async function playPieceToSquare(pieceName, dest) {
    if (!pieceName || !dest || dest.length !== 2) return false;

    const pieceLetterMap = { king: 'K', queen: 'Q', rook: 'R', bishop: 'B', knight: 'N', pawn: 'P' };
    const wanted = (pieceLetterMap[pieceName.toLowerCase()] || null);
    if (!wanted) return false;

    const squares = Array.from(document.querySelectorAll('[data-square]'));
    // Build a list of candidate source squares using our boardArray logic first
    const candidates = [];
    try {
        // try both colors; prefer white then black (no reliable turn detection here)
        const w = findCandidateSources(wanted, 'w', dest).map(p => String.fromCharCode(97 + p.c) + (8 - p.r));
        const b = findCandidateSources(wanted, 'b', dest).map(p => String.fromCharCode(97 + p.c) + (8 - p.r));
        // prefer white candidates if any (common case when user is white), else include black
        if (w.length) candidates.push(...w);
        if (b.length) candidates.push(...b);
    } catch (e) { /* ignore */ }

    // If board DOM squares exist, map candidates to elements
    const squareMap = new Map(squares.map(s => [s.getAttribute('data-square'), s]));
    let candidateEls = candidates.map(sq => squareMap.get(sq)).filter(Boolean);

    // If we didn't find candidates via boardArray or no DOM squares, try heuristic DOM/guessing
    if (candidateEls.length === 0 && squares.length > 0) {
        // fall back to scanning DOM for elements that appear to contain the requested piece
        candidateEls = squares.filter(s => s.getAttribute('data-square') !== dest && s.innerHTML.trim() !== '' && (function() {
            const sq = s.getAttribute('data-square');
            const ch = getPieceCharAt(sq);
            if (ch && ch.toUpperCase() === wanted) return true;
            const guessed = guessPieceLetterFromSquareElement(s);
            return guessed === wanted;
        })());
    }

    // Helper to observe broad board changes
    let boardRoot = document.body;
    if (squares.length) boardRoot = squares[0].closest('[data-board]') || squares[0].parentElement || document.body;
    function waitForBoardChange(before, timeout = 1200) {
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

    // If we have DOM square elements to click, try them
    if (candidateEls.length > 0) {
        const destEl = squareMap.get(dest);
        if (!destEl) {
            // If destination element not found, fall back to canvas approach below
            candidateEls = [];
        } else {
            for (const fromEl of candidateEls) {
                const prev = boardRoot.innerHTML;
                try {
                    ['mousedown','mouseup','click'].forEach(evtType => {
                        fromEl.dispatchEvent(new MouseEvent(evtType, { bubbles:true, cancelable:true }));
                        destEl.dispatchEvent(new MouseEvent(evtType, { bubbles:true, cancelable:true }));
                    });
                } catch (e) { console.warn('Dispatch failed for', fromEl, destEl, e); }
                const changed = await waitForBoardChange(prev, 1200);
                if (changed) {
                    const nowContent = destEl.innerHTML.trim();
                    const beforeContent = (() => { try { const parser = new DOMParser(); const doc = parser.parseFromString(prev, 'text/html'); const prev = doc.querySelector(`[data-square="${dest}"]`); return prev ? prev.innerHTML.trim() : ''; } catch (e) { return ''; } })();
                    if (nowContent && nowContent !== beforeContent) {
                        console.log('Piece move to', dest, 'succeeded from', fromEl.getAttribute('data-square'));
                        return true;
                    }
                    if (nowContent) return true; // heuristic
                }
            }
        }
    }

    // If we reach here, try canvas-based simulation using candidates (or all occupied squares if none)
    const canvases = Array.from(document.querySelectorAll('canvas'));
    if (canvases.length === 0) {
        console.warn('No canvas board found and DOM attempts failed for piece move to', dest);
        return false;
    }
    // If we have explicit candidate square strings, use them; else try all occupied squares
    let candidateSquares = candidates.slice();
    if (candidateSquares.length === 0) {
        const sqs = Array.from(document.querySelectorAll('[data-square]'));
        candidateSquares = sqs.filter(s => s.getAttribute('data-square') !== dest && s.innerHTML.trim() !== '').map(s => s.getAttribute('data-square'));
    }
    // If still empty, try all boardArray squares with matching piece
    if (candidateSquares.length === 0) {
        try {
            const b = getBoardArray();
            for (let r=0;r<8;r++) for (let c=0;c<8;c++) {
                const p = b[r][c];
                if (!p) continue;
                if (p.toUpperCase() === wanted) candidateSquares.push(String.fromCharCode(97 + c) + (8 - r));
            }
        } catch (e) {}
    }

    // Try simulateCanvasMove from each candidate
    for (const fromSq of candidateSquares) {
        const prev = boardRoot.innerHTML;

        console.log('Canvas piece move to', dest, 'attempted from', fromSq);

        playMoveOnChessDotCom(fromSq + dest);
        // try {
        //     // pick largest canvas as simulateCanvasMove does
        //     let board = canvases[0];
        //     try { let maxArea = 0; for (const c of canvases) { const r = c.getBoundingClientRect(); const area = (r.width||0)*(r.height||0); if (area>maxArea) { maxArea=area; board=c; } } } catch(e) { board = canvases[0]; }
        //     const start = squareToCanvasXY(fromSq, board, 'white');
        //     const end = squareToCanvasXY(dest, board, 'white');
        //     const opts = (type,x,y) => new PointerEvent(type, { bubbles:true, cancelable:true, pointerType:'mouse', clientX:x, clientY:y, buttons:1 });
        //     board.dispatchEvent(opts('pointerdown', start.x, start.y));
        //     await new Promise(r => setTimeout(r, 80));
        //     board.dispatchEvent(opts('pointermove', end.x, end.y));
        //     board.dispatchEvent(opts('pointerup', end.x, end.y));
        // } catch (e) { console.warn('Canvas dispatch failed for', fromSq, dest, e); }
        const changed = await waitForBoardChange(prev, 1200);
        if (changed) {
            console.log('Canvas piece move to', dest, 'attempted from', fromSq);
            return true;
        }
    }

    console.warn('Unable to play piece move to', dest);
    return false;
}

function logMoveDescription(fromSq, toSq, movingPieceChar, capturedPieceChar, promotion, color) {
    const mover = movingPieceChar ? pieceFullNameChar(movingPieceChar) : 'Pawn';
    const cap = capturedPieceChar ? pieceFullNameChar(capturedPieceChar) : null;
    const whoColor = color === 'w' ? 'White' : 'Black';
    let msg = `${whoColor} ${mover}`;
    if (fromSq) msg += ` from ${fromSq}`;
    msg += ` to ${toSq}`;
    if (cap) msg += ` capturing ${cap}`;
    if (promotion) {
        const promName = pieceFullNameChar(promotion);
        msg += ` and promotes to ${promName}`;
    }
    console.log(msg);
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

        if (normalized.toLowerCase().includes('clear') || normalized.toLowerCase().includes('cancel')) {
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
                    // But first check if the user mentioned a piece (e.g. 'king to e1') and prefer narrower attempt
                    const pieceSpec = parsePieceAndDestFromNormalized(normalized);
                    console.log('Attempting destination move to', move, 'with piece spec', pieceSpec);

                    if (pieceSpec && pieceSpec.dest === move) {
                        // playMoveOnChessDotCom(move);

                        playPieceToSquare(pieceSpec.piece, move).then(success => {
                            if (success) resetInput();
                            else {
                                playMoveOnChessDotCom(move);
                                resetInput();
                            }
                        }).catch(e => { console.error(e); });
                    } else {
                        playMoveOnChessDotCom(move);
                        resetInput();
                    }
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

// Add lightweight game state to track lastMove for en-passant detection
let gameState = { lastMove: null };

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
    // reset transient game state (important for en-passant tracking)
    try { gameState.lastMove = null; } catch (e) { /* ignore */ }
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
            // capture (diagonal)
            if (dr === dir && Math.abs(dc) === 1) {
                const destPiece = getBoardArray()[toR][toC];
                // normal capture: destination must contain opponent piece
                if (destPiece) return true;
                // en-passant: destination empty but last move was a double pawn push to the adjacent square
                if (typeof gameState !== 'undefined' && gameState.lastMove && gameState.lastMove.wasDoublePawnPush) {
                    const lastTo = gameState.lastMove.to;
                    const lastRC = squareToRC(lastTo);
                    if (lastRC && lastRC.c === toC) {
                        // for white capturing en-passant, captured pawn is on row = toR + 1
                        const expectedCapRow = color === 'w' ? toR + 1 : toR - 1;
                        if (lastRC.r === expectedCapRow) return true;
                    }
                }
                return false;
            }
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

function pieceFullNameChar(ch) {
    if (!ch) return 'piece';
    const c = ch.toUpperCase();
    switch (c) {
        case 'P': return 'Pawn';
        case 'N': return 'Knight';
        case 'B': return 'Bishop';
        case 'R': return 'Rook';
        case 'Q': return 'Queen';
        case 'K': return 'King';
    }
    return 'piece';
}

function getPieceCharAt(square) {
    const rc = squareToRC(square);
    if (!rc) return null;
    return getBoardArray()[rc.r][rc.c];
}

// Debug: print our internal board array in a readable format (rank 8 -> 1)
function printBoardArray() {
    try {
        const b = getBoardArray();
        console.log('--- Internal boardArray (row0 = rank8 -> row7 = rank1) ---');
        for (let r = 0; r < 8; r++) {
            const rank = 8 - r;
            const row = b[r].map(s => s === null ? '.' : s).join(' ');
            console.log(rank + ': ' + row);
        }
        console.log('-----------------------------------------------');
    } catch (e) {
        console.warn('printBoardArray failed:', e);
    }
}

// Replace applyMoveSAN with improved parser and applier
function rcToSquare(r, c) {
    return String.fromCharCode(97 + c) + (8 - r);
}

function applyMoveSAN(moveRaw, color) {
    if (!moveRaw) return false;
    let move = String(moveRaw).trim();
    // strip annotations, NAGs, comments and check/mate symbols
    move = move.replace(/{.*?}|\(.*?\)|\$\d+/g, ''); // remove comments and NAGs
    move = move.replace(/[!?+#]+/g, ''); // remove annotation symbols
    move = move.replace(/^\s+|\s+$/g, '');
    if (move === '') return false;
    // normalize zeros to letter O for castling
    move = move.replace(/0/g, 'O');

    // helper: get board and rc conversion
    const b = getBoardArray();

    // CASTLING
    if (/^O-O-O$/i.test(move) || /^O-O-O$/.test(move)) {
        if (color === 'w') {
            // white long
            logMoveDescription('e1', 'c1', 'K', null, null, color);
            removePiece('e1'); removePiece('a1');
            setPiece('c1', 'K'); setPiece('d1', 'R');
        } else {
            logMoveDescription('e8', 'c8', 'k', null, null, color);
            removePiece('e8'); removePiece('a8');
            setPiece('c8', 'k'); setPiece('d8', 'r');
        }
        // update lastMove
        gameState.lastMove = { from: null, to: null, piece: 'K', color, wasDoublePawnPush: false };
        return true;
    }
    if (/^O-O$/i.test(move) || /^O-O$/.test(move)) {
        if (color === 'w') {
            logMoveDescription('e1', 'g1', 'K', null, null, color);
            removePiece('e1'); removePiece('h1');
            setPiece('g1', 'K'); setPiece('f1', 'R');
        } else {
            logMoveDescription('e8', 'g8', 'k', null, null, color);
            removePiece('e8'); removePiece('h8');
            setPiece('g8', 'k'); setPiece('f8', 'r');
        }
        gameState.lastMove = { from: null, to: null, piece: 'K', color, wasDoublePawnPush: false };
        return true;
    }

    // PROMOTION (with optional capture)
    // Examples: e8=Q, e8Q, exd8=Q, exd8Q
    const promoMatch = move.match(/^(?:([a-h])x)?([a-h][18])=?([NBRQnbrq])?$/i);
    if (promoMatch) {
        // handle both capture-promotions and quiet promotions
        let fromFile = null;
        let dest = null;
        let prom = null;
        if (promoMatch.length === 4) {
            // either ([a-h])x dest prom or dest prom
            if (/^[a-h]x/i.test(move)) {
                fromFile = promoMatch[1] ? promoMatch[1].toLowerCase() : null;
                dest = promoMatch[2].toLowerCase();
                prom = promoMatch[3] ? promoMatch[3].toUpperCase() : null;
            } else {
                dest = promoMatch[1].toLowerCase();
                prom = promoMatch[2] ? promoMatch[2].toUpperCase() : null;
            }
        } else if (promoMatch.length === 3) {
            dest = promoMatch[1].toLowerCase();
            prom = promoMatch[2] ? promoMatch[2].toUpperCase() : null;
        }
        if (!dest) return false;
        const toRC = squareToRC(dest);
        if (!toRC) return false;
        // find candidate pawns that can promote to dest
        let candidates = findCandidateSources('P', color, dest);
        if (fromFile) candidates = candidates.filter(p => String.fromCharCode(97 + p.c) === fromFile);
        if (candidates.length === 0) return false;
        const chosen = candidates[0];
        const fromSq = rcToSquare(chosen.r, chosen.c);
        // default promotion to Queen if unspecified
        prom = prom || 'Q';
        const promotedChar = (color === 'w') ? prom.toUpperCase() : prom.toLowerCase();
        logMoveDescription(fromSq, dest, 'P', getPieceCharAt(dest), prom, color);
        removePiece(fromSq);
        removePiece(dest);
        setPiece(dest, promotedChar);
        // update lastMove (promotion is not a double pawn push)
        gameState.lastMove = { from: fromSq, to: dest, piece: prom, color, wasDoublePawnPush: false };
        return true;
    }

    // PAWN CAPTURE (including possible en-passant)
    const pawnCap = move.match(/^([a-h])x([a-h][1-8])$/i);
    if (pawnCap) {
        const fromFile = pawnCap[1].toLowerCase();
        const dest = pawnCap[2].toLowerCase();
        const toRC = squareToRC(dest);
        if (!toRC) return false;
        // find pawn candidates on fromFile that can move to dest
        let candidates = findCandidateSources('P', color, dest).filter(p => String.fromCharCode(97 + p.c) === fromFile);
        if (candidates.length === 0) {
            // maybe en-passant: pawn can capture to empty square if last move was double pawn push
            // scan for pawn at fromFile that can move diagonally to dest
            for (let r = 0; r < 8; r++) {
                const p = b[r][fromFile.charCodeAt(0) - 97];
                if (!p) continue;
                if ((color === 'w' && p === 'P') || (color === 'b' && p === 'p')) {
                    if (canPieceMoveBasic('P', r, fromFile.charCodeAt(0) - 97, toRC.r, toRC.c, color)) {
                        candidates.push({ r, c: fromFile.charCodeAt(0) - 97 });
                    }
                }
            }
        }
        if (candidates.length === 0) return false;
        const chosen = candidates[0];
        const fromSq = rcToSquare(chosen.r, chosen.c);

        const destPiece = getPieceCharAt(dest);
        if (destPiece) {
            // normal capture
            logMoveDescription(fromSq, dest, 'P', destPiece, null, color);
            removePiece(fromSq);
            removePiece(dest);
            setPiece(dest, color === 'w' ? 'P' : 'p');
            gameState.lastMove = { from: fromSq, to: dest, piece: 'P', color, wasDoublePawnPush: false };
            return true;
        }

        // If destination empty, check en-passant capture
        if (gameState.lastMove && gameState.lastMove.wasDoublePawnPush) {
            const lastTo = gameState.lastMove.to; // square string like 'd5'
            const lastRC = squareToRC(lastTo);
            if (lastRC && lastRC.c === toRC.c) {
                // verify the captured pawn is adjacent and on the correct row
                // for white capturing en-passant, captured pawn must be on row = to.r + 1
                const expectedCapRow = color === 'w' ? toRC.r + 1 : toRC.r - 1;
                if (lastRC.r === expectedCapRow) {
                    const capturedSquare = lastTo;
                    logMoveDescription(fromSq, dest, 'P', getPieceCharAt(capturedSquare), null, color);
                    removePiece(fromSq);
                    removePiece(capturedSquare);
                    setPiece(dest, color === 'w' ? 'P' : 'p');
                    gameState.lastMove = { from: fromSq, to: dest, piece: 'P', color, wasDoublePawnPush: false };
                    return true;
                }
            }
        }

        return false;
    }

    // PAWN QUIET MOVE (e.g. e4)
    const pawnQuiet = move.match(/^([a-h][1-8])$/i);
    if (pawnQuiet) {
        const dest = pawnQuiet[1].toLowerCase();
        const toRC = squareToRC(dest);
        if (!toRC) return false;
        // find pawn candidates that can move to dest (single or double)
        let candidates = findCandidateSources('P', color, dest);
        if (candidates.length === 0) return false;
        // prefer single-step candidate if multiple: choose the one with correct starting row bias
        let chosen = null;
        if (candidates.length === 1) chosen = candidates[0];
        else {
            // attempt to pick pawn that is on the immediate source square for single move
            for (const c of candidates) {
                const dr = toRC.r - c.r;
                const dir = color === 'w' ? -1 : 1;
                if (dr === dir) { chosen = c; break; }
            }
            if (!chosen) chosen = candidates[0];
        }
        const fromSq = rcToSquare(chosen.r, chosen.c);

        const capturedChar = getPieceCharAt(dest);
        logMoveDescription(fromSq, dest, 'P', capturedChar, null, color);
        removePiece(fromSq);
        setPiece(dest, color === 'w' ? 'P' : 'p');
        // record last move if it was a double-step
        const wasDouble = Math.abs(chosen.r - toRC.r) === 2;
        gameState.lastMove = { from: fromSq, to: dest, piece: 'P', color, wasDoublePawnPush: wasDouble };
        return true;
    }

    // PIECE MOVE (with optional disambiguation and capture)
    // e.g. Nf3, R1a3, Nbd2, Bxf6
    const pieceRegex = /^([NBRQK])([a-h1-8]{0,2})(x?)([a-h][1-8])$/i;
    const pmatch = move.match(pieceRegex);
    if (pmatch) {
        const pieceLetter = pmatch[1].toUpperCase();
        const disamb = pmatch[2] || '';
        // captureFlag intentionally unused - SAN indicates capture with 'x' but we accept both when destination occupied or en-passant
         const dest = pmatch[4].toLowerCase();
         const toRC = squareToRC(dest);
         if (!toRC) return false;

        // collect candidate source squares for the piece
        let candidates = findCandidateSources(pieceLetter, color, dest);
        // apply disambiguation: disamb can be file, rank, or file+rank
        if (disamb) {
            const dchars = disamb.split('');
            candidates = candidates.filter(p => {
                const file = String.fromCharCode(97 + p.c);
                const rank = (8 - p.r).toString();
                // must match all disambiguation chars in order (either file or rank)
                for (const ch of dchars) {
                    if (/[a-h]/i.test(ch)) {
                        if (file !== ch) return false;
                    } else if (/[1-8]/.test(ch)) {
                        if (rank !== ch) return false;
                    } else return false;
                }
                return true;
            });
        }

        if (candidates.length === 0) return false;
        // pick first candidate (deterministic) - SAN should have disambiguated when needed
        const chosen = candidates[0];
        const fromSq = rcToSquare(chosen.r, chosen.c);

        const capturedChar = getPieceCharAt(dest);
        logMoveDescription(fromSq, dest, pieceLetter, capturedChar, null, color);
        // perform move
        removePiece(fromSq);
        removePiece(dest);
        const placed = (color === 'w') ? pieceLetter.toUpperCase() : pieceLetter.toLowerCase();
        setPiece(dest, placed);
        gameState.lastMove = { from: fromSq, to: dest, piece: pieceLetter, color, wasDoublePawnPush: false };
        return true;
    }

    // Unknown/unsupported SAN
    return false;
}

// ==========================
// Board syncing from chess.com move list
// ==========================
// The following helpers will locate the chess.com move-list DOM, extract SAN strings,
// and replay them using the existing applyMoveSAN() to sync our internal boardArray.

let _lastObservedMoveCount = 0;

function loadMovesFromDOM() {
    // Try several selectors to find the move list element used by chess.com
    const selectors = [
        'wc-simple-move-list',
        '.play-controller-moveList',
        '.move-list',
        '[class*="move-list"]'
    ];
    let el = null;
    for (const sel of selectors) {
        const found = document.querySelector(sel);
        if (found) { el = found; break; }
    }
    if (!el) return [];

    // Prefer the compact container which holds move pairs (example: .toggle-timestamps)
    const container = el.querySelector('.toggle-timestamps') || el;

    // Collect span texts which typically contain SAN tokens
    const spans = Array.from(container.querySelectorAll('span'));
    const raw = spans.map(s => (s.textContent || '').trim()).filter(Boolean);

    // Normalize tokens: remove stray dots, move numbers, and empty items
    const moves = [];
    for (const t of raw) {
        const s = t.replace(/\u00A0/g, ' ').trim();
        if (!s) continue;
        // ignore tokens that look like move numbers "1." or "1..."
        if (/^\d+\.*$/.test(s)) continue;
        // remove trailing dots and whitespace
        const cleaned = s.replace(/^\.+|\.+$/g, '').trim();
        if (cleaned === '') continue;
        // sometimes spans include extra annotations like "..." or move numbers; keep SAN-like strings
        moves.push(cleaned);
    }

    return moves;
}

function updateBoardFromDom(force = false) {
    try {
        const moves = loadMovesFromDOM();

        console.log("moves: ");
        console.log(moves);

        if (!moves || moves.length === 0) {
            // nothing to do
            return;
        }

        // If not forced and move count hasn't changed, skip
        if (!force && moves.length === _lastObservedMoveCount) return;
        _lastObservedMoveCount = moves.length;

        // Reset internal board to starting position
        initStartingBoard();

        // Apply moves in order; chess.com typically lists moves in SAN order: white then black
        for (let i = 0; i < moves.length; i++) {
            const san = String(moves[i]).trim();
            if (!san) continue;
            // color: even index -> white, odd -> black
            const color = (i % 2 === 0) ? 'w' : 'b';
            const ok = applyMoveSAN(san, color);
            if (!ok) {
                // best-effort: try stripping move numbers/annotations and reapply
                const alt = san.replace(/^[0-9]+\.?/, '').replace(/\s+/g, '');
                if (alt && alt !== san) applyMoveSAN(alt, color);
            }
        }

        console.log('updateBoardFromDom: applied', moves.length, 'SAN tokens; boardArray updated');
        printBoardArray();
    } catch (e) {
        console.warn('updateBoardFromDom failed:', e);
    }
}

function observeMoveList() {
    // Locate the move-list element; if not present yet, retry shortly
    const selectors = [
        'wc-simple-move-list',
        '.play-controller-moveList',
        '.move-list',
        '[class*="move-list"]'
    ];
    let el = null;
    for (const sel of selectors) {
        const found = document.querySelector(sel);
        if (found) { el = found; break; }
    }

    if (!el) {
        // retry a few times as the page loads
        setTimeout(observeMoveList, 500);
        return;
    }

    // On first discovery, do an immediate sync
    updateBoardFromDom(true);

    // Observe changes to the move list (new moves appended or annotations changed)
    const observer = new MutationObserver((mutations) => {
        // Simple heuristic: if the subtree changed, re-run sync
        for (const m of mutations) {
            if (m.type === 'childList' || m.type === 'characterData' || m.type === 'subtree') {
                // small debounce to avoid repeated work
                try {
                    setTimeout(() => updateBoardFromDom(false), 50);
                } catch (e) {}
                break;
            }
        }
    });

    observer.observe(el, { childList: true, subtree: true, characterData: true });
}

// Expose for debug/testing
window.getChessBoardArray = getBoardArray;
window.updateChessBoardFromDom = updateBoardFromDom;
window.applyMoveSAN = applyMoveSAN;
// Expose helper functions for debugging
window.playPieceToSquare = playPieceToSquare;
window.parsePieceAndDestFromNormalized = parsePieceAndDestFromNormalized;
// start observing when the script loads (if DOM present)
setTimeout(observeMoveList, 500);
