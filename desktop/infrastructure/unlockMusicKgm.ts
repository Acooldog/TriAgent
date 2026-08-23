const TABLE1 = bytes("000000000000000000000000000000000001210161012101e101210161012101d223020242420202c2c2020242420202d3d3020363436303e3c3e3036343630394b494650404040484848484040404049595959504052505e585a585e5052505d6b696b6d6270606c6c68686c6c60606d7d79797d7d70607e7c7e787e7c7e70718381878183818e9080808080808080819191919191919190809290969092909da3a1a3a5a3a1a3ada2b0a0a4a4a0a0adbdb1b1b5b5b1b1bdbdb0a0b6b4b6b0b9cbc9c7c1c3c1c7c9cbc9c6d0c0c0c0c9d9d9d9d1d1d1d1d9d9d9d9d0c0d2d0ddebe9ebede3e1e3edebe9ebede2f0e0edfdf9f9fdfdf1f1fdfdf9f9fdfdf0e0f00200060002000e000200060002000f1");
const TABLE2 = bytes("000000000000000000000000000000000001230167012301ef01230167012301df21020246460202cece020246460202dede020365476503edcfed03654765039dbf9d63040404048c8c8c8c040404049c9c9c9c04052705eb8daf8deb052705dbbd9fbddb250606caca8e8ecaca0606dada9e9edada0607e9cbe98fe9cbe907193b197f193b19e70808080808080808181818181818181808092b096f092b09d7391b395f391b39d7290a0a4e4e0a0ad6d61a1a5e5e1a1ad6d60a0b6d4f6d0b95b7957b1d3f1d7b95b7956b0c0c0c0c949494941c1c1c1c949494940c0d2f0dd3b597b5d33d1f3dd3b597b5d32d0e0ed2d29696d2d21e1ed2d29696d2d20e0f00220066002200ee00220066002200fe");
const MASK = bytes("b8d53db2e9af788c8333715176a0cd372f3e358da9be98b7e78c22ce5a61df686989fea5b6dea977fcc8bdbde56d3e5a36ef694ebee1e9661cf3d902b6f2129b44d06fb93589b6466d73820669c1edd785c230dfa262be792d62623d0d7ebe48892302a0e4d57551320253fd163a213b160fc3b2bbb3e2ba3a3d13ecf6014584a5700f93490c64cd31d5cc4c07019e001a2390bf881e3baba63ec47347107e3b5ebce30084ff09d4e0890f5b58704ffb65d85c531bd3c8c6bfef98b0504f0feae583588c282c8467cdd09e47db2750caf46363e8977f1b4b0cc2c1214ccc58f59452a3f3d3e068f40023f35e0a7b93ddab12b213e884d7a79f0f324c551d043652dc03f3f94e42e93d61ef7cb6b39350");
const KGM_MAGIC = bytes("7cd532eb86027f4ba8afa68e0fff9914");

export function decryptUnlockMusicKgm(input: Uint8Array): Uint8Array {
  if (!startsWith(input, KGM_MAGIC)) throw new UnlockMusicUnsupportedError("不支持此酷狗文件格式。");
  const headerLength = readUint32LE(input, 0x10);
  if (headerLength < 0x2c || headerLength > input.length) throw new Error("酷狗文件头无效。");
  const key = new Uint8Array(17);
  key.set(input.slice(0x1c, 0x2c));
  const output = input.slice(headerLength);
  for (let index = 0; index < output.length; index += 1) {
    const position = index;
    let mask = getMask(position);
    mask ^= (mask & 0x0f) << 4;
    let value = key[position % 17] ^ output[index];
    value ^= (value & 0x0f) << 4;
    output[index] = value ^ mask;
  }
  return output;
}

export class UnlockMusicUnsupportedError extends Error { public constructor(message: string) { super(message); this.name = "UnlockMusicUnsupportedError"; } }
function getMask(position: number): number { let offset = position >> 4; let value = 0; while (offset >= 0x11) { value ^= TABLE1[offset % 272]!; offset >>= 4; value ^= TABLE2[offset % 272]!; offset >>= 4; } return MASK[position % 272]! ^ value; }
function bytes(value: string): Uint8Array { return Uint8Array.from(value.match(/.{2}/g)!.map((item) => Number.parseInt(item, 16))); }
function readUint32LE(value: Uint8Array, offset: number): number { return (value[offset]! | (value[offset + 1]! << 8) | (value[offset + 2]! << 16) | (value[offset + 3]! << 24)) >>> 0; }
function startsWith(value: Uint8Array, prefix: Uint8Array): boolean { return prefix.every((item, index) => value[index] === item); }
