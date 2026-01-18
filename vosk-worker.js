// Vosk Worker: attempts to load a bundled `vosk.js` runtime and a model directory
// Expects to receive messages:
// { type: 'init', modelPath: '<relative-path-under-extension-or-url>' }
// { type: 'audio-chunk', chunk: '<base64-encoded 16-bit PCM Little-Endian>', sampleRate: 16000 }
// { type: 'shutdown' }

let recognizer = null;
let model = null;
let initialized = false;
let sampleRate = 16000;
let currentGrammar = null; // store grammar string if provided

async function postError(msg) {
    self.postMessage({ type: 'error', message: String(msg) });
}

async function initVosk(modelPath, grammar) {
    currentGrammar = grammar || null;
    try {
        // Try to load vosk.js relative to this worker file. The extension should include vosk.js
        // in web_accessible_resources so importScripts can access it.
        importScripts('vosk.js');
    } catch (e) {
        await postError('Failed to import vosk.js. Please include a browser-ready vosk.js in the extension and list it in web_accessible_resources. Error: ' + e.message);
        return false;
    }

    if (typeof Vosk === 'undefined' && typeof Module === 'undefined') {
        await postError('vosk.js loaded but Vosk Module not found; ensure vosk.js exposes a global `Vosk` or `Module` interface compatible with browser builds.');
        return false;
    }

    // Model initialization is build-dependent. Many vosk.js browser builds expose `Vosk` with Model and Recognizer classes.
    try {
        // If Vosk global exists and has Model, use it.
        if (typeof Vosk !== 'undefined' && typeof Vosk.Model !== 'undefined') {
            model = new Vosk.Model(modelPath || 'vosk-model');
            sampleRate = model.sampleRate || 16000;

            // Attempt to create a recognizer that supports grammar.
            // Different builds expose different constructors: KaldiRecognizer(model, sr, grammar) or Recognizer({model, sampleRate, grammar})
            if (typeof Vosk.KaldiRecognizer !== 'undefined') {
                // some builds use KaldiRecognizer(model, sampleRate, grammar)
                recognizer = currentGrammar ? new Vosk.KaldiRecognizer(model, sampleRate, currentGrammar) : new Vosk.KaldiRecognizer(model, sampleRate);
            } else if (typeof Vosk.Recognizer === 'function') {
                try {
                    // Preferred: options object with grammar
                    if (currentGrammar) {
                        recognizer = new Vosk.Recognizer({ model: model, sampleRate: sampleRate, grammar: currentGrammar });
                    } else {
                        recognizer = new Vosk.Recognizer({ model: model, sampleRate: sampleRate });
                    }
                } catch (e) {
                    // Fallback to older constructor
                    recognizer = new Vosk.Recognizer(model, sampleRate);
                }
            } else {
                // fallback
                recognizer = new Vosk.Recognizer(model, sampleRate);
            }

            initialized = true;
            self.postMessage({ type: 'ready', sampleRate });
            return true;
        }

        // Some builds use Module to create a recognizer factory
        if (typeof Module !== 'undefined' && Module.VoskModel) {
            model = new Module.VoskModel(modelPath || 'vosk-model');
            sampleRate = model.sampleRate || 16000;

            // Try KaldiRecognizer on Module
            if (typeof Module.KaldiRecognizer !== 'undefined') {
                recognizer = currentGrammar ? new Module.KaldiRecognizer(model, sampleRate, currentGrammar) : new Module.KaldiRecognizer(model, sampleRate);
            } else if (typeof Module.VoskRecognizer !== 'function') {
                // Some builds expose a recognizer constructor differently
                recognizer = new Module.VoskRecognizer(model, sampleRate);
            } else {
                recognizer = new Module.VoskRecognizer(model, sampleRate);
            }

            initialized = true;
            self.postMessage({ type: 'ready', sampleRate });
            return true;
        }

        await postError('vosk.js loaded but no compatible API found (expected Vosk.Model/Recognizer or Module.VoskModel).');
        return false;
    } catch (e) {
        await postError('Failed to initialize Vosk model/recognizer: ' + e.message);
        return false;
    }
}

function decodeBase64ToInt16(b64) {
    const binary = atob(b64);
    const len = binary.length;
    const buf = new ArrayBuffer(len);
    const view = new Uint8Array(buf);
    for (let i = 0; i < len; i++) view[i] = binary.charCodeAt(i);
    // Interpret as 16-bit PCM little-endian
    return new Int16Array(buf);
}

self.onmessage = async function(e) {
    const msg = e.data || {};

    if (msg.type === 'init') {
        const path = msg.modelPath || 'vosk-model';
        const grammar = msg.grammar || null;
        const ok = await initVosk(path, grammar);
        if (!ok) {
            self.postMessage({ type: 'not-ready' });
        }
        return;
    }

    if (msg.type === 'set-grammar') {
        // Recreate recognizer with new grammar without reloading model
        try {
            if (!model) {
                self.postMessage({ type: 'error', message: 'Model not loaded; cannot set grammar' });
                return;
            }

            // Free previous recognizer if API provides free
            try { if (recognizer && typeof recognizer.free === 'function') recognizer.free(); } catch (e) {}
            recognizer = null;
            currentGrammar = msg.grammar || null;

            // Attempt to create recognizer with grammar similar to initVosk logic
            if (typeof Vosk !== 'undefined' && typeof Vosk.KaldiRecognizer !== 'undefined') {
                recognizer = currentGrammar ? new Vosk.KaldiRecognizer(model, sampleRate, currentGrammar) : new Vosk.KaldiRecognizer(model, sampleRate);
            } else if (typeof Vosk !== 'undefined' && typeof Vosk.Recognizer === 'function') {
                try {
                    if (currentGrammar) {
                        recognizer = new Vosk.Recognizer({ model: model, sampleRate: sampleRate, grammar: currentGrammar });
                    } else {
                        recognizer = new Vosk.Recognizer({ model: model, sampleRate: sampleRate });
                    }
                } catch (e) {
                    recognizer = new Vosk.Recognizer(model, sampleRate);
                }
            } else if (typeof Module !== 'undefined' && typeof Module.KaldiRecognizer !== 'undefined') {
                recognizer = currentGrammar ? new Module.KaldiRecognizer(model, sampleRate, currentGrammar) : new Module.KaldiRecognizer(model, sampleRate);
            } else if (typeof Module !== 'undefined' && Module.VoskRecognizer) {
                recognizer = new Module.VoskRecognizer(model, sampleRate);
            }

            self.postMessage({ type: 'ready', sampleRate });
        } catch (e) {
            self.postMessage({ type: 'error', message: 'Failed to set grammar: ' + String(e) });
        }
        return;
    }

    if (msg.type === 'audio-chunk') {
        if (!initialized || !recognizer) {
            // Not initialized; reply with a helpful message so page can fallback
            self.postMessage({ type: 'error', message: 'Vosk recognizer not initialized. Call init with modelPath.' });
            return;
        }

        try {
            const chunkB64 = msg.chunk;
            const pcm16 = decodeBase64ToInt16(chunkB64);

            // Feed PCM to recognizer. API varies between builds; try common methods.
            if (typeof recognizer.acceptWaveform === 'function') {
                // Some implementations accept Int16Array or Float32Array
                const accepted = recognizer.acceptWaveform(pcm16);
                if (accepted) {
                    const result = recognizer.result();
                    // result may be an object or string
                    const text = (result && result.text) ? result.text : (result && result.result ? result.result : result) || '';
                    self.postMessage({ type: 'result', partial: '', final: text });
                } else {
                    const partial = recognizer.partialResult ? recognizer.partialResult() : (recognizer.partial ? recognizer.partial() : '');
                    const partialText = (partial && partial.text) ? partial.text : (partial && partial.partial ? partial.partial : partial) || '';
                    self.postMessage({ type: 'result', partial: partialText, final: '' });
                }
                return;
            }

            if (typeof recognizer.feed === 'function') {
                recognizer.feed(pcm16);
                const partial = recognizer.getPartial() || '';
                self.postMessage({ type: 'result', partial, final: '' });
                return;
            }

            // As a last resort, post that the chunk was received
            self.postMessage({ type: 'result', partial: '', final: '', note: 'audio chunk received but recognizer API not supported in this build' });
        } catch (err) {
            self.postMessage({ type: 'error', message: 'Error processing audio chunk: ' + String(err) });
        }
        return;
    }

    if (msg.type === 'shutdown') {
        try {
            if (recognizer && typeof recognizer.free === 'function') recognizer.free();
            if (model && typeof model.free === 'function') model.free();
        } catch (e) {}
        self.postMessage({ type: 'shutdown' });
        close();
        return;
    }

    // Unknown message
    self.postMessage({ type: 'error', message: 'Unknown message type: ' + (msg.type || '<none>') });
};
