// bridge.js
(function() {
    const extPath = chrome.runtime.getURL('');
    document.documentElement.setAttribute('data-ext-path', extPath);
    console.log("Bridge set path to:", extPath);
})();