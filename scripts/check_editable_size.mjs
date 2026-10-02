import fs from 'node:fs/promises';

const DEFAULT_BUDGET_BYTES = 500_000;
const DEFAULT_TARGETS = [
  'mockups/generated/editable-basic.html',
  'mockups/generated/fixture-long.editable.html'
];

const budgetIndex = process.argv.indexOf('--budget');
const budget = budgetIndex >= 0 ? Number(process.argv[budgetIndex + 1]) : DEFAULT_BUDGET_BYTES;
const targets = process.argv.filter((arg, index) => index > 1 && arg !== '--budget' && process.argv[index - 1] !== '--budget');
const files = targets.length ? targets : DEFAULT_TARGETS;
const failures = [];

for (const file of files) {
  let bytes;
  try {
    const html = await fs.readFile(file);
    bytes = html.byteLength;
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }

  const label = `${file}: ${bytes} bytes`;
  if (bytes > budget) {
    failures.push(`${label} exceeds ${budget} bytes`);
  } else {
    console.log(`${label} within ${budget} bytes`);
  }
}

if (failures.length) {
  console.error('Editable HTML size budget failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
