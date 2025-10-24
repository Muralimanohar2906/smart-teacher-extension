# Smart Teacher - YouTube Notes & Quiz (Unpacked extension)

## Install
1. Save the folder `smart-teacher-extension` with the files.
2. Open Chrome / Edge -> `chrome://extensions`.
3. Toggle **Developer mode**.
4. Click **Load unpacked** and select the folder.

## Usage
- Open any `youtube.com/watch?...` page.
- The content script auto-runs and places an overlay at the lower-right.
- Or open the extension popup and click **Inject**.

## Notes & Limitations
- This version relies on YouTube timedtext (captions). If captions are absent, it prompts the user.
- All processing is client-side. No remote servers are used by default.
- For higher-quality quizzes, integrate an LLM backend.

## Files
See file list in the repository root.

