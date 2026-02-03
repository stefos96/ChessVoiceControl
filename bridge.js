// bridge.js
(function() {
    const extPath = chrome.runtime.getURL('');
    document.documentElement.setAttribute('data-ext-path', extPath);
})();

// bridge.js (ISOLATED)
console.log("Bridge Script Active");

function relayToMain() {
    chrome.storage.sync.get(['autoConfirm', 'enableTTS', 'enableVoice'], (result) => {
        window.dispatchEvent(new CustomEvent('CHESS_VOICE_SETTINGS', { detail: result }));
        console.log("🌉 Bridge relayed to Main:", result);
    });
}

// 1. Listen for Storage Changes
chrome.storage.onChanged.addListener(() => relayToMain());

// 2. Listen for "I'm ready" from content.js
window.addEventListener('REQUEST_CHESS_SETTINGS', () => {
    console.log("🌉 Main world requested settings. Responding...");
    relayToMain();
});

// 3. Keep the initial relay just in case
relayToMain();