// Reproducible, metadata-only adaptation of the pinned MPL-2.0 Mediabunny source.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function prepareMatroska(options = {}) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const require = createRequire(options.dependencyRoot ? resolve(options.dependencyRoot, 'package.json') : import.meta.url);
  let packageRoot = dirname(require.resolve('mediabunny'));
  let manifest;
  for (;;) {
    try { manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')); } catch { /* Ascend to package root. */ }
    if (manifest?.name === 'mediabunny') break;
    const parent = dirname(packageRoot);
    if (parent === packageRoot) throw Error('matroska_upstream_not_found');
    packageRoot = parent;
  }
  if (manifest.version !== '1.62.1') throw Error('matroska_upstream_version_mismatch');
  const output = options.outputRoot ? resolve(options.outputRoot) : resolve(root, '.generated/mediabunny');
  await mkdir(output, { recursive: true });
  await cp(resolve(packageRoot, 'src'), resolve(output, 'src'), { recursive: true });
  // npm ships src/ without its shared TypeScript sources or root tsconfig.
  // Reuse the package's unchanged shared JS and declarations; do not reconstruct codecs.
  await cp(resolve(packageRoot, 'dist/modules/shared'), resolve(output, 'shared'), { recursive: true });
  await writeFile(resolve(output, 'tsconfig.json'), '{}\n');
  // Preserve upstream browser stubs: source builds must not pull node:fs into Workers.
  if (manifest.browser?.['./src/node.ts'] !== false || manifest.browser?.['node:fs/promises'] !== false) throw Error('matroska_upstream_browser_mapping_mismatch');
  await writeFile(resolve(output, 'package.json'), JSON.stringify({
    name: manifest.name, version: manifest.version, type: manifest.type,
    browser: manifest.browser, sideEffects: manifest.sideEffects,
  }, null, 2) + '\n');
  await cp(resolve(packageRoot, 'LICENSE'), resolve(output, 'LICENSE'));
  const patch = (source, before, after, count = 1) => {
    if (source.split(before).length - 1 !== count) throw Error('matroska_patch_source_mismatch: ' + before.slice(0, 60));
    return source.split(before).join(after);
  };
  const filename = resolve(output, 'src/matroska/matroska-demuxer.ts');
  let source = await readFile(filename, 'utf8');
  source = patch(source, 'type ClusterBlock = {\n', 'type ClusterBlock = {\n\tdiscardPaddingNs: number;\n');
  source = patch(source, '\tdefaultDurationNs: number | null;\n', '\tdefaultDurationNs: number | null;\n\tcodecDelayNs: number;\n\tseekPreRollNs: number;\n');
  source = patch(source, '\t\t\t\t\tdefaultDurationNs: null,\n', '\t\t\t\t\tdefaultDurationNs: null,\n\t\t\t\t\tcodecDelayNs: 0,\n\t\t\t\t\tseekPreRollNs: 0,\n');
  source = patch(source, '\t\t\t\t\tmainAdditional: null,\n', '\t\t\t\t\tmainAdditional: null,\n\t\t\t\t\tdiscardPaddingNs: 0,\n', 2);
  source = patch(source, '\t\t\t\t\tmainAdditional: originalBlock.mainAdditional,\n', `\t\t\t\t\tmainAdditional: originalBlock.mainAdditional,
\t\t\t\t\tdiscardPaddingNs: originalBlock.discardPaddingNs < 0
\t\t\t\t\t\t? (i === 0 ? originalBlock.discardPaddingNs : 0)
\t\t\t\t\t\t: (i === frameCount - 1 ? originalBlock.discardPaddingNs : 0),
`);
  source = patch(source, '\t\t\tcase EBMLId.DefaultDuration: {', `\t\t\tcase EBMLId.CodecDelay:
\t\t\tcase EBMLId.SeekPreRoll: {
\t\t\t\tif (!this.currentTrack) break;
\t\t\t\tconst value = readMatroskaNs(slice, size, false);
\t\t\t\tif (id === EBMLId.CodecDelay) this.currentTrack.codecDelayNs = value;
\t\t\t\telse this.currentTrack.seekPreRollNs = value;
\t\t\t}; break;

\t\t\tcase EBMLId.DefaultDuration: {`);
  source = patch(source, '\t\t\tcase EBMLId.BlockDuration: {', `\t\t\tcase 0x75a2: { // Matroska DiscardPadding; deliberately absent from upstream enum.
\t\t\t\tif (!this.currentBlock) break;
\t\t\t\tthis.currentBlock.discardPaddingNs = readMatroskaNs(slice, size, true);
\t\t\t}; break;

\t\t\tcase EBMLId.BlockDuration: {`);
  source = patch(source, `\t\t\tcase EBMLId.BlockGroup: {
\t\t\t\tif (!this.currentCluster) break;

\t\t\t\tthis.readContiguousElements(slice.slice(dataStartPos, size));

\t\t\t\tthis.currentBlock = null;
\t\t\t}; break;`, `\t\t\tcase EBMLId.BlockGroup: {
\t\t\t\tif (!this.currentCluster) break;
\t\t\t\t// A BlockGroup's metadata may precede Block. Locate and parse its sole Block
\t\t\t\t// first, then feed every other child through the unchanged upstream parser.
\t\t\t\t// No payload copies or per-child arrays are needed.
\t\t\t\tconst group = slice.slice(dataStartPos, size);
\t\t\t\tlet blockStart: number | undefined;
\t\t\t\twhile (group.remainingLength > 0) {
\t\t\t\t\tconst start = group.filePos, child = readElementHeader(group);
\t\t\t\t\tif (!child || child.size === undefined || child.size > group.remainingLength) throw new Error('Invalid Matroska BlockGroup child.');
\t\t\t\t\tif (child.id === EBMLId.Block) {
\t\t\t\t\t\tif (blockStart !== undefined) throw new Error('Multiple Blocks in Matroska BlockGroup.');
\t\t\t\t\t\tblockStart = start;
\t\t\t\t\t}
\t\t\t\t\tgroup.skip(child.size);
\t\t\t\t}
\t\t\t\tif (blockStart === undefined) throw new Error('Missing Block in Matroska BlockGroup.');
\t\t\t\tthis.currentBlock = null;
\t\t\t\tif (this.elementNestingDepth === MAX_ELEMENT_NESTING_DEPTH) throw new Error('Invalid file: elements are nested too deeply.');
\t\t\t\tthis.elementNestingDepth++;
\t\t\t\ttry {
\t\t\t\t\tthis.traverseElement(group.slice(blockStart));
\t\t\t\t\tgroup.filePos = dataStartPos;
\t\t\t\t\twhile (group.remainingLength > 0) {
\t\t\t\t\t\tconst start = group.filePos, child = readElementHeader(group)!;
\t\t\t\t\t\tassertDefinedSize(child.size);
\t\t\t\t\t\tif (child.id !== EBMLId.Block) this.traverseElement(group.slice(start));
\t\t\t\t\t\tgroup.skip(child.size);
\t\t\t\t\t}
\t\t\t\t} finally { this.currentBlock = null; this.elementNestingDepth--; }
\t\t\t}; break;`);
  source = patch(source, '\t\tconst sideData: EncodedPacketSideData = {};', `\t\tconst sideData: EncodedPacketSideData = { matroska: {
\t\t\tcodecDelayNs: this.internalTrack.codecDelayNs,
\t\t\tseekPreRollNs: this.internalTrack.seekPreRollNs,
\t\t\tdiscardPaddingNs: block.discardPaddingNs,
\t\t\ttrackNumber: this.internalTrack.id,
\t\t\ttimestampScaleNs: this.internalTrack.segment.timestampScale,
\t\t} };`);
  source += `
// HY metadata-only patch: decode EBML signed integers without 32-bit coercion.
function readMatroskaNs(slice: FileSlice, width: number, signed: boolean): number {
\tlet value = readUnsignedBigInt(slice, width);
\tif (signed && value >= (1n << BigInt(width * 8 - 1))) value -= 1n << BigInt(width * 8);
\tif (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Matroska nanoseconds exceed safe integer range.');
\treturn Number(value);
}
`;
  await writeFile(filename, source);
  const packetFile = resolve(output, 'src/packet.ts');
  let packet = await readFile(packetFile, 'utf8');
  packet = patch(packet, 'export type EncodedPacketSideData = {\n', `export type EncodedPacketSideData = {
\t/** Raw Matroska metadata; does not change packet timestamps or decoded duration. */
\tmatroska?: {
\t\tcodecDelayNs: number; seekPreRollNs: number; discardPaddingNs: number;
\t\ttrackNumber: number; timestampScaleNs: number;
\t};
`);
  await writeFile(packetFile, packet);
  await writeFile(resolve(output, 'SOURCE.txt'), 'Mediabunny 1.62.1, MPL-2.0. Original src and LICENSE copied from the locked npm package.\nPatch: memory/scripts/prepare-matroska.mjs; rationale: memory/licenses/MATROSKA-PATCH.md.\n');
  return resolve(output, 'src/index.ts');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(await prepareMatroska());
}
