/**
 * How a repository turns values into stored bytes and back.
 *
 * A codec is a setting of the `Repo`, not of the store: nothing records
 * which one wrote a value, so every reader of a store has to use the
 * codec its writers did.
 */

/** Values to bytes and back. `decode(encode(v))` must give back `v`. */
export interface Codec<V> {
  encode(value: V): Uint8Array
  decode(bytes: Uint8Array): V
}

/** Values are bytes, stored as they are. */
export const bytesCodec: Codec<Uint8Array> = {
  encode: (value) => value,
  decode: (bytes) => bytes,
}

const _encoder = new TextEncoder()
const _decoder = new TextDecoder()

/** Values are anything `JSON.stringify` writes and `JSON.parse` reads
 *  back the same: plain objects, arrays, strings, finite numbers,
 *  booleans and null. */
export const jsonCodec: Codec<unknown> = {
  encode: (value) => {
    const text = JSON.stringify(value)
    if (text === undefined) throw new TypeError(`jsonCodec cannot encode ${typeof value}`)
    return _encoder.encode(text)
  },
  decode: (bytes) => JSON.parse(_decoder.decode(bytes)) as unknown,
}
