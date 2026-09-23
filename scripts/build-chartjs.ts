import * as fs from 'node:fs';
import * as path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const chartJsUmdPath = path.join(
  projectRoot,
  'node_modules/chart.js/dist/chart.umd.min.js'
);
const fallbackChartJsPath = path.join(
  projectRoot,
  'node_modules/chart.js/dist/chart.umd.js'
);
const outputTs = path.join(projectRoot, 'src/dashboard/generated-chartjs.ts');

console.log('[build-chartjs] Locating Chart.js minified UMD bundle...');

let sourcePath = chartJsUmdPath;
if (!fs.existsSync(sourcePath)) {
  if (fs.existsSync(fallbackChartJsPath)) {
    sourcePath = fallbackChartJsPath;
  } else {
    throw new Error(
      `[build-chartjs] Chart.js bundle not found at ${chartJsUmdPath}. Ensure chart.js is installed.`
    );
  }
}

const jsContent = fs.readFileSync(sourcePath, 'utf-8');
const tsContent = `/**
 * Auto-generated Chart.js bundle.
 * Do not edit directly; run \`make build-chartjs\` or \`npm run build:chartjs\` to update.
 */
export const CHARTJS_SOURCE = ${JSON.stringify(jsContent)};
`;

fs.writeFileSync(outputTs, tsContent, 'utf-8');
console.log(
  `[build-chartjs] Generated ${outputTs} (${jsContent.length} bytes from ${path.basename(sourcePath)})`
);
