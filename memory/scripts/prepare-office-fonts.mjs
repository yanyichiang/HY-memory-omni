import { readFile, mkdir, writeFile } from 'node:fs/promises';
const output = new URL('../.generated/fonts/', import.meta.url);
export async function prepareOfficeFonts() {
  await mkdir(output, { recursive: true });
  const entries = await Promise.all(['Regular', 'Bold'].map(async style => {
    const bytes = await readFile(new URL(`../fonts/HYOfficeSansSC-${style}.ttf`, import.meta.url));
    return `export const ${style.toLowerCase()} = '${bytes.toString('base64')}';`;
  }));
  await writeFile(new URL('fonts.mjs', output), `// Generated from bundled OFL font files; no runtime network.\n${entries.join('\n')}\n`);
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) await prepareOfficeFonts();
