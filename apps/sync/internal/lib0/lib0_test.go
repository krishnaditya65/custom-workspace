package lib0

import (
	"bytes"
	"testing"
)

func TestVarUintRoundTrip(t *testing.T) {
	cases := []uint64{0, 1, 127, 128, 300, 16384, 1 << 20, 1 << 40, 18446744073709551615}
	for _, want := range cases {
		e := NewEncoder()
		e.WriteVarUint(want)
		d := NewDecoder(e.Bytes())
		got, err := d.ReadVarUint()
		if err != nil {
			t.Fatalf("ReadVarUint(%d): unexpected error %v", want, err)
		}
		if got != want {
			t.Errorf("round trip mismatch: want %d, got %d", want, got)
		}
	}
}

func TestVarUint8ArrayRoundTrip(t *testing.T) {
	want := []byte{0xde, 0xad, 0xbe, 0xef, 0x00, 0x01}
	e := NewEncoder()
	e.WriteVarUint8Array(want)
	d := NewDecoder(e.Bytes())
	got, err := d.ReadVarUint8Array()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("want %x, got %x", want, got)
	}
}

func TestVarUint8ArrayEmpty(t *testing.T) {
	e := NewEncoder()
	e.WriteVarUint8Array(nil)
	d := NewDecoder(e.Bytes())
	got, err := d.ReadVarUint8Array()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("want empty, got %x", got)
	}
}

func TestVarStringRoundTrip(t *testing.T) {
	want := "hello, 世界 🌍"
	e := NewEncoder()
	e.WriteVarString(want)
	d := NewDecoder(e.Bytes())
	got, err := d.ReadVarString()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != want {
		t.Errorf("want %q, got %q", want, got)
	}
}

func TestReadVarUintShortBuffer(t *testing.T) {
	// A continuation byte (high bit set) with nothing following must error,
	// not panic or loop forever.
	d := NewDecoder([]byte{0x80})
	if _, err := d.ReadVarUint(); err != ErrShortBuffer {
		t.Errorf("want ErrShortBuffer, got %v", err)
	}
}

func TestReadVarUint8ArrayTruncated(t *testing.T) {
	e := NewEncoder()
	e.WriteVarUint(10) // claims 10 bytes follow
	e.buf.Write([]byte{1, 2, 3})
	d := NewDecoder(e.Bytes())
	if _, err := d.ReadVarUint8Array(); err != ErrShortBuffer {
		t.Errorf("want ErrShortBuffer, got %v", err)
	}
}

func TestSequentialReadsAdvancePosition(t *testing.T) {
	e := NewEncoder()
	e.WriteVarUint(1)
	e.WriteVarUint(2)
	e.WriteVarString("x")
	d := NewDecoder(e.Bytes())
	a, _ := d.ReadVarUint()
	b, _ := d.ReadVarUint()
	s, _ := d.ReadVarString()
	if a != 1 || b != 2 || s != "x" {
		t.Errorf("got a=%d b=%d s=%q", a, b, s)
	}
	if d.Remaining() != 0 {
		t.Errorf("expected buffer fully consumed, %d bytes remain", d.Remaining())
	}
}
