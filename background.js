// background.js
chrome.action.onClicked.addListener((tab) => {
    if (tab.id && tab.url && tab.url.includes("chess.com")) {
        chrome.tabs.sendMessage(tab.id, { action: "TOOLBAR_ICON_CLICKED" }, () => {
            if (chrome.runtime.lastError) {
                // Silently catch errors if the tab isn't fully loaded yet
                console.warn("VocalChess: Tab not ready to receive messages.");
            }
        });
    }
});