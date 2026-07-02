# Privacy Policy for VocalChess: Voice Control for Chess.com
Last Updated: July 2, 2026

1. Introduction
"VocalChess: Voice Control for Chess.com" ("we," "our," or "the Extension") is committed to protecting your privacy. This Privacy Policy explains how information is handled within the Extension. Because we value transparency and follow the Principle of Least Privilege, our core design ensures that your data—especially your voice—never leaves your local machine.

2. Information Collection and Processing
We believe that your data belongs to you. VocalChess does not collect, store, or transmit any personally identifiable information (PII) or telemetry to external servers.

Voice and Audio Data (audioCapture): The Extension processes your voice commands locally on your device using bundled processing libraries (such as Vosk/ONNX/Piper). Your audio recordings are never recorded, never saved to disk, and never transmitted over the internet to any remote cloud servers. Voice-to-text processing occurs strictly in memory within your browser environment.

Web Page Interaction (activeTab / Content Scripts): The Extension interacts with chess board elements exclusively on [https://www.chess.com/](https://www.chess.com/)* to visually highlight spaces and programmatically execute the moves you speak. It does not monitor or scrape your personal profile data, credentials, chat logs, or playing history.

3. Use of Permissions
To enable hands-free chess control, the Extension requests the following permissions in its manifest.json. Each is strictly utilized for core functionality:

audioCapture: Used solely to access your microphone input when you choose to activate voice controls.

storage: Used to store your local preference settings (e.g., custom voice command triggers or language/model configurations) directly in your browser via chrome.storage.

activeTab: Used to securely interact with the specific Chess.com tab you are actively playing on, ensuring the extension doesn't passively read tabs in the background.

4. Script Execution Environments
VocalChess uses separate script environments to securely automate moves:

Isolated Context: General orchestration and message passing logic run safely inside an isolated extensions sandbox (ISOLATED world).

Main Page Context (MAIN world): The core control script (content.js) interacts strictly with the Chess.com DOM elements on active boards to interpret and visually render overlays or trigger user moves. No user data is captured or logged from the underlying website context.

5. Third-Party Services
While the extension references assets locally, some configurations may query secure public delivery networks or repositories (such as Hugging Face or JSDelivr CDNs) to stream necessary underlying translation files or language model components. These networks may process standard technical log parameters (like your IP address) as dictated by their own independent privacy frameworks, but they never receive any speech or internal data from VocalChess.

6. Compliance with Chrome Web Store Policies
This Extension fully complies with the Chrome Web Store User Data Policy, including its Limited Use requirements:

We only utilize requested permissions to provide and improve the direct user-facing voice functionality of the extension.

We do not sell, rent, lease, or monetize your data under any circumstances.

We do not utilize your audio inputs or data profiles for marketing, tracking, or profiling.

7. Changes to This Policy
We may update this Privacy Policy from time to time to accommodate new features or regulatory requirements. Any updates will be reflected with a revised "Last Updated" date at the top of this document.

8. Contact Information
If you have any questions or feedback regarding this Privacy Policy or local processing practices, please reach out via our GitHub repository or contact the developer account listed in the Chrome Web Store Dashboard.