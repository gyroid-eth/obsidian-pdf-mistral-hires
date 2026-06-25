# pdf-mistral (high-resolution fork)

Obsidian plugin to convert a PDF into Markdown using **Mistral OCR**, extracting both text and figures.

This is a **fork of [Mekann2904/obsidian-pdf-mistral-plugin](https://github.com/Mekann2904/obsidian-pdf-mistral-plugin)** by [Mekann](https://note.com/mekann), with one major addition: **high-resolution figure extraction**.

> 日本語の概要は下部「概要 (Japanese)」を参照。

## What this fork adds

The original plugin saves the figure images exactly as Mistral OCR returns them — these are low-resolution, JPEG-compressed crops (~150 DPI). This fork instead:

1. Re-renders the **original PDF page locally with pdf.js at a high DPI** (default 300).
2. Crops each figure using the **bounding-box coordinates** from the Mistral OCR response.
3. Saves the result as a crisp **PNG**.

If high-resolution rendering fails for any image, it falls back to the original low-resolution behavior for that image, so nothing breaks.

A new setting **Image Render DPI** (default 300, range 150–600) controls the output resolution.

## Features

- Convert PDF → Markdown via Mistral OCR
- **High-resolution figure extraction** (pdf.js re-render + bbox crop → PNG) ⭐ this fork
- Figures embedded with Obsidian-style links (`![[...]]`)
- Configurable output folders

## Install (manual)

1. Build, or download a release ZIP.
2. Copy `main.js`, `manifest.json`, `styles.css`, and `pdf.worker.min.js` into
   `<Vault>/.obsidian/plugins/pdf-mistral-plugin/`.
3. Enable the plugin in Obsidian → Community plugins.

`isDesktopOnly` is true — high-resolution rendering uses pdf.js + canvas, which require the desktop app.

## Build

```bash
npm install
npm run build   # tsc -noEmit + esbuild (production)
```

`npm run build` produces `main.js` and copies `pdf.worker.min.js` (from `pdfjs-dist`) into the project root. Ship both, plus `manifest.json` and `styles.css`, in a release.

## Settings

| Setting | Description |
|---|---|
| Markdown Output Folder | Folder for the generated Markdown (relative to vault root) |
| Images Output Folder | Base path for images (relative to vault root) |
| Images Folder Name | Subfolder name for images (default `pdf-mistral-images`) |
| Image Render DPI | High-resolution render DPI (default 300, 150–600) ⭐ this fork |
| Mistral API Key | Your Mistral API key (get one at [mistral.ai](https://mistral.ai/)) |

## Usage

1. Command palette (Ctrl/Cmd + P) → `Convert PDF to Markdown with images`.
2. Pick a PDF in the file dialog.
3. OCR runs; a `.md` file is written and figures are saved as high-resolution PNG and embedded as `![[...]]`.

## Notes

- A Mistral API key is required (you bring your own; you pay Mistral directly).
- OCR accuracy depends on the PDF quality and the Mistral OCR model.
- Some layouts may still produce imperfect extraction.

## Credits

- **Original plugin**: [Mekann2904/obsidian-pdf-mistral-plugin](https://github.com/Mekann2904/obsidian-pdf-mistral-plugin) by [Mekann](https://note.com/mekann) — release announcement: <https://note.com/mekann/n/na5ad9a84d96f>
- **High-resolution fork**: gyroid
- Built on the [Obsidian sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin) scaffold.

Bundled third-party libraries and their licenses are listed in [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md).

## License

MIT — see [LICENSE](LICENSE). Original work © Mekann; high-resolution additions © gyroid.

---

## 概要 (Japanese)

Obsidian 上で PDF を Mistral OCR で Markdown 化し、本文と図版を抽出するプラグインです。**[Mekann](https://note.com/mekann) さんの [obsidian-pdf-mistral-plugin](https://github.com/Mekann2904/obsidian-pdf-mistral-plugin) のフォーク**で、**図版の高解像度抽出**を追加しています。

元プラグインは Mistral OCR が返す低解像度（約150DPI・JPEG）の図をそのまま保存しますが、本フォークは **元PDFを pdf.js で高DPI（既定300）再レンダリング → OCRのbbox座標で切り出し → 鮮明なPNG保存** に置き換えています（失敗時は画像単位で従来挙動にフォールバック）。設定 **Image Render DPI**（既定300・150〜600）で解像度を調整できます。
