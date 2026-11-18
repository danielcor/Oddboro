// The runner for ledger search, onnxruntime-node, in the staged server. Its
// npm package carries native code for every system it supports, about 290 MB
// in all. The stage keeps the loader and this machine's files only, which the
// Mac release signs with the app's own identity, as it does the terminal's:
// the hardened Node sidecar loads no library without the app's team ID.
//
// What each system needs: on a Mac the binding and the one library it links
// (`@rpath/libonnxruntime.1.dylib`, beside it); on Linux the binding and
// `libonnxruntime.so.1`; on Windows the binding, `onnxruntime.dll` and the
// DirectML libraries it loads. The package has no build for an Intel Mac,
// and the app is for Apple Silicon only.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';

const FILES: Record<string, string[]> = {
  darwin: ['onnxruntime_binding.node', 'libonnxruntime.1.dylib'],
  linux: ['onnxruntime_binding.node', 'libonnxruntime.so.1'],
  win32: ['onnxruntime_binding.node', 'onnxruntime.dll', 'DirectML.dll', 'dxcompiler.dll']
};

/** This machine's native files in the staged package, which the Mac release signs. */
export function searchRuntimeFiles(stage: string): string[] {
  const pkg = join(stage, 'node_modules', 'onnxruntime-node');
  const names = FILES[process.platform];
  if (!names) throw new Error(`No search runner for ${process.platform}`);
  const folder = join(pkg, 'bin', 'napi-v6', process.platform, process.arch);
  return names.map((name) => {
    const file = join(folder, name);
    if (!existsSync(file))
      throw new Error(`The search runner has no ${name} for ${process.platform}-${process.arch}`);
    return file;
  });
}

/** Trims the staged package to its loader and this machine's files, and names those files. */
export function stageSearchRuntime(stage: string): string[] {
  const pkg = join(stage, 'node_modules', 'onnxruntime-node');
  const files = searchRuntimeFiles(stage);
  // The install script and the TypeScript sources are for npm and the package's own build.
  const keep = [...files, ...['package.json', 'dist'].map((p) => join(pkg, p))];
  function trim(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (keep.includes(file)) continue;
      if (entry.isDirectory() && keep.some((p) => p.startsWith(file + sep))) trim(file);
      else rmSync(file, { recursive: true, force: true });
    }
  }
  trim(pkg);
  return files;
}
