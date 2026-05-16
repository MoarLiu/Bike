import { mkdir, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const source =
  process.argv[2] ??
  "/Users/crazyjal/Library/Application Support/CleanShot/media/media_SGNNhJ8hjH/CleanShot 2026-05-16 at 23.03.12@2x.png";
const buildDir = path.join(projectRoot, "build");
const iconsetDir = path.join(buildDir, "win-icon-png");
const squareSource = path.join(buildDir, "win-icon-source.png");
const output = path.join(buildDir, "icon.ico");
const sizes = [16, 24, 32, 48, 64, 128, 256];

await mkdir(iconsetDir, { recursive: true });
await rm(output, { force: true });

execFileSync("sips", ["--cropToHeightWidth", "72", "72", source, "--out", squareSource], {
  stdio: "ignore",
});

const images = [];
for (const size of sizes) {
  const file = path.join(iconsetDir, `icon-${size}.png`);
  execFileSync("sips", ["-z", String(size), String(size), squareSource, "--out", file], {
    stdio: "ignore",
  });
  images.push({ size, data: await readFile(file) });
}

const headerSize = 6 + images.length * 16;
let offset = headerSize;
const chunks = [Buffer.alloc(headerSize)];
const header = chunks[0];

header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);

images.forEach((image, index) => {
  const entry = 6 + index * 16;
  header.writeUInt8(image.size >= 256 ? 0 : image.size, entry);
  header.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1);
  header.writeUInt8(0, entry + 2);
  header.writeUInt8(0, entry + 3);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(image.data.byteLength, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  chunks.push(image.data);
  offset += image.data.byteLength;
});

await mkdir(buildDir, { recursive: true });
await import("node:fs/promises").then(({ writeFile }) =>
  writeFile(output, Buffer.concat(chunks)),
);

console.log(output);
