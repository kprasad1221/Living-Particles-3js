// Node resolve hook: lets the page's own modules (which import 'three' through the browser
// import map) run under Node against the local copy in tools/node_modules. No stubs: the
// real three.js classes are used, only the bare specifier is mapped.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const NM = join(dirname(fileURLToPath(import.meta.url)), 'node_modules', 'three');

export function resolve(specifier, context, next) {
  if (specifier === 'three') return { url: pathToFileURL(join(NM, 'build', 'three.module.js')).href, shortCircuit: true };
  if (specifier.startsWith('three/addons/')) return { url: pathToFileURL(join(NM, 'examples', 'jsm', specifier.slice('three/addons/'.length))).href, shortCircuit: true };
  return next(specifier, context);
}
