document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');

    startBtn.addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                window.dispatchEvent(new Event('voiceChessStart'));
            }
        }).catch(err => console.error(err));
    });

    stopBtn.addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                window.dispatchEvent(new Event('voiceChessStop'));
            }
        }).catch(err => console.error(err));
    });
});
