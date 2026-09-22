import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class LocalFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalFileError";
  }
}
export type UploadSource = {
  readonly handle: FileHandle;
  readonly filename: string;
};

function isContained(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return remainder === ""
    || (!isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`));
}

export class LocalFilePolicy {
  private roots: Promise<readonly string[]> | undefined;

  constructor(private readonly configuredRoots: readonly string[]) {}

  private getRoots(): Promise<readonly string[]> {
    if (this.roots) return this.roots;
    this.roots = Promise.all(this.configuredRoots.map(async (root) => {
      const canonical = await realpath(root);
      const metadata = await stat(canonical);
      if (!metadata.isDirectory()) {
        throw new LocalFileError("Configured file roots must be directories");
      }
      if ((metadata.mode & 0o022) !== 0) {
        throw new LocalFileError("Configured file roots must not be group or world writable");
      }
      return canonical;
    }));
    return this.roots;
  }

  private async rootsOrThrow(): Promise<readonly string[]> {
    const roots = await this.getRoots();
    if (roots.length === 0) {
      throw new LocalFileError("File transfers require PROXMOX_FILE_ROOTS");
    }
    return roots;
  }

  private async rootFor(path: string): Promise<string> {
    const root = (await this.rootsOrThrow()).find((candidate) => isContained(candidate, path));
    if (!root) {
      throw new LocalFileError("Local file path is outside PROXMOX_FILE_ROOTS");
    }
    return root;
  }

  private async assertPrivateParents(root: string, path: string): Promise<void> {
    for (let parent = dirname(path); isContained(root, parent); parent = dirname(parent)) {
      const metadata = await stat(parent);
      if (!metadata.isDirectory() || (metadata.mode & 0o022) !== 0) {
        throw new LocalFileError("Upload parent directories must not be group or world writable");
      }
      if (parent === root) return;
    }
  }

  async uploadSource(path: string): Promise<UploadSource> {
    await this.rootsOrThrow();
    const canonical = await realpath(path);
    const root = await this.rootFor(canonical);
    await this.assertPrivateParents(root, canonical);
    const expected = await stat(canonical);
    if (!expected.isFile()) {
      throw new LocalFileError("Upload source must be a regular file");
    }
    const handle = await open(canonical, "r");
    try {
      const opened = await handle.stat();
      if (opened.dev !== expected.dev || opened.ino !== expected.ino || !opened.isFile()) {
        throw new LocalFileError("Upload source changed while it was being opened");
      }
      return { handle, filename: basename(canonical) };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async downloadPath(path: string): Promise<string> {
    const parent = await realpath(dirname(path));
    const canonical = resolve(parent, basename(path));
    await this.rootFor(canonical);
    return canonical;
  }
}
