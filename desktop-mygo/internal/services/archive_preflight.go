package services

import (
	"encoding/binary"
	"fmt"
	"io"
)

// Walk the bounded central directory before archive/zip allocates one File
// object per entry. Do not trust the EOCD count alone (it can be forged).
func preflightArchive(source io.ReaderAt, size int64) error {
	tail := make([]byte, min(size, 65535+22))
	if len(tail) < 22 {
		return fmt.Errorf("ZIP 中央目录无效")
	}
	if _, err := source.ReadAt(tail, size-int64(len(tail))); err != nil {
		return err
	}
	end := -1
	for at := len(tail) - 22; at >= 0; at-- {
		if binary.LittleEndian.Uint32(tail[at:]) == 0x06054b50 && at+22+int(binary.LittleEndian.Uint16(tail[at+20:])) == len(tail) {
			end = at
			break
		}
	}
	if end < 0 {
		return fmt.Errorf("ZIP 中央目录无效")
	}
	eocd := tail[end:]
	count := binary.LittleEndian.Uint16(eocd[10:])
	length, offset := int64(binary.LittleEndian.Uint32(eocd[12:])), int64(binary.LittleEndian.Uint32(eocd[16:]))
	if binary.LittleEndian.Uint16(eocd[4:]) != 0 || binary.LittleEndian.Uint16(eocd[6:]) != 0 || binary.LittleEndian.Uint16(eocd[8:]) != count ||
		count > archiveEntries || length == 0xffffffff || offset == 0xffffffff || offset+length > size-int64(len(tail))+int64(end) {
		return fmt.Errorf("ZIP 条目过多，或使用不支持的分卷/ZIP64 归档")
	}
	header := make([]byte, 46)
	actual, limit := 0, offset+length
	for offset < limit {
		if offset+46 > limit {
			return fmt.Errorf("ZIP 中央目录截断")
		}
		if _, err := source.ReadAt(header, offset); err != nil {
			return err
		}
		if binary.LittleEndian.Uint32(header) != 0x02014b50 {
			return fmt.Errorf("ZIP 中央目录条目无效")
		}
		actual++
		if actual > archiveEntries {
			return fmt.Errorf("归档条目超过 10,000 项")
		}
		offset += 46 + int64(binary.LittleEndian.Uint16(header[28:])) + int64(binary.LittleEndian.Uint16(header[30:])) + int64(binary.LittleEndian.Uint16(header[32:]))
	}
	if actual != int(count) || offset != limit {
		return fmt.Errorf("ZIP 中央目录数量或长度不一致")
	}
	return nil
}
