// 의존성 없는 최소 ZIP 생성기(store 방식=무압축). PNG는 이미 압축돼 있어 store로 충분.
// 카드 캐러셀 이미지 N장을 한 파일로 묶어 다운로드하기 위함.
import {crc32} from 'node:zlib';
import fs from 'node:fs';

type Entry = {name: string; data: Buffer};

export function buildZip(files: {name: string; path: string}[]): Buffer {
  const entries: Entry[] = files.map((f) => ({name: f.name, data: fs.readFileSync(f.path)}));
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data) >>> 0;
    const size = e.data.length;

    // Local file header
    const lf = Buffer.alloc(30);
    lf.writeUInt32LE(0x04034b50, 0);   // signature
    lf.writeUInt16LE(20, 4);           // version needed
    lf.writeUInt16LE(0x0800, 6);       // flags (UTF-8 name)
    lf.writeUInt16LE(0, 8);            // method 0 = store
    lf.writeUInt16LE(0, 10);           // mod time
    lf.writeUInt16LE(0, 12);           // mod date
    lf.writeUInt32LE(crc, 14);
    lf.writeUInt32LE(size, 18);        // compressed size
    lf.writeUInt32LE(size, 22);        // uncompressed size
    lf.writeUInt16LE(nameBuf.length, 26);
    lf.writeUInt16LE(0, 28);           // extra len
    chunks.push(lf, nameBuf, e.data);

    // Central directory record
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);           // version made by
    cd.writeUInt16LE(20, 6);           // version needed
    cd.writeUInt16LE(0x0800, 8);       // flags
    cd.writeUInt16LE(0, 10);           // method
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);           // extra len
    cd.writeUInt16LE(0, 32);           // comment len
    cd.writeUInt16LE(0, 34);           // disk start
    cd.writeUInt16LE(0, 36);           // internal attrs
    cd.writeUInt32LE(0, 38);           // external attrs
    cd.writeUInt32LE(offset, 42);      // local header offset
    central.push(Buffer.concat([cd, nameBuf]));

    offset += lf.length + nameBuf.length + e.data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}
