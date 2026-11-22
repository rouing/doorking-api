// Reader for MFC CArchive files (little-endian, length-prefixed strings, class tags).
export class ArchiveReader {
  private readonly buf: Buffer;
  private position = 0;
  private readonly classes: { name: string; schema: number }[] = [];

  constructor(buffer: Buffer) {
    this.buf = buffer;
  }

  // Bytes read so far.
  get pos(): number {
    return this.position;
  }

  get eof(): boolean {
    return this.position >= this.buf.length;
  }

  u8(): number {
    return this.buf[this.position++];
  }

  u16(): number {
    const value = this.buf.readUInt16LE(this.position);
    this.position += 2;
    return value;
  }

  i16(): number {
    const value = this.buf.readInt16LE(this.position);
    this.position += 2;
    return value;
  }

  u32(): number {
    const value = this.buf.readUInt32LE(this.position);
    this.position += 4;
    return value;
  }

  bytes(length: number): Buffer {
    const value = this.buf.subarray(this.position, this.position + length);
    this.position += length;
    return value;
  }

  // CString: 1-byte length, or 0xFF + 2-byte length, or 0xFF 0xFFFF + 4-byte length.
  string(): string {
    let length = this.u8();
    if (length === 0xff) {
      length = this.u16();
      if (length === 0xffff) length = this.u32();
    }
    return this.buf.toString('latin1', this.position, (this.position += length));
  }

  // Object tag before a serialized CObject. Returns the class name.
  // 0xFFFF = new class (schema + name follow); 0x8000|index = class seen before.
  classTag(): string {
    const tag = this.u16();
    if (tag === 0xffff) {
      const schema = this.u16();
      const nameLen = this.u16();
      const name = this.buf.toString('latin1', this.position, (this.position += nameLen));
      this.classes.push({ name, schema });
      return name;
    }
    if (tag & 0x8000) {
      const cls = this.classes[(tag & 0x7fff) - 1];
      if (!cls) throw new Error(`Unknown class index ${tag & 0x7fff} at 0x${(this.position - 2).toString(16)}`);
      return cls.name;
    }
    throw new Error(`Unexpected object tag 0x${tag.toString(16)} at 0x${(this.position - 2).toString(16)}`);
  }
}
