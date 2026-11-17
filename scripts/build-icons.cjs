// Capture the actual square UI mark on macOS, then apply only an app-icon silhouette.
// Other platforms reuse the committed capture so font substitution cannot change h.
const { chromium } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const assets = path.resolve(__dirname, '../desktop/assets');
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    // Keep the UI HTML/CSS as the single source of letter shape, dot and spacing.
    // The renderer deliberately keeps its square corners.
    if (process.platform === 'darwin') {
      await page.setViewportSize({ width: 1400, height: 1400 });
      const css = await fs.readFile(path.join(assets, '../renderer/styles.css'), 'utf8');
      const html = await fs.readFile(path.join(assets, '../renderer/index.html'), 'utf8');
      const mark = html.match(/<span class="brandmark">[^<]*<\/span>/)?.[0];
      if (!mark) throw new Error('Cannot find the original UI brandmark');
      await page.setContent(`<style>${css}
        :root{font-size:${1024 / 2.7}px}
        body{margin:0;background:transparent}
        .brand{position:absolute;left:0;top:0}
        .brandmark{width:1024px;height:1024px}
      </style><a class="brand">${mark}</a>`);
      await page.locator('.brandmark').screenshot({ path: path.join(assets, 'brandmark.png') });
    }
    const square = await fs.readFile(path.join(assets, 'brandmark.png'));
    // A transparent 1024 px canvas, optical inset and continuous rounded corners.
    // The original square composition is scaled uniformly, without moving the glyphs.
    const silhouette =
      'M320 100H704C856 100 924 168 924 320V704C924 856 856 924 704 924H320C168 924 100 856 100 704V320C100 168 168 100 320 100Z';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <title>HARQ Lab: original UI h.</title>
  <defs><clipPath id="mac-icon"><path d="${silhouette}"/></clipPath></defs>
  <image x="100" y="100" width="824" height="824" clip-path="url(#mac-icon)" href="data:image/png;base64,${square.toString('base64')}"/>
</svg>\n`;
    await fs.writeFile(path.join(assets, 'icon.svg'), svg);
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`
    );
    const images = new Map();
    for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
      await page.setViewportSize({ width: size, height: size });
      images.set(size, await page.screenshot({ omitBackground: true }));
    }
    await fs.writeFile(path.join(assets, 'icon.png'), images.get(1024));
    const chunks = [];
    for (const [size, type] of [
      [16, 'icp4'],
      [32, 'icp5'],
      [64, 'icp6'],
      [128, 'ic07'],
      [256, 'ic08'],
      [512, 'ic09'],
      [1024, 'ic10'],
    ]) {
      const png = images.get(size),
        header = Buffer.alloc(8);
      header.write(type, 0, 4, 'ascii');
      header.writeUInt32BE(png.length + 8, 4);
      chunks.push(header, png);
    }
    const header = Buffer.alloc(8);
    header.write('icns');
    header.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4);
    await fs.writeFile(path.join(assets, 'icon.icns'), Buffer.concat([header, ...chunks]));
    const sizes = [16, 32, 64, 128, 256];
    const directory = Buffer.alloc(6 + 16 * sizes.length);
    directory.writeUInt16LE(1, 2);
    directory.writeUInt16LE(sizes.length, 4);
    let offset = directory.length;
    sizes.forEach((size, i) => {
      const entry = 6 + 16 * i,
        png = images.get(size);
      directory[entry] = directory[entry + 1] = size === 256 ? 0 : size;
      directory.writeUInt16LE(1, entry + 4);
      directory.writeUInt16LE(32, entry + 6);
      directory.writeUInt32LE(png.length, entry + 8);
      directory.writeUInt32LE(offset, entry + 12);
      offset += png.length;
    });
    await fs.writeFile(
      path.join(assets, 'icon.ico'),
      Buffer.concat([directory, ...sizes.map((size) => images.get(size))])
    );
    console.log('Created rounded icon.svg, icon.png, icon.icns and icon.ico from the exact square UI mark');
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
