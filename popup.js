// popup.js
console.log('Popup script loaded');

const autoConfirm = document.getElementById('autoConfirm');
const enableTTS = document.getElementById('enableTTS');
const enableVoice = document.getElementById('enableVoice');
const autoNextPuzzle = document.getElementById('autoNextPuzzle');
const microphoneSelect = document.getElementById('microphoneSelect');

// Load saved settings
chrome.storage.sync.get(['autoConfirm', 'enableTTS', 'enableVoice', 'autoNextPuzzle', 'selectedMicrophoneId'], (result) => {
    autoConfirm.checked = result.autoConfirm || false;
    enableTTS.checked = result.enableTTS !== false;
    enableVoice.checked = result.enableVoice !== false;
    autoNextPuzzle.checked = result.autoNextPuzzle || false;
    const savedMicId = result.selectedMicrophoneId || '';
    loadAudioDevices(savedMicId);
});

// Save on change - Fixed the listener assignments
autoConfirm.addEventListener('change', () => saveAndNotify('autoConfirm', autoConfirm.checked));
enableTTS.addEventListener('change', () => saveAndNotify('enableTTS', enableTTS.checked));
enableVoice.addEventListener('change', () => saveAndNotify('enableVoice', enableVoice.checked));
autoNextPuzzle.addEventListener('change', () => saveAndNotify('autoNextPuzzle', autoNextPuzzle.checked));
microphoneSelect.addEventListener('change', () => {
    const selectedId = microphoneSelect.value;
    saveAndNotify('selectedMicrophoneId', selectedId);
});

// Enumerate and populate audio input devices
async function loadAudioDevices(savedMicId) {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(device => device.kind === 'audioinput');
        
        // Clear existing options
        microphoneSelect.innerHTML = '';
        
        if (audioInputs.length === 0) {
            microphoneSelect.innerHTML = '<option value="">No microphones found</option>';
            return;
        }
        
        // Add all available microphones
        audioInputs.forEach((device, index) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.textContent = device.label || `Microphone ${index + 1}`;
            microphoneSelect.appendChild(option);
        });
        
        // Select the saved microphone (or first one)
        if (savedMicId && audioInputs.some(d => d.deviceId === savedMicId)) {
            microphoneSelect.value = savedMicId;
        } else if (audioInputs.length > 0) {
            microphoneSelect.value = audioInputs[0].deviceId;
        }
    } catch (error) {
        console.error('Error enumerating audio devices:', error);
        microphoneSelect.innerHTML = '<option value="">Error loading devices</option>';
    }
}

// Request permissions and refresh devices when popup opens
navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    // Just requesting permission to get device labels, immediately stop
    stream.getTracks().forEach(track => track.stop());
    // Reload devices after permission is granted
    const savedMicId = microphoneSelect.value || '';
    loadAudioDevices(savedMicId);
}).catch(err => {
    console.log('Microphone permission needed:', err);
});

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