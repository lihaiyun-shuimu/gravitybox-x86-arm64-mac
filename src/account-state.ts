import { ProtobufReader as Reader, ProtobufWriter as Writer } from './protobuf.js';
import { bt } from './i18n.js';

function parseTopicValue(value: string | undefined): { wrapper?: Record<string, unknown>; encoded: string } {
  let wrapper: Record<string, unknown> | undefined;
  let encoded = value || '';
  if (encoded.startsWith('{')) {
    wrapper = JSON.parse(encoded);
    if (typeof wrapper?.data !== 'string') throw new Error(bt('account_state.err.invalid_format'));
    encoded = wrapper.data;
  }
  if (encoded && !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error(bt('account_state.err.invalid_format'));
  return { wrapper, encoded };
}

function filterTopicEntries(encoded: string, sentinel: string): Buffer[] {
  const data = Buffer.from(encoded, 'base64'), keep: Buffer[] = [];
  let offset = 0;
  while (offset < data.length) {
    const start = offset, tag = Reader.readVarint(data, offset);
    if (!tag) throw new Error(bt('account_state.err.incomplete'));
    const [field, pos] = tag;
    let content: Buffer | undefined;
    if ((field & 7) === 2) {
      const size = Reader.readVarint(data, pos);
      if (!size || size[1] + size[0] > data.length) throw new Error(bt('account_state.err.incomplete'));
      offset = size[1] + size[0]; content = data.subarray(size[1], offset);
    } else if ((field & 7) === 0) {
      const v = Reader.readVarint(data, pos); if (!v) throw new Error(bt('account_state.err.incomplete')); offset = v[1];
    } else if ((field & 7) === 1) offset = pos + 8;
    else if ((field & 7) === 5) offset = pos + 4;
    else throw new Error(bt('account_state.err.invalid_format'));
    if (offset > data.length) throw new Error(bt('account_state.err.incomplete'));
    if (!(field === 10 && content && Reader.findString(content, 1) === sentinel)) keep.push(data.subarray(start, offset));
  }
  return keep;
}

export function replaceTopicRow(value: string | undefined, sentinel: string, payload: Buffer): string {
  const { wrapper, encoded } = parseTopicValue(value);
  const keep = filterTopicEntries(encoded, sentinel);
  const row = Writer.encodeString(1, payload.toString('base64'));
  keep.push(Writer.encodeLengthDelimited(1, Buffer.concat([Writer.encodeString(1, sentinel), Writer.encodeLengthDelimited(2, row)])));
  const result = Buffer.concat(keep).toString('base64');
  return wrapper ? JSON.stringify({ ...wrapper, data: result }) : result;
}

export function removeTopicRow(value: string | undefined, sentinel: string): string | null {
  if (!value) return null;
  const { wrapper, encoded } = parseTopicValue(value);
  if (!encoded) return null;
  const keep = filterTopicEntries(encoded, sentinel);
  if (keep.length === 0) return null;
  const result = Buffer.concat(keep).toString('base64');
  return wrapper ? JSON.stringify({ ...wrapper, data: result }) : result;
}


export function decodeTopicRow(value: string, sentinel: string): Buffer | null {
  let encoded = value;
  if (value.startsWith('{')) encoded = JSON.parse(value).data;
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error(bt('account_state.err.invalid_format'));
  const data = Buffer.from(encoded, 'base64');
  let offset = 0;
  while (offset < data.length) {
    const tag = Reader.readVarint(data, offset);
    if (!tag) break;
    const [field, pos] = tag;
    const wireType = field & 7;
    let content: Buffer | undefined;
    if (wireType === 2) {
      const size = Reader.readVarint(data, pos);
      if (!size || size[1] + size[0] > data.length) break;
      offset = size[1] + size[0];
      content = data.subarray(size[1], offset);
    } else if (wireType === 0) {
      const v = Reader.readVarint(data, pos);
      if (!v) break;
      offset = v[1];
    } else if (wireType === 1) {
      offset = pos + 8;
      if (offset > data.length) break;
    } else if (wireType === 5) {
      offset = pos + 4;
      if (offset > data.length) break;
    } else {
      break;
    }
    if (field !== 10 || !content) continue;
    if (Reader.findString(content, 1) !== sentinel) continue;
    const row = Reader.findField(content, 2);
    if (!row) return null;
    const payload = Reader.findString(row, 1);
    if (payload && /^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return Buffer.from(payload, 'base64');
    return row; // Compatibility with the early, directly nested form.
  }
  return null;
}
