/**
 * A minimal USTAR writer — just enough to hand Docker's
 * `PUT /containers/{id}/archive` a set of regular files.
 *
 * Written rather than depended on: the archives are a handful of small files
 * we generate ourselves (the gateway CA, credential stubs), so a tar library
 * would be a dependency carrying an extraction path we never use — and
 * extraction is where tar CVEs live.
 */

const BLOCK = 512;

const writeString = (
  block: Buffer,
  value: string,
  offset: number,
  length: number,
): void => {
  block.write(value.slice(0, length - 1), offset, length - 1, "utf8");
};

/** USTAR numeric fields are octal, NUL-terminated, zero-padded. */
const writeOctal = (
  block: Buffer,
  value: number,
  offset: number,
  length: number,
): void => {
  const text = value.toString(8).padStart(length - 1, "0");
  block.write(text, offset, length - 1, "ascii");
};

export interface TarEntry {
  /** Path INSIDE the archive, relative (docker resolves it against the
   * extraction directory). */
  path: string;
  content: string;
  mode: number;
}

const header = (entry: TarEntry, size: number): Buffer => {
  const block = Buffer.alloc(BLOCK);
  writeString(block, entry.path, 0, 100);
  writeOctal(block, entry.mode & 0o7777, 100, 8);
  writeOctal(block, 0, 108, 8); // uid — extracted as the container's user
  writeOctal(block, 0, 116, 8); // gid
  writeOctal(block, size, 124, 12);
  // mtime: a fixed epoch, so the same files always produce the same bytes
  // rather than an archive that differs on every build.
  writeOctal(block, 0, 136, 12);
  block.write("        ", 148, 8, "ascii"); // checksum placeholder
  block.write("0", 156, 1, "ascii"); // typeflag: regular file
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");

  let checksum = 0;
  for (const byte of block) checksum += byte;
  writeOctal(block, checksum, 148, 7);
  block.write("\0", 154, 1, "ascii");

  return block;
};

const pad = (size: number): Buffer =>
  Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** Build a tar archive containing exactly these files. */
export const buildTar = (entries: TarEntry[]): Buffer => {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content, "utf8");
    parts.push(header(entry, content.length), content, pad(content.length));
  }
  // Two zero blocks terminate the archive.
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
};
