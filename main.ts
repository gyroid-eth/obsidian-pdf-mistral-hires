import { App, Plugin, PluginSettingTab, Setting, TFile, Notice } from 'obsidian';
import { Buffer } from 'buffer';
import { Mistral } from '@mistralai/mistralai';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';

type PDFDocumentProxy = import('pdfjs-dist/types/src/display/api').PDFDocumentProxy;

interface MistralPageDimensions {
  dpi?: number;
  width?: number;
  height?: number;
}

interface MistralImage {
  id: string;
  imageBase64?: string;
  topLeftX?: number;
  topLeftY?: number;
  bottomRightX?: number;
  bottomRightY?: number;
}

interface MistralPage {
  index: number;
  markdown?: string;
  dimensions?: MistralPageDimensions;
  images?: MistralImage[];
}

interface MistralOCRResult {
  pages?: MistralPage[];
}

interface RenderedPdfPage {
  canvas: HTMLCanvasElement;
  dimensions: MistralPageDimensions;
}

const DEFAULT_IMAGE_RENDER_DPI = 300;
const MIN_IMAGE_RENDER_DPI = 150;
const MAX_IMAGE_RENDER_DPI = 600;
const MAX_RENDER_DIMENSION = 8000;

/**
 * プラグインの設定項目
 */
interface PDFToMarkdownSettings {
  // Markdownを出力するフォルダ（Vaultルートからの相対パス）空の場合はルート
  markdownOutputFolder: string;

  // 画像を保存する基準パス（Vaultルートからの相対パス）空の場合はルート
  imagesOutputFolder: string;

  // 画像フォルダ名（この名前でサブフォルダを作る）
  // デフォルトは "pdf-mistral-images"
  imagesFolderName: string;

  // Mistral API key
  mistralApiKey: string;

  // PDF.js rendering DPI used when extracting images from the source PDF
  imageRenderDPI: number;
}

/**
 * 設定項目のデフォルト値
 */
const DEFAULT_SETTINGS: PDFToMarkdownSettings = {
  markdownOutputFolder: '',
  imagesOutputFolder: '',
  imagesFolderName: 'pdf-mistral-images',
  mistralApiKey: '',
  imageRenderDPI: DEFAULT_IMAGE_RENDER_DPI
};

export default class PDFToMarkdownPlugin extends Plugin {
  settings: PDFToMarkdownSettings;

  async onload() {
    await this.loadSettings();
    this.configurePdfWorker();

    // コマンド: PDFをMarkdown（画像も出力）に変換
    this.addCommand({
      id: 'convert-pdf-to-markdown',
      name: 'Convert PDF to Markdown with images',
      callback: () => this.openFileDialogAndProcess()
    });

    // 設定タブ
    this.addSettingTab(new PDFToMarkdownSettingTab(this.app, this));
  }

  onunload() {
    // Pluginアンロード時の処理
  }

  configurePdfWorker(): void {
    const pluginDir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
    pdfjsLib.GlobalWorkerOptions.workerSrc = this.app.vault.adapter.getResourcePath(
      `${pluginDir}/pdf.worker.min.js`
    );
  }

  /**
   * PDFを選択するファイルダイアログを開き、選択した複数ファイルを順次処理
   */
  async openFileDialogAndProcess() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf';
    input.multiple = true;
    input.style.display = 'none';

    input.addEventListener('change', async () => {
      if (!input.files) return;
      const files = Array.from(input.files);
      new Notice(`Selected files: ${files.length}`);
      for (const file of files) {
        if (file.type !== 'application/pdf') {
          new Notice(`Skipping non-PDF file: ${file.name}`);
          continue;
        }
        new Notice(`Processing: ${file.name}`);
        try {
          await this.processPDF(file);
          new Notice(`Processed: ${file.name}`);
        } catch (err) {
          console.error(`Error processing file ${file.name}:`, err);
          new Notice(`Error processing file: ${file.name}`);
        }
      }
    });
    document.body.appendChild(input);
    input.click();
    document.body.removeChild(input);
  }

  /**
   * Mistral APIを使ってPDFをOCRし、Markdownファイルと画像をVaultに保存
   */
  async processPDF(file: File): Promise<void> {
    // PDF名（拡張子除去）
    const pdfBaseName = file.name.replace(/\.pdf$/i, '');

    // -------------- Markdown出力先 --------------
    const mdFolder = this.settings.markdownOutputFolder.trim();
    if (mdFolder) {
      // フォルダが指定されていれば、存在チェックと作成
      await this.createFolderIfNotExists(mdFolder);
    }

    // -------------- Mistralへのアップロード --------------
    const apiKey = this.settings.mistralApiKey.trim();
    if (!apiKey) {
      throw new Error("Mistral API key is not set in settings.");
    }
    const client = new Mistral({ apiKey });

    new Notice("Uploading PDF...");
    const arrayBuffer = await file.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer.slice(0));

    let pdfDoc: PDFDocumentProxy | null = null;
    let pdfDocDestroyed = false;
    const destroyPdfDoc = async () => {
      if (pdfDoc && !pdfDocDestroyed) {
        await pdfDoc.destroy();
        pdfDocDestroyed = true;
        pdfDoc = null;
      }
    };

    try {
      this.configurePdfWorker();
      pdfDoc = await pdfjsLib.getDocument({
        data: new Uint8Array(arrayBuffer.slice(0))
      }).promise;
    } catch (err) {
      console.error(`Error loading PDF with pdf.js. Falling back to Mistral images: ${file.name}`, err);
    }

    let uploaded;
    try {
      uploaded = await client.files.upload({
        file: { fileName: file.name, content: fileBuffer },
        purpose: "ocr" as any
      });
      new Notice("Upload complete");
    } catch (err) {
      await destroyPdfDoc();
      console.error(`Error uploading file: ${file.name}`, err);
      throw err;
    }

    // -------------- アップロードしたファイルのSignedURL取得 --------------
    let signedUrlResponse;
    try {
      signedUrlResponse = await client.files.getSignedUrl({ fileId: uploaded.id });
    } catch (err) {
      await destroyPdfDoc();
      console.error(`Error getting signed URL for file: ${file.name}`, err);
      throw err;
    }

    // -------------- OCR実行 (画像はBase64で返してもらう) --------------
    let ocrResponse;
    try {
      ocrResponse = await client.ocr.process({
        model: "mistral-ocr-latest",
        document: {
          type: "document_url",
          documentUrl: signedUrlResponse.url,
        },
        includeImageBase64: true,  // 画像をBase64形式で含む
      });
    } catch (err) {
      await destroyPdfDoc();
      console.error(`Error during OCR process for file: ${file.name}`, err);
      throw err;
    }

    // -------------- 画像保存先を決定 --------------
    //  ユーザが設定した "imagesOutputFolder"（空ならルート）と
    //  "imagesFolderName" を組み合わせたフォルダを作る
    const baseFolder = this.settings.imagesOutputFolder.trim();      // 出力先 (例: "some/subfolder")
    const folderName = this.settings.imagesFolderName.trim() || "pdf-mistral-images";

    // 両方とも空の場合は "pdf-mistral-images" にしてルートに出力
    // どちらかだけ指定されている場合はそれを結合
    let finalImagesPath = "";
    if (baseFolder && folderName) {
      finalImagesPath = `${baseFolder}/${folderName}`;
    } else if (baseFolder) {
      finalImagesPath = baseFolder;
    } else {
      // baseFolderが空の場合は folderName を使う (空なら pdf-mistral-images)
      finalImagesPath = folderName || "pdf-mistral-images";
    }

    await this.createFolderIfNotExists(finalImagesPath);

    // 1) 返却されたページを順に見て、Base64画像を保存
    // 2) Markdown中の画像参照を Obsidianリンク(![[...]])に書き換え
    let finalMd: string;
    try {
      finalMd = await this.combineMarkdownWithImages(
        ocrResponse as MistralOCRResult,
        pdfBaseName,
        finalImagesPath,
        pdfDoc
      );
    } finally {
      await destroyPdfDoc();
    }

    // -------------- Markdownをファイルとして保存 --------------
    try {
      const mdFilePath = mdFolder
        ? `${mdFolder}/${pdfBaseName}.md`
        : `${pdfBaseName}.md`; // フォルダ未指定ならルート

      await this.createOrUpdateFile(mdFilePath, finalMd);
      new Notice("Markdown saved with images");
    } catch (err) {
      console.error("Error creating or saving MD with images:", err);
    }
  }

  /**
   * OCRレスポンスを解析し、Base64画像をファイルに書き出し、
   * Markdownテキスト中の `![](imgId)` を Obsidian独自リンクに置換
   */
  async combineMarkdownWithImages(
    ocrResult: MistralOCRResult,
    pdfBaseName: string,
    finalImagesPath: string,
    pdfDoc: PDFDocumentProxy | null
  ): Promise<string> {
    if (!ocrResult.pages || !Array.isArray(ocrResult.pages)) {
      new Notice("OCR result does not contain pages.");
      return "";
    }

    // ページ順にソート
    const sortedPages = [...ocrResult.pages].sort((a: MistralPage, b: MistralPage) => {
      return (this.toFiniteNumber(a.index) ?? 0) - (this.toFiniteNumber(b.index) ?? 0);
    });

    let combinedMarkdown = "";
    for (const page of sortedPages) {
      let md = page.markdown || "";
      let renderedPage: RenderedPdfPage | null = null;
      const images = page.images || [];

      if (pdfDoc && images.length > 0) {
        try {
          renderedPage = await this.renderPdfPage(pdfDoc, page);
        } catch (err) {
          console.error(`Error rendering PDF page ${page.index + 1}. Falling back to Mistral images.`, err);
        }
      }

      // ページ内の画像を処理
      for (const imgObj of images) {
        const originalId = imgObj.id; // "img-0.jpeg" など

        // "img-0.jpeg" -> "img-0"
        const trimmedId = originalId.replace(/\.(jpg|jpeg|png)$/i, '');
        let imageFileName = `${pdfBaseName}_${trimmedId}.png`;
        let imageFilePath = `${finalImagesPath}/${imageFileName}`;
        let savedImage = false;

        if (renderedPage) {
          try {
            savedImage = await this.saveRenderedImageCrop(renderedPage, imgObj, imageFilePath);
          } catch (err) {
            console.error(`Error saving high-resolution crop for image ${originalId}. Falling back to Mistral image.`, err);
          }
        }

        if (!savedImage) {
          const base64 = imgObj.imageBase64;
          if (!base64 || base64.endsWith("...")) {
            console.warn(`Skipping empty or placeholder image: ${originalId}`);
            continue;
          }

          imageFileName = `${pdfBaseName}_${trimmedId}.jpeg`;
          imageFilePath = `${finalImagesPath}/${imageFileName}`;
          await this.saveBase64Image(base64, imageFilePath);
          savedImage = true;
        }

        if (!savedImage) {
          continue;
        }

        // Markdownテキストの参照を Obsidianリンクに変更
        // 例: "![](img-0.jpeg)" → "![[finalImagesPath/2503.10635v1_img-0.png]]"
        const escapedOriginalId = originalId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\!\\[[^\\]]*\\]\\((?:.*?)${escapedOriginalId}(?:.*?)\\)`, 'g');
        const obsidianLink = `![[${finalImagesPath}/${imageFileName}]]`;

        md = md.replace(regex, obsidianLink);
      }

      // ページを結合
      combinedMarkdown += md + "\n\n";
    }

    // Mistral OCR は数式を LaTeX の \( \) / \[ \] で返すが、Obsidian の
    // MathJax は $...$ / $$...$$ しか認識しないため変換する（未変換だと
    // 数式が生テキスト＝バックスラッシュ付きで「崩れて」表示される）。
    return this.convertMathDelimiters(combinedMarkdown);
  }

  // LaTeX の数式デリミタを Obsidian (MathJax) 形式へ変換する。
  //   \[ ... \]  ->  $$ ... $$   (ディスプレイ数式)
  //   \( ... \)  ->  $ ... $     (インライン数式)
  // 既に $ で書かれたコードブロック等を壊さないよう、デリミタ記号のみ置換する。
  convertMathDelimiters(md: string): string {
    return md
      .replace(/\\\[/g, "$$$$")  // \[ -> $$
      .replace(/\\\]/g, "$$$$")  // \] -> $$
      .replace(/\\\(/g, "$$")    // \( -> $
      .replace(/\\\)/g, "$$");   // \) -> $
  }

  async renderPdfPage(pdfDoc: PDFDocumentProxy, page: MistralPage): Promise<RenderedPdfPage> {
    const pageIndex = this.toFiniteNumber(page.index);
    if (pageIndex === null) {
      throw new Error("Missing page index.");
    }

    const dimensions = page.dimensions;
    if (!dimensions) {
      throw new Error("Missing Mistral page dimensions.");
    }

    const sourceWidth = this.toFiniteNumber(dimensions?.width);
    const sourceHeight = this.toFiniteNumber(dimensions?.height);
    if (sourceWidth === null || sourceWidth <= 0 || sourceHeight === null || sourceHeight <= 0) {
      throw new Error("Missing Mistral page dimensions.");
    }

    const pdfPage = await pdfDoc.getPage(pageIndex + 1);
    let scale = this.getImageRenderDPI() / 72;
    let viewport = pdfPage.getViewport({ scale });
    const longest = Math.max(viewport.width, viewport.height);

    if (longest > MAX_RENDER_DIMENSION) {
      scale = scale * (MAX_RENDER_DIMENSION / longest);
      viewport = pdfPage.getViewport({ scale });
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error("Could not create canvas context.");
    }

    await pdfPage.render({ canvasContext: ctx, viewport }).promise;
    pdfPage.cleanup();

    return { canvas, dimensions };
  }

  async saveRenderedImageCrop(
    renderedPage: RenderedPdfPage,
    imgObj: MistralImage,
    filePath: string
  ): Promise<boolean> {
    const sourceWidth = this.toFiniteNumber(renderedPage.dimensions.width);
    const sourceHeight = this.toFiniteNumber(renderedPage.dimensions.height);
    const topLeftX = this.toFiniteNumber(imgObj.topLeftX);
    const topLeftY = this.toFiniteNumber(imgObj.topLeftY);
    const bottomRightX = this.toFiniteNumber(imgObj.bottomRightX);
    const bottomRightY = this.toFiniteNumber(imgObj.bottomRightY);

    if (
      sourceWidth === null ||
      sourceWidth <= 0 ||
      sourceHeight === null ||
      sourceHeight <= 0 ||
      topLeftX === null ||
      topLeftY === null ||
      bottomRightX === null ||
      bottomRightY === null
    ) {
      return false;
    }

    const sx = renderedPage.canvas.width / sourceWidth;
    const sy = renderedPage.canvas.height / sourceHeight;
    const rawX0 = Math.min(topLeftX, bottomRightX) * sx;
    const rawY0 = Math.min(topLeftY, bottomRightY) * sy;
    const rawX1 = Math.max(topLeftX, bottomRightX) * sx;
    const rawY1 = Math.max(topLeftY, bottomRightY) * sy;

    const x0 = this.clamp(Math.round(rawX0), 0, renderedPage.canvas.width);
    const y0 = this.clamp(Math.round(rawY0), 0, renderedPage.canvas.height);
    const x1 = this.clamp(Math.round(rawX1), 0, renderedPage.canvas.width);
    const y1 = this.clamp(Math.round(rawY1), 0, renderedPage.canvas.height);
    const cropWidth = x1 - x0;
    const cropHeight = y1 - y0;

    if (cropWidth < 1 || cropHeight < 1) {
      console.warn(`Skipping image with empty crop: ${imgObj.id}`);
      return false;
    }

    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = cropWidth;
    cropCanvas.height = cropHeight;

    const cropCtx = cropCanvas.getContext('2d');
    if (!cropCtx) {
      throw new Error("Could not create crop canvas context.");
    }

    cropCtx.drawImage(
      renderedPage.canvas,
      x0,
      y0,
      cropWidth,
      cropHeight,
      0,
      0,
      cropWidth,
      cropHeight
    );

    const blob = await this.canvasToBlob(cropCanvas, 'image/png');
    const buffer = Buffer.from(await blob.arrayBuffer());
    await this.app.vault.adapter.writeBinary(filePath, buffer);
    console.log(`High-resolution PNG image saved: ${filePath}`);

    return true;
  }

  canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Canvas toBlob returned null."));
        }
      }, type);
    });
  }

  getImageRenderDPI(): number {
    const value = this.toFiniteNumber(this.settings.imageRenderDPI);
    if (value === null) {
      return DEFAULT_IMAGE_RENDER_DPI;
    }
    return this.clamp(Math.round(value), MIN_IMAGE_RENDER_DPI, MAX_IMAGE_RENDER_DPI);
  }

  toFiniteNumber(value: unknown): number | null {
    const numberValue = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
  }

  clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  /**
   * 指定フォルダが無ければ作成する
   */
  async createFolderIfNotExists(folderPath: string): Promise<void> {
    if (!(await this.app.vault.adapter.exists(folderPath))) {
      await this.app.vault.createFolder(folderPath);
    }
  }

  /**
   * 指定のファイルパスが存在すれば更新、無ければ作成
   */
  async createOrUpdateFile(filePath: string, content: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing && existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      await this.app.vault.create(filePath, content);
    }
  }

  /**
   * Base64文字列(形式: "data:image/jpeg;base64,...")をバイナリに変換し、Vault内に書き込む
   */
  async saveBase64Image(base64: string, filePath: string): Promise<void> {
    const matches = base64.match(/^data:image\/jpe?g;base64,(.+)/);
    if (!matches || matches.length < 2) {
      console.error("Invalid Base64 image format:", base64);
      return;
    }
    const buffer = Buffer.from(matches[1], "base64");
    await this.app.vault.adapter.writeBinary(filePath, buffer);
    console.log(`Image saved: ${filePath}`);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

/**
 * 設定タブ (プラグインオプション)
 */
class PDFToMarkdownSettingTab extends PluginSettingTab {
  plugin: PDFToMarkdownPlugin;

  constructor(app: App, plugin: PDFToMarkdownPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'PDF to Markdown (Inline Image) Settings' });

    // 1) Markdown出力先
    new Setting(containerEl)
      .setName('Markdown Output Folder')
      .setDesc('Folder to save the generated Markdown (relative to vault root). Empty = root')
      .addText(text => {
        text
          .setPlaceholder('e.g. PDFOut')
          .setValue(this.plugin.settings.markdownOutputFolder)
          .onChange(async (value) => {
            this.plugin.settings.markdownOutputFolder = value.trim();
            await this.plugin.saveSettings();
          });
      });

    // 2) 画像出力先 (ベースパス)
    new Setting(containerEl)
      .setName('Images Output Folder')
      .setDesc('Base folder path for images (relative to vault root). Empty = root')
      .addText(text => {
        text
          .setPlaceholder('e.g. MyImagesFolder')
          .setValue(this.plugin.settings.imagesOutputFolder)
          .onChange(async (value) => {
            this.plugin.settings.imagesOutputFolder = value.trim();
            await this.plugin.saveSettings();
          });
      });

    // 3) 画像フォルダ名
    new Setting(containerEl)
      .setName('Images Folder Name')
      .setDesc('The subfolder name for images. Default is "pdf-mistral-images"')
      .addText(text => {
        text
          .setPlaceholder('pdf-mistral-images')
          .setValue(this.plugin.settings.imagesFolderName)
          .onChange(async (value) => {
            this.plugin.settings.imagesFolderName = value.trim() || 'pdf-mistral-images';
            await this.plugin.saveSettings();
          });
      });

    // 4) Mistral API キー
    new Setting(containerEl)
      .setName('Mistral API Key')
      .setDesc('Your Mistral API key. Keep it private!')
      .addText(text => {
        text
          .setPlaceholder('Enter your Mistral API key here')
          .setValue(this.plugin.settings.mistralApiKey)
          .onChange(async (value) => {
            this.plugin.settings.mistralApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    // 5) PDF.js 画像レンダリングDPI
    new Setting(containerEl)
      .setName('Image Render DPI')
      .setDesc('DPI for rendering PDF pages before image cropping. Recommended range: 150-600')
      .addText(text => {
        text.inputEl.type = 'number';
        text.inputEl.min = String(MIN_IMAGE_RENDER_DPI);
        text.inputEl.max = String(MAX_IMAGE_RENDER_DPI);
        text.inputEl.step = '50';
        text
          .setPlaceholder(String(DEFAULT_IMAGE_RENDER_DPI))
          .setValue(String(this.plugin.settings.imageRenderDPI ?? DEFAULT_IMAGE_RENDER_DPI))
          .onChange(async (value) => {
            const parsed = Number(value);
            this.plugin.settings.imageRenderDPI = Number.isFinite(parsed)
              ? Math.min(Math.max(Math.round(parsed), MIN_IMAGE_RENDER_DPI), MAX_IMAGE_RENDER_DPI)
              : DEFAULT_IMAGE_RENDER_DPI;
            await this.plugin.saveSettings();
          });
      });
  }
}
