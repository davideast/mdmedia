import { expect, test } from 'bun:test';
import { readMp4Duration } from './mp4-duration.js';

function movie(duration: number, version: number) {
  const data=Buffer.alloc(version===1?48:36);
  data.writeUInt32BE(data.length,0);data.write('moov',4);
  data.writeUInt32BE(data.length-8,8);data.write('mvhd',12);data[16]=version;
  const scaleOffset=version===1?36:28;
  data.writeUInt32BE(1000,scaleOffset);
  if(version===1)data.writeBigUInt64BE(BigInt(duration*1000),scaleOffset+4);else data.writeUInt32BE(duration*1000,scaleOffset+4);
  return data;
}
test('reads actual movie duration from 32-bit and 64-bit MP4 headers',()=>{
  expect(readMp4Duration(movie(10,0))).toBe(10);
  expect(readMp4Duration(movie(18,1))).toBe(18);
});
test('does not invent a duration for missing or truncated headers',()=>{
  expect(readMp4Duration(new Uint8Array())).toBeUndefined();
  expect(readMp4Duration(movie(18,1).subarray(0,40))).toBeUndefined();
});
