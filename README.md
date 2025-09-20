# SnapBubble

<div align="center">
  <img src="SnapBubble-01.png" alt="SnapBubble Logo" width="128" height="128">
  <h3>Translate any speech bubble, anywhere</h3>
  <p><em>Academic and research tool for image text translation</em></p>
</div>

---

## Overview

SnapBubble is a browser extension that performs OCR (Optical Character Recognition) on text within images and overlays translations directly on web pages. This tool is designed for academic research, accessibility purposes, and personal study.

### What’s new

- **Batch translation** (chapter-level or per-image): collect all bubble text and translate in one/few calls. less API noise, faster.
- **Progressive rendering**: overlays show up as soon as each image finishes (no long waits).
- **Gemini 2.5 Flash** as default Gemini model. Clean provider list in the popup.
- **Manual Select** (drag area) with one overlay per speech bubble – no more tiny stacked tags.
- **One-bubble grouping**: simple neighbor logic that merges words into a single bubble box. Works for vertical and horizontal layouts.
- **HiDPI overlays**: crisp text on retina/zoomed displays.
- **Timeouts & stability**: OCR/requests won’t hang; automatic retry/guards.
- **Keyboard shortcuts** (Win/Mac) + small HUD improvements.

---

### Chrome/Edge
1. Download or clone this repository
2. Open `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the extension folder

### Firefox
1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select the `manifest.json` file

---

## Quick Start

1. **Install the extension** using the steps above
2. **Click the SnapBubble icon** in your browser toolbar
3. **Configure your settings**:
   - Select OCR language (or leave on Auto)
   - Choose translation provider and enter API key if needed
   - Set target language (e.g., `en`, `fr`, `es`)
4. **Click Start** and navigate to any webpage with images
5. **Watch translations appear** as magenta boxes overlay the original text

---

## Configuration

### OCR Settings
- **Force OCR Language**: Auto-detect or specify language for better accuracy
- **OCR Engine**: 
  - API 1 (Tesseract): Basic, fast
  - API 2 (Advanced): Default, balanced quality/speed
  - API 3 (Legacy): Older engine for compatibility

### Translation Providers

#### OpenAI GPT (Default)
- Requires API key
- Excellent for complex text
- Uses GPT-4o-mini model
- High-quality translations

#### Google Gemini
- **2.5 Flash** (default): fast, good quality, practical limits
- **1.5 Pro** / **2.0** also available if you need them
- Requires API key

### Keyboard Shortcuts

- Cross‑platform (Windows/Mac)
- Quick help in the HUD (Ctrl/Cmd + Alt + H)
- Clear error tracker (Ctrl/Cmd + Alt + E)
- Manual select toggle (Ctrl/Cmd + Alt + S)

<div align="center">
  <img src="shortcuts.png" alt="SnapBubble Shortcuts" style="max-width: 720px; width: 100%; border: 1px solid #ddd; border-radius: 6px;" />
  <br/>
  <em>Handy shortcuts to speed up your workflow</em>
</div>

### Community

- Discord: [`https://discord.gg/vckeW3cXxS`](https://discord.gg/vckeW3cXxS)

#### DeepL
- Requires API key
- High-quality translations
- Supports many language pairs

### API Keys

Important: No API keys are bundled or hardcoded in this extension. You must enter your own keys locally in the popup settings. Keys are stored only in your browser using `chrome.storage.local` and are never transmitted anywhere except directly to the providers you choose.

Where to get keys:
- **OCR.space**: [ocr.space](https://ocr.space/ocrapi/freekey) (Free tier available)
- **OpenAI**: [platform.openai.com](https://platform.openai.com/api-keys)
- **Google AI**: [makersuite.google.com](https://makersuite.google.com/app/apikey)
- **DeepL**: [deepl.com/pro-api](https://www.deepl.com/pro-api)

How to set keys:
1. Click the SnapBubble icon.
2. Enter your OCR API key (for OCR.Space) and Translation API key (OpenAI/Gemini/DeepL) in the fields provided.
3. Values are saved automatically to `chrome.storage.local` and used at runtime.

---

## Supported Languages

### OCR Languages
- **Auto-detection**
- **Chinese**: Simplified (chs), Traditional (cht)
- **Japanese** (jpn)
- **Korean** (kor)
- **European**: English, French, German, Spanish, Italian, Portuguese, Russian
- **Other**: Arabic, Hindi, Thai, Vietnamese

### Translation Target Languages
All major languages supported by your chosen translation provider.

---

## Technical Details

### Architecture
- **Pure client-side**: Everything runs in your browser - no backend, no server
- **Direct API calls**: Extension communicates directly with OCR.space and translation APIs
- **Smart caching**: OCR results cached locally to avoid duplicate processing
- **Dynamic concurrency**: Automatically adjusts processing speed based on performance

### Privacy
- Settings stored locally in browser
- Images sent only to your chosen OCR/translation APIs
- No analytics, tracking, or data collection
- Use your own API keys for complete control

---

## Troubleshooting

### Common Issues

**"Context invalidated" in debug panel**
- Refresh the page and click Start again

**No overlays appear**
- Lower the minimum image size setting
- Check that images aren't in cross-origin iframes
- Ensure your API keys are valid

**Poor OCR accuracy**
- Set the correct OCR language instead of Auto
- Try different OCR engines (API 1, 2, or 3)
- Ensure images are high enough resolution

**Translation errors**
- Verify your API key is correct and has credits
- Try a different translation provider
- Check the debug panel for error messages

### Debug Panel
The green debug panel shows:
- Processing status
- OCR results and word counts
- Translation progress
- Error messages

---

## Development

### Project Structure
```
/
├── manifest.json            # Extension manifest (MV3)
├── background/              # Service worker
│   └── service-worker.js
├── content/                 # Content script pipeline
│   └── content.js           # scanning, OCR, batching, overlays
├── popup/                   # Popup UI
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── lib/                     # Core modules
│   ├── utils.js             # settings, storage, error tracker
│   ├── ocr.js               # OCR.space + capture helpers
│   ├── ai_ocr.js            # OpenAI/Gemini vision OCR
│   ├── translate.js         # OpenAI/Gemini/DeepL translators
│   ├── overlay.js           # canvas overlay drawing
│   ├── manual-select.js     # drag-to-translate tool
│   └── segmentation.js      # word→bubble grouping (shared)
└── README.md
```

### Contributing
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

---

## Legal Notice

### Academic Use Only
This software is provided for academic research, accessibility, and educational purposes only. Users are responsible for ensuring their use complies with applicable laws and terms of service of third-party APIs.

### Disclaimer
- This tool is provided "as is" without warranty
- Users are responsible for their own API usage and costs
- No copyrighted content is hosted or distributed by this extension
- Users must respect the terms of service of websites they visit

### Third-Party Services
This extension uses third-party APIs:
- **OCR.space**: For optical character recognition
- **OpenAI**: For GPT-based translation
- **Google**: For Gemini-based translation  
- **DeepL**: For high-quality translation

Users are responsible for complying with these services' terms of use and managing their own API usage and costs.

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

```
MIT License

Copyright (c) 2025 SnapBubble

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Support

For issues, feature requests, or questions:
- Open an issue on GitHub
- Include reproduction steps and debug panel output
- Specify your browser version and extension version

---

<div align="center">
  <p><strong>SnapBubble</strong> - Making text in images accessible to everyone</p>
  <p><em>For academic research and accessibility purposes</em></p>
</div>