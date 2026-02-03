// popup.js
console.log('Popup script loaded');

const autoConfirm = document.getElementById('autoConfirm');
const enableTTS = document.getElementById('enableTTS');
const enableVoice = document.getElementById('enableVoice');

// Load saved settings
chrome.storage.sync.get(['autoConfirm', 'enableTTS', 'enableVoice'], (result) => {
    autoConfirm.checked = result.autoConfirm || false;
    enableTTS.checked = result.enableTTS !== false;
    enableVoice.checked = result.enableVoice !== false;
});

// Save on change - Fixed the listener assignments
autoConfirm.addEventListener('change', () => saveAndNotify('autoConfirm', autoConfirm.checked));
enableTTS.addEventListener('change', () => saveAndNotify('enableTTS', enableTTS.checked)); // Fixed key here
enableVoice.addEventListener('change', () => saveAndNotify('enableVoice', enableVoice.checked)); // Fixed key here

function saveAndNotify(key, value) {
    const data = {};
    data[key] = value;

    // 1. Save to storage (triggers the Bridge listener)
    chrome.storage.sync.set(data);

    // 2. Direct Ping (Backup for the Bridge listener)
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {type: "SETTING_CHANGE", key: key, value: value});
        }
    });
}