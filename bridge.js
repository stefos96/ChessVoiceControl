// bridge.js
(function() {
    const extPath = chrome.runtime.getURL('');
    document.documentElement.setAttribute('data-ext-path', extPath);
})();

// bridge.js (ISOLATED)
console.log("Bridge Script Active");

function relayToMain() {
    chrome.storage.sync.get(['autoConfirm', 'enableTTS', 'enableVoice', 'autoNextPuzzle', 'selectedMicrophoneId'], (result) => {
        window.dispatchEvent(new CustomEvent('CHESS_VOICE_SETTINGS', { detail: result }));
    });
}

// 🆕 Listen for the toolbar click from background.js and forward it to content.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "TOOLBAR_ICON_CLICKED") {
        window.dispatchEvent(new CustomEvent('TOGGLE_CHESS_POPUP_DOM'));
        sendResponse({ status: "ok" });
    }
});

// 1. Listen for Storage Changes
chrome.storage.onChanged.addListener(() => relayToMain());

// 2. Listen for "I'm ready" from content.js
window.addEventListener('REQUEST_CHESS_SETTINGS', () => {
    console.log("Bridge Script Active: Main world requested settings. Responding...");
    relayToMain();
});

// bridge.js (ISOLATED)

// Listen for save requests from the MAIN world popup and write them to extension storage
window.addEventListener('SAVE_CHESS_SETTING', (event) => {
    const { key, value } = event.detail;

    chrome.storage.sync.get([key], (result) => {
        if (result[key] !== value) {
            const data = {};
            data[key] = value;
            chrome.storage.sync.set(data);
        }
    });
});

// 3. Keep the initial relay just in case
relayToMain();