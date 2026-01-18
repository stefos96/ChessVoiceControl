(function() {
    if (window.__voiceChessInjected) return;
    window.__voiceChessInjected = true;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const SpeechGrammarList = window.SpeechGrammarList || window.webkitSpeechGrammarList;
    // Vosk mode flag
    let usingVosk = false;
    let mediaStream = null;
    let mediaRecorder = null;
    let audioContext = null;
    let socket = null;
     if (!SpeechRecognition) {
         window.postMessage({ source: 'voiceChessPage', type: 'error', error: 'SpeechRecognition not available' }, '*');
        // Do not return — Vosk mode may be used instead
     }

    let recognition = null;
    let shouldKeepRunning = false;

    function buildGrammar() {
        // A simple JSGF grammar to bias recognition toward chess vocabulary.
        // Many browsers ignore grammars, but when available they help.
        const grammar = `#JSGF V1.0; grammar chess; public <move> = ( pawn | knight | bishop | rook | queen | king | castle | castle kingside | castle queenside ) ( to | takes | take | capture | captures )? ( a | b | c | d | e | f | g | h ) ( one | two | three | four | five | six | seven | eight | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 ) ;`;
        return grammar;
    }

    function normalizeTranscript(t) {
        if (!t) return '';
        let s = t.toLowerCase().trim();

        // remove common filler words
        s = s.replace(/\b(please|the|a|an|hey|um|uh|like|so)\b/g, ' ');

        // homophones and common misrecognitions
        s = s.replace(/\bnight\b/g, 'knight');
        s = s.replace(/\btoo\b/g, 'to');
        s = s.replace(/\btwo\b/g, '2');
        s = s.replace(/\bto\b/g, 'to');
        s = s.replace(/\bfor\b/g, '4'); // e.g. 'e four' or 'for' -> 4

        // number words -> digits
        s = s.replace(/\bone\b/g, '1');
        s = s.replace(/\btwo\b/g, '2');
        s = s.replace(/\bthree\b/g, '3');
        s = s.replace(/\bfour\b/g, '4');
        s = s.replace(/\bfive\b/g, '5');
        s = s.replace(/\bsix\b/g, '6');
        s = s.replace(/\bseven\b/g, '7');
        s = s.replace(/\beight\b/g, '8');

        // Map O-O phrasing
        s = s.replace(/castle\s*kingside/gi, 'o-o');
        s = s.replace(/castle\s*queenside/gi, 'o-o-o');

        // compact spaced file+rank: e.g. 'e four' -> 'e4' or 'e 4' -> 'e4'
        s = s.replace(/\b([a-h])\s+([1-8])\b/g, '$1$2');
        // sometimes transcripts put rank first 'four e' unlikely but handle file spelled-out before/after
        s = s.replace(/\b([1-8])\s+([a-h])\b/g, '$2$1');

        // collapse multiple spaces
        s = s.replace(/\s+/g, ' ').trim();
        return s;
    }

    function createRecognition() {
        recognition = new SpeechRecognition();
        recognition.lang = 'en-US';
        recognition.continuous = true;
        recognition.interimResults = true;

        // Attach grammar when available
        try {
            const sgr = buildGrammar();
            if (SpeechGrammarList) {
                const gl = new SpeechGrammarList();
                gl.addFromString(sgr, 1);
                recognition.grammars = gl;
            }
        } catch (e) {
            // ignore; optional optimization
        }

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
            const raw = Array.from(event.results)
                .map(r => r[0].transcript)
                .join('')
                .trim();
            const isFinal = event.results[event.results.length - 1].isFinal;

            const normalized = normalizeTranscript(raw);
            // Send both raw and normalized to the content script; content can decide which to use
            window.postMessage({ source: 'voiceChessPage', type: 'result', transcript: raw, normalizedTranscript: normalized, isFinal }, '*');
        };
    }

    window.addEventListener('message', (ev) => {
        const d = ev.data || {};
        if (!d || d.source !== 'voiceChessContent') return;
        if (d.type === 'start') {
            // If backend requested Vosk, page will have been told to start audio streaming
            if (d.mode === 'vosk') {
                usingVosk = true;
                startVoskCapture();
                return;
            }

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
            if (usingVosk) {
                stopVoskCapture();
                usingVosk = false;
            }
        }
    }, false);

    // Start capturing raw audio for Vosk via WebAudio/AudioWorklet or ScriptProcessorNode
    async function startVoskCapture() {
        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const source = audioContext.createMediaStreamSource(mediaStream);

            // ScriptProcessorNode as a fallback for AudioWorklet
            const bufferSize = 4096;
            const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

            source.connect(processor);
            processor.connect(audioContext.destination);

            processor.onaudioprocess = (e) => {
                const input = e.inputBuffer.getChannelData(0);
                // Convert float samples to 16-bit PCM
                const pcm16 = floatTo16BitPCM(input);
                // Base64-encode and post to content script
                const b64 = arrayBufferToBase64(pcm16.buffer);
                window.postMessage({ source: 'voiceChessPage', type: 'audio-chunk', chunk: b64, mimeType: 'audio/raw' }, '*');
            };

            // store for stop
            mediaRecorder = processor;
        } catch (e) {
            window.postMessage({ source: 'voiceChessPage', type: 'error', error: 'microphone access failed: ' + e.message }, '*');
        }
    }

    function stopVoskCapture() {
        try {
            if (mediaRecorder && audioContext) {
                mediaRecorder.disconnect();
                audioContext.close();
            }
        } catch (e) {}
        try { if (mediaStream) mediaStream.getTracks().forEach(t=>t.stop()); } catch (e) {}
        mediaRecorder = null; audioContext = null; mediaStream = null;
    }

    function floatTo16BitPCM(float32Array) {
        const l = float32Array.length;
        const buf = new Int16Array(l);
        for (let i = 0; i < l; i++) {
            let s = Math.max(-1, Math.min(1, float32Array[i]));
            buf[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return buf;
    }

    function arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    // cleanup helper (callable by injected code removal if needed)
    window.__voiceChessInjectedCleanup = () => {
        shouldKeepRunning = false;
        if (recognition) {
             try { recognition.stop(); } catch (e) {}
             recognition = null;
         }
        window.__voiceChessInjected = false;
    };
 })();
