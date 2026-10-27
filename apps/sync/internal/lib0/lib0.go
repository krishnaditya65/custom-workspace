// Package lib0 implements the minimal subset of the lib0 binary encoding used by
// the Yjs wire protocol (y-protocols/sync and y-protocols/awareness): unsigned
// LEB128 varints and length-prefixed byte/string arrays. Every Yjs client
// (y-websocket, HocuspocusProvider, y-indexeddb, ...) speaks this exact framing,
// so a server never needs to understand Yjs CRDT internals to relay messages
// correctly — it only needs to read/write these envelopes. See docs/ARCHITECTURE.md
// "Go sync relay" section for why this project deliberately stops at the wire
// layer instead of embedding a full CRDT engine.
package lib0

import (
	"bytes"
	"errors"
)

var ErrShortBuffer = errors.New("lib0: unexpected end of buffer")

// Decoder reads sequential lib0-encoded values from a byte slice.
type Decoder struct {
	buf []byte
	pos int
}

func NewDecoder(buf []byte) *Decoder { return &Decoder{buf: buf} }

func (d *Decoder) Remaining() int { return len(d.buf) - d.pos }

func (d *Decoder) ReadByte() (byte, error) {
	if d.pos >= len(d.buf) {
		return 0, ErrShortBuffer
	}
	b := d.buf[d.pos]
	d.pos++
	return b, nil
}

// ReadVarUint reads a ULEB128-encoded unsigned integer (7 data bits per byte,
// high bit = continuation), matching lib0/decoding.js#readVarUint.
func (d *Decoder) ReadVarUint() (uint64, error) {
	var num uint64
	var shift uint
	for {
		b, err := d.ReadByte()
		if err != nil {
			return 0, err
		}
		num |= uint64(b&0x7f) << shift
		if b&0x80 == 0 {
			return num, nil
		}
		shift += 7
		if shift > 63 {
			return 0, errors.New("lib0: varuint overflow")
		}
	}
}

// ReadVarUint8Array reads a varUint length prefix followed by that many raw bytes.
func (d *Decoder) ReadVarUint8Array() ([]byte, error) {
	n, err := d.ReadVarUint()
	if err != nil {
		return nil, err
	}
	if d.pos+int(n) > len(d.buf) {
		return nil, ErrShortBuffer
	}
	out := d.buf[d.pos : d.pos+int(n)]
	d.pos += int(n)
	return out, nil
}

// ReadVarString reads a varUint8Array and interprets it as UTF-8 text.
func (d *Decoder) ReadVarString() (string, error) {
	b, err := d.ReadVarUint8Array()
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// Rest returns all remaining unread bytes without consuming them.
func (d *Decoder) Rest() []byte { return d.buf[d.pos:] }

// Encoder writes sequential lib0-encoded values into a growable buffer.
type Encoder struct {
	buf bytes.Buffer
}

func NewEncoder() *Encoder { return &Encoder{} }

func (e *Encoder) PutByte(b byte) { e.buf.WriteByte(b) }

// WriteVarUint writes a ULEB128-encoded unsigned integer.
func (e *Encoder) WriteVarUint(num uint64) {
	for {
		b := byte(num & 0x7f)
		num >>= 7
		if num != 0 {
			e.buf.WriteByte(b | 0x80)
		} else {
			e.buf.WriteByte(b)
			return
		}
	}
}

func (e *Encoder) WriteVarUint8Array(data []byte) {
	e.WriteVarUint(uint64(len(data)))
	e.buf.Write(data)
}

func (e *Encoder) WriteVarString(s string) {
	e.WriteVarUint8Array([]byte(s))
}

func (e *Encoder) Bytes() []byte { return e.buf.Bytes() }
