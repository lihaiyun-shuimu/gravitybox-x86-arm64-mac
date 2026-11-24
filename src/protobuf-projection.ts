/** Select small metadata fields from a protobuf BLOB without loading skipped payloads. */
import { bt } from './i18n.js';
export type ProtoSelection = { [field: number]: true | ProtoSelection };
export const GENERATION_PROJECTION: ProtoSelection = {
  1: { 3: true, 4: true, 9: { 4: { 1: true } }, 19: true, 21: true },
  2: true,
  4: true,
};
export const STEP_PROJECTION: ProtoSelection = {
  1: { 1: true },
  9: true,
  12: true,
};
export const HUD_STEP_METADATA_PROJECTION: ProtoSelection = {
  1: true,
  4: { 2: true, 3: true, 8: true },
  6: true,
  7: true,
  8: true,
  9: true,
  12: true,
  22: true,
  24: { 4: true, 8: true, 12: true, 20: true },
  32: true,
};
export const HUD_STEP_METADATA_MINIMAL_PROJECTION: ProtoSelection = {
  ...HUD_STEP_METADATA_PROJECTION,
  4: { 2: true },
};
export const HUD_STEP_RENDER_INFO_PROJECTION: ProtoSelection = {
  9: { 5: true },
  10: {
    4: true,
    5: {
      1: {
        9: { 5: true },
        10: { 4: true },
      },
    },
  },
};
export const HUD_GEN_METADATA_PROJECTION: ProtoSelection = {
  1: {
    3: true,
    4: true,
    9: { 4: { 1: true }, 10: { 1: true, 4: true } },
    11: true,
    12: true,
    19: true,
    21: true,
  },
  2: true,
  4: true,
  3: {
    1: true,
    14: true,
    27: { 4: true, 8: true, 12: true, 20: true },
    28: true,
    60: { 1: true },
  },
};
export const HUD_EXECUTOR_METADATA_PROJECTION: ProtoSelection = {
  10: {
    1: {
      1: true,
      14: true,
      27: { 4: true, 8: true, 12: true, 20: true },
      28: true,
      60: { 1: true },
    },
    2: {
      5: true,
    },
  },
};

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  do { const byte=value%128;value=Math.floor(value/128);bytes.push(byte+(value?128:0)); } while(value);
  return Buffer.from(bytes);
}

export interface ProtoProjectionLimits {
  maxReadBytes: number;
  maxOutputBytes: number;
  maxFieldBytes: number;
  maxFields: number;
  maxMs: number;
  chunkBytes?: number;
  skipOversizedLeafFields?: boolean;
}

export const USAGE_PROJECTION_VERSION = 3;

export const DEFAULT_PROTO_LIMITS: ProtoProjectionLimits = {
  maxReadBytes: 4 * 1024 * 1024,
  maxOutputBytes: 256 * 1024,
  maxFieldBytes: 64 * 1024,
  maxFields: 20000,
  maxMs: 1500,
};

export const USAGE_PROTO_LIMITS: ProtoProjectionLimits = {
  maxReadBytes: 16 * 1024 * 1024,
  maxOutputBytes: 256 * 1024,
  maxFieldBytes: 64 * 1024,
  maxFields: 100_000,
  maxMs: 4000,
  chunkBytes: 16 * 1024,
};

export const HUD_GEN_PROTO_LIMITS: ProtoProjectionLimits = {
  maxReadBytes: 24 * 1024 * 1024,
  maxOutputBytes: 256 * 1024,
  maxFieldBytes: 64 * 1024,
  maxFields: 150_000,
  maxMs: 4000,
  chunkBytes: 16 * 1024,
  skipOversizedLeafFields: true,
};

export function projectProtobuf(
  size: number,
  readChunk: (offset: number, length: number) => Uint8Array,
  selection: ProtoSelection,
  limitsInput?: Partial<ProtoProjectionLimits>
) {
  const limits: ProtoProjectionLimits = { ...DEFAULT_PROTO_LIMITS, ...limitsInput };
  if(!Number.isSafeInteger(size)||size<0)throw Error(bt('proto.err.invalid_length'));
  let cache:Buffer=Buffer.alloc(0),cacheStart=-1,bytesRead=0,fields=0,outputBytes=0;
  const started=performance.now();
  function read(offset:number,length:number):Buffer {
    if(performance.now()-started>limits.maxMs)throw Error(bt('proto.err.time_budget'));
    if(offset<0||length<0||offset+length>size)throw Error(bt('proto.err.out_of_bounds'));
    if(offset>=cacheStart&&offset+length<=cacheStart+cache.length)return cache.subarray(offset-cacheStart,offset-cacheStart+length);
    const minChunk=limits.chunkBytes&&limits.chunkBytes>0?limits.chunkBytes:65536;
    const take=Math.min(size-offset,Math.max(length,minChunk));
    if(bytesRead+take>limits.maxReadBytes)throw Error(bt('proto.err.byte_budget'));
    const chunk=readChunk(offset,take);bytesRead+=chunk.byteLength;
    if(chunk.byteLength!==take)throw Error(bt('proto.err.incomplete_read'));
    cache=Buffer.from(chunk.buffer,chunk.byteOffset,chunk.byteLength);cacheStart=offset;
    return cache.subarray(0,length);
  }
  function varint(offset:number,end:number):[bigint,number] {
    const bytes=read(offset,Math.min(10,end-offset));let n=0n;
    for(let i=0;i<bytes.length;i++){const byte=bytes[i]!;if(i===9&&byte>1)throw Error(bt('proto.err.varint_overflow'));n|=BigInt(byte&127)<<BigInt(i*7);if(!(byte&128))return[n,offset+i+1];}
    throw Error(bt('proto.err.varint_incomplete'));
  }
  function safe(value:bigint):number {if(value>BigInt(Number.MAX_SAFE_INTEGER))throw Error(bt('proto.err.length_overflow'));return Number(value);}
  function project(start:number,end:number,wanted:ProtoSelection,depth:number):Buffer {
    if(depth>4)throw Error(bt('proto.err.nesting_budget'));const result:Buffer[]=[];let cursor=start;
    while(cursor<end){
      if(++fields>limits.maxFields)throw Error(bt('proto.err.field_count_budget'));
      const fieldStart=cursor,[tag,next]=varint(cursor,end),tagNumber=safe(tag),wire=tagNumber%8,field=Math.floor(tagNumber/8);
      if(field<1||field>536870911)throw Error(bt('proto.err.invalid_field_number'));cursor=next;
      let contentStart=cursor;
      if(wire===2){const [length,afterLength]=varint(cursor,end);contentStart=afterLength;cursor=contentStart+safe(length);}
      else if(wire===0)cursor=varint(cursor,end)[1];
      else if(wire===1)cursor+=8;
      else if(wire===5)cursor+=4;
      else throw Error(bt('proto.err.unsupported_wire_type'));
      if(cursor>end)throw Error(bt('proto.err.field_length_oob'));
      const child=wanted[field];if(!child)continue;
      let selected:Buffer;
      if(child!==true){if(wire!==2)throw Error(bt('proto.err.wire_type_mismatch'));const inner=project(contentStart,cursor,child,depth+1);selected=Buffer.concat([encodeVarint(tagNumber),encodeVarint(inner.length),inner]);}
      else {
        if(cursor-fieldStart>limits.maxFieldBytes){
          if(limits.skipOversizedLeafFields)continue;
          throw Error(bt('proto.err.field_bytes_limit'));
        }
        selected=Buffer.from(read(fieldStart,cursor-fieldStart));
      }
      outputBytes+=selected.length;if(outputBytes>limits.maxOutputBytes)throw Error(bt('proto.err.output_budget'));result.push(selected);
    }
    return Buffer.concat(result);
  }
  const data=project(0,size,selection,0);
  return{data,bytesRead,fields};
}
