import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDict, PDFDocument, PDFRawStream, PDFName } from 'pdf-lib';
import yauzl from 'yauzl';

const root = fileURLToPath(new URL('..', import.meta.url));
const desktop = path.join(root, 'desktop-mygo');
const value = name => process.argv.find(argument => argument.startsWith(name + '='))?.slice(name.length + 1);
const build = process.env.BIKE_MYGO_BUILD ?? '1';
const channel = process.env.BIKE_MYGO_CHANNEL ?? 'preview';
const output = path.resolve(value('--output') ?? path.join(root, 'docs/evidence-mygo-2026-11-11-integration/native-ui-exports'));
const bundleDirectory = path.join(os.tmpdir(), `bike-mygo-native-ui-${build}`);
const bundle = path.join(bundleDirectory, 'Bike MyGO UI Acceptance.app');
const binary = path.join(bundle, 'Contents/MacOS/bike-mygo-ui-acceptance');
const go = process.env.BIKE_MYGO_GO ?? 'go';
const staged = path.join(desktop, 'internal/frontend/dist');
const manifestPath = path.join(root, `release/mygo/2.0.0/build-${build}-${channel}/build-manifest.json`);
const run = (executable, arguments_, options = {}) => {
  const result = spawnSync(executable, arguments_, { encoding: 'utf8', cwd: root, maxBuffer: 8 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, `${executable} exited ${result.status}\n${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
  return result.stdout;
};
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const directoryHash = async directory => {
  const hash = crypto.createHash('sha256');
  for (const file of (await fs.readdir(directory, { recursive: true })).sort()) {
    const absolute = path.join(directory, file);
    if ((await fs.stat(absolute)).isFile()) hash.update(file).update(await fs.readFile(absolute));
  }
  return hash.digest('hex');
};
const renderPDFScript = `
import Foundation
import PDFKit
import AppKit
let document = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1]))!
let page = document.page(at: 0)!
let bounds = page.bounds(for: .mediaBox)
let scale: CGFloat = 2
let image = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: Int(bounds.width * scale),
  pixelsHigh: Int(bounds.height * scale),
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
)!
let graphics = NSGraphicsContext(bitmapImageRep: image)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = graphics
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: CGFloat(image.pixelsWide), height: CGFloat(image.pixelsHigh)).fill()
graphics.cgContext.scaleBy(x: scale, y: scale)
page.draw(with: .mediaBox, to: graphics.cgContext)
NSGraphicsContext.restoreGraphicsState()
try image.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
`;
await fs.mkdir(output, { recursive: true });
const manifest = JSON.parse(await fs.readFile(manifestPath));
const frontendSHA256 = manifest.frontendSHA256;
if (!process.argv.includes('--reuse-helper')) {
  assert.equal(await directoryHash(staged), frontendSHA256, 'Stage the candidate frontend before UI acceptance');
}
const env = { ...process.env, GOTOOLCHAIN: 'local', GOEXPERIMENT: 'jsonv2', CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: 'arm64' };
const helperSourcesSHA256 = await directoryHash(path.join(desktop, 'cmd/bike-mygo-ui-acceptance'));
const helperReceipt = path.join(bundleDirectory, 'helper-build.json');
if (!process.argv.includes('--reuse-helper')) {
  await fs.mkdir(path.dirname(binary), { recursive: true });
  run(go, ['build', '-mod=readonly', '-trimpath', '-tags', 'mygo_noinspector,mygo_frontend',
    '-ldflags', '-s -w -X github.com/egoist/mygo.production=1 -X github.com/egoist/mygo.packageIdentifier=com.bike.mygo.ui-acceptance -X github.com/egoist/mygo.packageVersion=2.0.0',
    '-o', binary, './cmd/bike-mygo-ui-acceptance'], { cwd: desktop, env });
  const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>Bike MyGO UI Acceptance</string><key>CFBundleIdentifier</key><string>com.bike.mygo.ui-acceptance</string><key>CFBundleExecutable</key><string>bike-mygo-ui-acceptance</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>2.0.0</string><key>CFBundleVersion</key><string>${build}</string><key>LSMinimumSystemVersion</key><string>12.0</string><key>NSPrincipalClass</key><string>NSApplication</string></dict></plist>\n`;
  await fs.writeFile(path.join(bundle, 'Contents/Info.plist'), plist);
  run('/usr/bin/codesign', ['--force', '--sign', '-', bundle]);
  run('/usr/bin/codesign', ['--verify', '--strict', bundle]);
  assert.equal(await directoryHash(staged), frontendSHA256, 'Frontend changed during helper build');
  await fs.writeFile(helperReceipt, JSON.stringify({ frontendSHA256, helperSourcesSHA256, binarySHA256: sha256(await fs.readFile(binary)) }, null, 2) + '\n');
} else {
  const built = JSON.parse(await fs.readFile(helperReceipt));
  assert.equal(built.frontendSHA256, frontendSHA256, 'Rebuild UI helper after staging another frontend');
  assert.equal(built.helperSourcesSHA256, helperSourcesSHA256, 'Rebuild UI helper after changing its script');
  assert.equal(built.binarySHA256, sha256(await fs.readFile(binary)), 'UI helper binary changed after build');
}
const identity = { build, sourceFingerprint: manifest.sourceFingerprint, frontendSHA256, binarySHA256: sha256(await fs.readFile(binary)),
  helperSourcesSHA256,
  host: { release: os.release(), arch: os.arch() }, diagnosticOnly: true, productionDesktopBridge: true,
  profile: path.join(output, 'profile'), nodeFreeChildPATH: '/usr/bin:/bin' };
await fs.writeFile(path.join(output, 'identity.json'), JSON.stringify(identity, null, 2) + '\n');
if (process.argv.includes('--prepare-only')) {
  console.log(JSON.stringify({ prepared: true, binary, frontendSHA256 }));
  process.exit(0);
}
const mode = value('--mode');
const modes = process.argv.includes('--verify-only') ? [] : mode ? [mode] : ['seed', 'text', 'images'];
const guiMarker = value('--ready-marker');
const guiLock = value('--gui-lock') ?? path.join(os.tmpdir(), 'bike-mygo-native-ui-acceptance.lock');
let ownsLock = false;
if (modes.length) {
  if (guiMarker) await fs.access(guiMarker);
  const end = Date.now() + 600000;
  while (!ownsLock) {
    try {
      const lock = await fs.open(guiLock, 'wx', 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid, task: 'native-ui-exports' }) + '\n');
      await lock.close();
      ownsLock = true;
    } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() > end) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}
try {
  for (const current of modes) {
    const result = spawnSync(binary, ['--mode', current, '--output', output], {
      env: { ...process.env, PATH: '/usr/bin:/bin', MYGO_ENV: 'development' },
      encoding: 'utf8', timeout: 250000, maxBuffer: 8 * 1024 * 1024,
    });
    await fs.writeFile(path.join(output, current + '.log'), (result.stdout ?? '') + (result.stderr ?? ''));
    assert.equal(result.status, 0, `${current} failed\n${result.stderr}\n${result.stdout}\n${result.error ?? ''}`);
    const actual = JSON.parse(await fs.readFile(path.join(output, `result-${current}.json`)));
    assert.deepEqual(actual.errors, []);
    assert.deepEqual(actual.csp, []);
    assert.equal(actual.origin, 'mygo://localhost');
    assert.equal(actual.secure, true);
    assert.match(actual.cspPolicy, /connect-src 'self'(?:;|$)/);
    if (current === 'seed') {
      assert.equal(actual.seeded, true);
      await fs.writeFile(path.join(output, 'original.png'), Buffer.from(actual.originalBase64, 'base64'));
      assert.equal(actual.asset.assetId, 'sha256:' + sha256(await fs.readFile(path.join(output, 'original.png'))));
    }
    console.log(`${current} passed with ${actual.exports?.length ?? 0} actual downloads and ${actual.views?.length ?? 0} view captures`);
  }
} finally {
  if (ownsLock) await fs.unlink(guiLock);
}
const bothReportsExist = await Promise.all(['text', 'images'].map(async name => fs.access(path.join(output, `result-${name}.json`)).then(() => true, () => false)));
if (bothReportsExist.every(Boolean) && (modes.includes('text') || modes.includes('images') || process.argv.includes('--verify-files'))) {
  const checks = [];
  const text = JSON.parse(await fs.readFile(path.join(output, 'result-text.json')));
  const images = JSON.parse(await fs.readFile(path.join(output, 'result-images.json')));
  const exported = new Map(text.exports.map(entry => [entry.label, entry.path]));
  const content = async label => fs.readFile(exported.get(label), 'utf8');
  assert.match(await content('导出 MD'), /原生验收 中文🙂/);
  assert.match(await content('导出 MD'), /\[\[联调目标#图片主题\]\]/);
  assert.match(await content('导出 MD'), /const 中文/);
  assert.match(await content('带元数据'), /bike:document:v[12]/);
  const workspace = JSON.parse(await content('工作区'));
  assert.equal(workspace.documents[0].nodes[0].children[1].codeLanguage, 'javascript');
  if (process.argv.includes('--require-pdf-code')) {
    assert.equal(workspace.documents[0].nodes[0].children[1].codeBlock, ['const 中文 = "验证";', '', '  console.log(中文);'].join('\n'));
  }
  assert.equal(workspace.documents[0].knowledge.references[0].target.documentId, 'native-images');
  assert.equal(workspace.documents[0].knowledge.relations[0].label, '验证依赖');
  for (const label of ['OPML', 'FreeMind', 'SVG']) {
    run('/usr/bin/python3', ['-c', 'import sys,xml.etree.ElementTree as E;r=E.parse(sys.argv[1]).getroot();print(r.tag)', exported.get(label)]);
  }
  assert.match(await content('OPML'), /_table=/);
  assert.match(await content('OPML'), /_codeLanguage="javascript"/);
  assert.match(await content('FreeMind'), /TEXT="原生验收 中文🙂"/);
  assert.match(await content('HTML'), /<table>/);
  assert.match(await content('HTML'), /<pre>/);
  assert.match(await content('HTML'), /验证依赖/);
  assert.match(await content('SVG'), /原生验收 中文🙂/);
  assert.doesNotMatch(await content('SVG'), /foreignObject/);
  checks.push('Actual WKWebView menu downloads preserve Chinese, wiki-link text, table, code and format-defined metadata. JSON preserves reference identity and relations.');
  for (const entry of [...text.exports, ...images.exports]) {
    const bytes = await fs.readFile(entry.path);
    assert.equal(bytes.length, entry.bytes);
    entry.sha256 = sha256(bytes);
    if (entry.label.includes('PNG')) {
      assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.ok(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0);
      entry.dimensions = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    }
  }
  const imageSVG = await fs.readFile(images.exports.find(entry => entry.label === 'SVG').path, 'utf8');
  const embedded = Buffer.from(imageSVG.match(/href="data:image\/png;base64,([^"]+)"/)?.[1] ?? '', 'base64');
  assert.deepEqual(embedded, await fs.readFile(path.join(output, 'original.png')));
  const pdfResults = [];
  const pdfFiles = [
    { file: exported.get('PDF'), name: 'text-document', images: false, text: ['原生多格式验收', '原生验收', '表格', '主题关系', '验证依赖'] },
    { file: images.exports.find(entry => entry.label === 'PDF').path, name: 'image-document', images: true, text: ['联调目标', '图片主题', '嵌图'] },
  ];
  for (const pdf of pdfFiles) {
    const loaded = await PDFDocument.load(await fs.readFile(pdf.file));
    const objects = loaded.context.enumerateIndirectObjects();
    const imageCount = objects.filter(([, object]) => object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image').length;
    const fontCount = objects.filter(([, object]) => object instanceof PDFDict && (object.has(PDFName.of('FontFile2')) || object.has(PDFName.of('FontFile3')))).length;
    assert.ok(loaded.getPageCount() > 0 && fontCount > 0);
    if (pdf.images) assert.ok(imageCount > 0);
    const extracted = run('/usr/bin/swift', ['-e', 'import Foundation; import PDFKit; let d = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1]))!; print(d.string ?? "")', pdf.file], { timeout: 120000 });
    for (const expected of pdf.text) assert.ok(extracted.includes(expected), `PDF text missing ${expected}`);
    if (!pdf.images && process.argv.includes('--require-pdf-code')) {
      for (const expected of ['javascript', 'const 中文', 'console.log(中文)', '[x]', '[U+1F642]']) {
        assert.ok(extracted.includes(expected), `PDF code or readable glyph fallback missing ${expected}`);
      }
      assert.ok(!extracted.includes('☑'), 'PDF must use the supported completion marker');
    }
    await fs.writeFile(path.join(output, pdf.name + '.txt'), extracted);
    const rendered = path.join(output, pdf.name + '.png');
    run('/usr/bin/swift', ['-e', renderPDFScript, pdf.file, rendered], { timeout: 120000 });
    pdfResults.push({ name: pdf.name, file: pdf.file, pageCount: loaded.getPageCount(), fontCount, imageCount,
      chineseTextVerified: true, codeBlockPreserved: pdf.images ? null : extracted.includes('const 中文'), renderedFirstPage: rendered });
    checks.push(`${pdf.name} PDF has ${loaded.getPageCount()} pages, ${fontCount} embedded font streams, ${imageCount} image streams, verified Chinese extraction and rendered first page.`);
  }
  assert.equal(text.views.length, 16);
  if (process.argv.includes('--require-inline-task')) {
    assert.equal(text.taskLayout.length, 4);
    for (const layout of text.taskLayout) {
      assert.equal(layout.button.width, 22);
      assert.equal(layout.button.height, 28);
      assert.ok(layout.text.x >= layout.button.right, JSON.stringify(layout));
      assert.ok(layout.text.y < layout.button.bottom && layout.text.bottom > layout.button.y, JSON.stringify(layout));
    }
    assert.equal(text.taskTogglePersisted, true);
    checks.push('All four theme/size combinations keep the 22×28 task button inline with text. Uncheck and recheck both persisted through the normal renderer transaction.');
  }
  for (const theme of ['light', 'dark']) {
    for (const width of [1366, 1728]) {
      assert.equal(text.views.filter(view => view.theme === theme && view.requestedWindow[0] === width).length, 4);
    }
  }
  checks.push('Sixteen native CapturePage screenshots cover all four views, both themes and both requested window sizes. Export menus remained in bounds and keyboard End/Escape restored trigger focus.');
  const report = { ...identity, checks, textExports: text.exports, imageExports: images.exports, pdfResults, views: text.views,
    taskLayout: text.taskLayout ?? [], taskTogglePersisted: text.taskTogglePersisted ?? false, errors: [], csp: [],
    limitations: ['Helper redirects blob downloads to isolated paths instead of exercising the normal Save panel.', 'Synthetic JavaScript clicks and keyboard events do not establish OS IME, clipboard or physical drag acceptance.', 'OPML and FreeMind retain their documented format limits.', 'Physical macOS 12/13 and high-DPI external monitor remain pending.'] };
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Native UI export files verified');
}
if (process.argv.includes('--verify-portable')) {
  const seed = JSON.parse(await fs.readFile(path.join(output, 'result-seed.json')));
  const assetName = 'attachments/' + seed.asset.assetId.slice(7);
  const original = await fs.readFile(path.join(output, 'original.png'));
  const portable = [];
  for (const [name, entryName] of [['portable-html', 'index.html'], ['portable-md', 'document.md']]) {
    const zipFile = path.join(output, name + '.zip');
    const archive = await yauzl.openPromise(zipFile);
    const contents = new Map();
    for await (const entry of archive.eachEntry()) {
      const chunks = [];
      for await (const chunk of await archive.openReadStreamPromise(entry)) chunks.push(chunk);
      contents.set(entry.fileName, Buffer.concat(chunks));
    }
    assert.deepEqual(contents.get(assetName), original);
    assert.match(contents.get(entryName).toString(), new RegExp(assetName));
    const actual = JSON.parse(await fs.readFile(path.join(output, `result-${name}.json`)));
    assert.deepEqual(actual.after.documents, actual.before.documents);
    portable.push({ name, sha256: sha256(await fs.readFile(zipFile)), originalSHA256: sha256(original), entries: [...contents.keys()] });
  }
  await fs.writeFile(path.join(output, 'portable-verification.json'), JSON.stringify(portable, null, 2) + '\n');
}
