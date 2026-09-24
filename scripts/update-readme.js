'use strict';
// Keeps the plugin list in README.md in step with plugins.json.
//
//   node scripts/update-readme.js          rewrite the list if it is out of date
//   node scripts/update-readme.js --check  change nothing; exit 1 if it is out of date
//
// The list sits between two HTML comments, which rendered Markdown does not
// show, so renaming the surrounding heading cannot break the update.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const readmePath = path.join(root, 'README.md');
const START = '<!-- plugin-list:start -->';
const END = '<!-- plugin-list:end -->';

function installablePlugins() {
  return fs.readdirSync(root, {withFileTypes: true})
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'v2.ts')))
    .map(entry => entry.name);
}

// Only plugins with a V2 entry are listed: they are the ones TPM can install.
function renderList(catalog, installable) {
  return installable
    .filter(id => Object.hasOwn(catalog, id))
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map(id => `- \`${id}\` - ${String(catalog[id].desc).trim()}`)
    .join('\n');
}

function main() {
  const check = process.argv.includes('--check');
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'plugins.json'), 'utf8'));
  const installable = installablePlugins();

  // TPM search reads its descriptions from plugins.json, so a V2 plugin
  // missing there is a bug, not just a gap in the README.
  const undescribed = installable.filter(id => !Object.hasOwn(catalog, id) || !String(catalog[id].desc ?? '').trim());
  if (undescribed.length) {
    console.error(`plugins.json has no description for: ${undescribed.join(', ')}`);
    process.exit(1);
  }

  const readme = fs.readFileSync(readmePath, 'utf8');
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    console.error(`README.md must contain ${START} followed by ${END}`);
    process.exit(1);
  }
  const updated = `${readme.slice(0, start + START.length)}\n${renderList(catalog, installable)}\n${readme.slice(end)}`;
  if (updated === readme) {
    console.log('README plugin list is up to date');
    return;
  }
  if (check) {
    console.error('README plugin list is out of date; run node scripts/update-readme.js');
    process.exit(1);
  }
  fs.writeFileSync(readmePath, updated);
  console.log(`README plugin list updated: ${installable.length} plugins`);
}

main();
