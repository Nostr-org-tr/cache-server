import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const inputCss = path.join(projectRoot, 'src/landing/styles.css');
const outputCss = path.join(projectRoot, 'src/landing/generated-styles.css');
const outputTs = path.join(projectRoot, 'src/landing/generated-styles.ts');

console.log('[build-css] Compiling Tailwind CSS & FlyonUI...');
execSync(`npx @tailwindcss/cli -i "${inputCss}" -o "${outputCss}" --minify`, {
  cwd: projectRoot,
  stdio: 'inherit',
});

if (!fs.existsSync(outputCss)) {
  throw new Error(`[build-css] CSS output file not found: ${outputCss}`);
}

const cssContent = fs.readFileSync(outputCss, 'utf-8');
const tsContent = `/**
 * Auto-generated styles bundle from Tailwind CSS & FlyonUI.
 * Do not edit directly; run \`make build-css\` or \`npm run build:css\` to update.
 */
export const LANDING_STYLES = ${JSON.stringify(cssContent)};
`;

fs.writeFileSync(outputTs, tsContent, 'utf-8');
console.log(`[build-css] Generated ${outputTs} (${cssContent.length} bytes)`);
