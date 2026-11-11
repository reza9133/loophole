// Minimal, dependency-free flag parser shared by the scripts.

export function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [name, inline] = arg.slice(2).split('=');
    if (inline !== undefined) values[name] = inline;
    else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) {
      values[name] = argv[index + 1];
      index += 1;
    } else flags.add(name);
  }
  return { flags, values };
}
