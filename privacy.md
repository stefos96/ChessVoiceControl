# Privacy Policy for VocalChess: Voice Control for Chess.com
Last Updated: July 2, 2026

## 1. Introduction
"VocalChess: Voice Control for Chess.com" ("we," "our," or "the Extension") is committed to protecting your privacy. This Privacy Policy explains how information is handled within the Extension. Because we value transparency and follow the Principle of Least Privilege, our core design ensures that your data—especially your voice—never leaves your local machine.

## 2. Information Collection and Processing
We believe that your data belongs to you. VocalChess does not collect, store, or transmit any personally identifiable information (PII) or telemetry to external servers.

### Voice and Audio Data (audioCapture)
The Extension processes your voice commands locally on your device using bundled processing libraries (Vosk). Your audio recordings are:
- Never recorded to disk
- Never transmitted to any remote servers
- Never sent to the internet

Voice-to-text processing occurs entirely in memory within your browser environment. No audio data leaves your device.

### Web Page Interaction (activeTab / Content Scripts)
The Extension interacts with chess board elements exclusively on https://www.chess.com/ to:
- Visually highlight board spaces
- Execute the moves you speak

It does not:
- Monitor or scrape your personal profile data
- Access your credentials or authentication tokens
- Collect your chat logs or playing history
- Transmit any data to external servers

## 3. Use of Permissions
To enable hands-free chess control, the Extension requests the following permissions. Each is strictly utilized for core functionality:

### audioCapture
Used solely to access your microphone input when you choose to activate voice controls.

### storage
Used to store your local preference settings (e.g., custom voice command triggers, language/model configurations) directly in your browser's chrome.storage. This data never leaves your device.

### activeTab
Used to securely interact with the specific Chess.com tab you are actively playing on, ensuring the extension doesn't passively read tabs in the background.

## 4. Script Execution Environments
VocalChess uses separate script environments to securely automate moves:

### Isolated Context
General orchestration and message passing logic run safely inside the extension's isolated sandbox.

### Main Page Context (MAIN world)
The core control script interacts strictly with Chess.com DOM elements on active boards to interpret and visually render overlays or trigger moves. No user data is captured or logged from the underlying website context.

## 5. Third-Party Services
The extension is entirely self-contained and does not rely on external services or CDNs. All required libraries (Vosk) and models are bundled directly within the extension.

## 6. Compliance with Chrome Web Store Policies
This Extension fully complies with the Chrome Web Store User Data Policy, including its Limited Use requirements:

- We only utilize requested permissions to provide the direct user-facing voice functionality of the extension.
- We do not sell, rent, lease, or monetize your data under any circumstances.
- We do not utilize your audio inputs or data profiles for marketing, tracking, or profiling.
- All processing occurs locally on your device with no data transmission to external services.

## 7. Changes to This Policy
We may update this Privacy Policy from time to time to accommodate new features or regulatory requirements. Any updates will be reflected with a revised "Last Updated" date at the top of this document.

## 8. Contact Information
If you have any questions or feedback regarding this Privacy Policy or our local processing practices, please reach out via our GitHub repository at https://github.com/stefos96/ChessVoiceControl