package store

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"io"
)

// frame length-prefixes each blob (uint32 BE length + bytes) so an arbitrary
// number of independent Yjs update blobs can be stored in one column and split
// back apart exactly, without needing to understand their contents.
func frame(blobs [][]byte) []byte {
	var buf bytes.Buffer
	for _, b := range blobs {
		var lenBuf [4]byte
		binary.BigEndian.PutUint32(lenBuf[:], uint32(len(b)))
		buf.Write(lenBuf[:])
		buf.Write(b)
	}
	return buf.Bytes()
}

func unframe(raw []byte) [][]byte {
	var blobs [][]byte
	for len(raw) >= 4 {
		n := binary.BigEndian.Uint32(raw[:4])
		raw = raw[4:]
		if uint32(len(raw)) < n {
			break // truncated/corrupt tail — stop rather than panic
		}
		blobs = append(blobs, raw[:n])
		raw = raw[n:]
	}
	return blobs
}

func gzipBytes(data []byte) ([]byte, error) {
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	if _, err := w.Write(data); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func gunzip(data []byte) ([]byte, error) {
	r, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return io.ReadAll(r)
}
