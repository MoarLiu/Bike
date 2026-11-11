package services

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	"image/png"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

type Metadata struct {
	MediaType  string `json:"mediaType"`
	ByteLength int64  `json:"byteLength"`
	Width      int    `json:"width,omitzero"`
	Height     int    `json:"height,omitzero"`
}

func (metadata *Metadata) UnmarshalJSON(raw []byte) error {
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	mediaType, ok := fields["mediaType"].(string)
	if !ok {
		return fmt.Errorf("附件元数据无效")
	}
	length, ok := fields["byteLength"].(float64)
	if !ok || math.IsInf(length, 0) || length != math.Trunc(length) || length < 0 || length > float64(contracts.Limits.AttachmentBytes) {
		return fmt.Errorf("附件元数据无效或超过大小预算")
	}
	value := Metadata{MediaType: mediaType, ByteLength: int64(length)}
	for _, field := range []string{"width", "height"} {
		if raw, exists := fields[field]; exists {
			number, ok := raw.(float64)
			if !ok || number != math.Trunc(number) || number < 1 || number > 0xffffffff {
				return fmt.Errorf("附件图片尺寸无效")
			}
			if field == "width" {
				value.Width = int(number)
			} else {
				value.Height = int(number)
			}
		}
	}
	if err := ValidateMetadata(value); err != nil {
		return err
	}
	*metadata = value
	return nil
}

type Asset struct {
	AssetID  string   `json:"assetId"`
	Name     string   `json:"name,omitempty"`
	Metadata Metadata `json:"metadata"`
}
type Candidate struct {
	AssetID    string `json:"assetId"`
	ByteLength int64  `json:"byteLength"`
}
type upload struct {
	file          *os.File
	name          string
	size          int64
	written       int64
	expires       time.Time
	context       context.Context
	timer         *time.Timer
	stopPageWatch func() bool
}
type scanTicket struct {
	ids     []string
	expires time.Time
}
type Attachments struct {
	Directory string
	mu        sync.Mutex
	pinned    map[string]bool
	uploads   map[string]*upload
	scans     map[string]scanTicket
}

var assetIDPattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var ErrAttachmentIntegrity = errors.New("附件完整性校验失败")

func assetDigest(id string) (string, error) {
	if !assetIDPattern.MatchString(id) {
		return "", fmt.Errorf("附件标识无效，原数据已保留")
	}
	return id[7:], nil
}

func NewAttachments(directory string) *Attachments {
	return &Attachments{Directory: directory, pinned: map[string]bool{}, uploads: map[string]*upload{}, scans: map[string]scanTicket{}}
}

func (library *Attachments) objectPath(id string) (string, error) {
	digest, err := assetDigest(id)
	if err != nil {
		return "", err
	}
	if err := privateDirectory(library.Directory); err != nil {
		return "", err
	}
	parent := filepath.Join(library.Directory, digest[:2])
	if err := privateDirectory(parent); err != nil {
		return "", err
	}
	return filepath.Join(parent, digest), nil
}

func metadataFor(header []byte, length int64) Metadata {
	metadata := Metadata{MediaType: "application/octet-stream", ByteLength: length}
	if len(header) >= 5 && string(header[:5]) == "%PDF-" {
		metadata.MediaType = "application/pdf"
		return metadata
	}
	if len(header) >= 24 && bytes.Equal(header[:8], []byte{137, 80, 78, 71, 13, 10, 26, 10}) && string(header[12:16]) == "IHDR" {
		metadata.MediaType = "image/png"
		metadata.Width, metadata.Height = int(binary.BigEndian.Uint32(header[16:20])), int(binary.BigEndian.Uint32(header[20:24]))
	} else if len(header) >= 3 && header[0] == 0xff && header[1] == 0xd8 && header[2] == 0xff {
		for offset := 2; offset+4 <= len(header); {
			if header[offset] != 0xff {
				break
			}
			offset++
			for offset < len(header) && header[offset] == 0xff {
				offset++
			}
			if offset >= len(header) {
				break
			}
			marker := header[offset]
			offset++
			if marker == 0xda || marker == 0xd9 {
				break
			}
			if marker == 1 || marker >= 0xd0 && marker <= 0xd7 {
				continue
			}
			if offset+2 > len(header) {
				break
			}
			size := int(binary.BigEndian.Uint16(header[offset : offset+2]))
			if size < 2 || offset+size > len(header) {
				break
			}
			if marker >= 0xc0 && marker <= 0xcf && marker != 0xc4 && marker != 0xc8 && marker != 0xcc && size >= 7 {
				metadata.MediaType = "image/jpeg"
				metadata.Height = int(binary.BigEndian.Uint16(header[offset+3 : offset+5]))
				metadata.Width = int(binary.BigEndian.Uint16(header[offset+5 : offset+7]))
				break
			}
			offset += size
		}
	} else if len(header) >= 25 && string(header[:4]) == "RIFF" && string(header[8:12]) == "WEBP" {
		chunk := string(header[12:16])
		if chunk == "VP8X" && len(header) >= 30 {
			metadata.Width = 1 + int(header[24]) + int(header[25])<<8 + int(header[26])<<16
			metadata.Height = 1 + int(header[27]) + int(header[28])<<8 + int(header[29])<<16
		}
		if chunk == "VP8 " && len(header) >= 30 && header[23] == 0x9d && header[24] == 1 && header[25] == 0x2a {
			metadata.Width = int(binary.LittleEndian.Uint16(header[26:28]) & 0x3fff)
			metadata.Height = int(binary.LittleEndian.Uint16(header[28:30]) & 0x3fff)
		}
		if chunk == "VP8L" && header[20] == 0x2f {
			bits := binary.LittleEndian.Uint32(header[21:25])
			metadata.Width = int(bits&0x3fff) + 1
			metadata.Height = int(bits>>14&0x3fff) + 1
		}
		metadata.MediaType = "image/webp"
	}
	if (metadata.MediaType == "image/png" || metadata.MediaType == "image/jpeg" || metadata.MediaType == "image/webp") && (metadata.Width == 0 || metadata.Height == 0) {
		metadata.MediaType = "application/octet-stream"
		metadata.Width, metadata.Height = 0, 0
	}
	// An empty payload is a valid immutable object.
	return metadata
}

func ValidateMetadata(metadata Metadata) error {
	if metadata.ByteLength < 0 || metadata.ByteLength > int64(contracts.Limits.AttachmentBytes) || !regexp.MustCompile(`^[a-z0-9.+-]+/[a-z0-9.+-]+$`).MatchString(metadata.MediaType) {
		return fmt.Errorf("附件元数据无效或超过大小预算，原数据已保留")
	}
	if metadata.Width < 0 || metadata.Height < 0 || uint64(metadata.Width) > 0xffffffff || uint64(metadata.Height) > 0xffffffff {
		return fmt.Errorf("附件图片尺寸无效")
	}
	if (metadata.MediaType == "image/png" || metadata.MediaType == "image/jpeg" || metadata.MediaType == "image/webp") && (metadata.Width == 0 || metadata.Height == 0) {
		return fmt.Errorf("附件图片缺少尺寸")
	}
	return nil
}

func inspectFile(file *os.File) (string, Metadata, error) {
	stat, err := file.Stat()
	if err != nil {
		return "", Metadata{}, err
	}
	if !stat.Mode().IsRegular() || stat.Size() > int64(contracts.Limits.AttachmentBytes) {
		return "", Metadata{}, fmt.Errorf("附件无效或超过 128 MiB")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", Metadata{}, err
	}
	hash := sha256.New()
	count, err := io.Copy(hash, io.LimitReader(file, int64(contracts.Limits.AttachmentBytes)+1))
	if err != nil || count != stat.Size() {
		return "", Metadata{}, fmt.Errorf("附件在读取期间发生变化")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", Metadata{}, err
	}
	header := make([]byte, min(count, 1024*1024))
	if _, err := io.ReadFull(file, header); err != nil {
		return "", Metadata{}, err
	}
	final, err := file.Stat()
	if err != nil || final.Size() != stat.Size() || final.ModTime() != stat.ModTime() {
		return "", Metadata{}, fmt.Errorf("附件在读取期间发生变化")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", Metadata{}, err
	}
	return "sha256:" + hex.EncodeToString(hash.Sum(nil)), metadataFor(header, count), nil
}

func (library *Attachments) Open(id string, expected *Metadata) (*os.File, Metadata, error) {
	library.mu.Lock()
	defer library.mu.Unlock()
	return library.openLocked(id, expected)
}

func (library *Attachments) openLocked(id string, expected *Metadata) (*os.File, Metadata, error) {
	target, err := library.objectPath(id)
	if err != nil {
		return nil, Metadata{}, err
	}
	var restoredFrom string
	if _, err := os.Lstat(target); os.IsNotExist(err) {
		quarantine := filepath.Join(library.Directory, "quarantine")
		if err := privateDirectory(quarantine); err != nil {
			return nil, Metadata{}, err
		}
		source := filepath.Join(quarantine, id[7:])
		if _, err := regularFile(source); err != nil {
			return nil, Metadata{}, err
		}
		if err := os.Link(source, target); err != nil && !os.IsExist(err) {
			return nil, Metadata{}, err
		}
		restoredFrom = source
	}
	file, err := openRegular(target)
	if err != nil {
		return nil, Metadata{}, err
	}
	actual, metadata, err := inspectFile(file)
	if err != nil || actual != id {
		file.Close()
		return nil, Metadata{}, fmt.Errorf("%w，请重新导入原件", ErrAttachmentIntegrity)
	}
	if expected != nil && *expected != metadata {
		file.Close()
		return nil, Metadata{}, fmt.Errorf("%w：附件文件与元数据不一致", ErrAttachmentIntegrity)
	}
	if restoredFrom != "" {
		os.Remove(restoredFrom)
	}
	library.pinned[id] = true
	return file, metadata, nil
}

func (library *Attachments) Import(ctx context.Context, filename, name string, repair bool) (Asset, error) {
	var result Asset
	if name == "" {
		name = filepath.Base(filename)
	}
	name = filepath.Base(name)
	if !validAttachmentName(name) || strings.ContainsRune(name, 0) {
		return result, fmt.Errorf("附件名称无效")
	}
	source, err := openRegular(filename)
	if err != nil {
		return result, err
	}
	defer source.Close()
	stat, err := source.Stat()
	if err != nil {
		return result, err
	}
	if stat.Size() > int64(contracts.Limits.AttachmentBytes) {
		return result, fmt.Errorf("附件超过 128 MiB 大小预算")
	}
	if err := privateDirectory(library.Directory); err != nil {
		return result, err
	}
	temporary, err := os.CreateTemp(library.Directory, ".import-*.tmp")
	if err != nil {
		return result, err
	}
	defer os.Remove(temporary.Name())
	defer temporary.Close()
	hash := sha256.New()
	count, err := io.Copy(io.MultiWriter(temporary, hash), io.LimitReader(contextReader{ctx, source}, int64(contracts.Limits.AttachmentBytes)+1))
	if err != nil {
		return result, err
	}
	final, err := source.Stat()
	if err != nil || count != stat.Size() || final.Size() != stat.Size() || final.ModTime() != stat.ModTime() {
		return result, fmt.Errorf("所选文件在导入期间发生变化，请重试")
	}
	if err := temporary.Sync(); err != nil {
		return result, err
	}
	temporary.Close()
	id := "sha256:" + hex.EncodeToString(hash.Sum(nil))
	library.mu.Lock()
	defer library.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return result, err
	}
	target, err := library.objectPath(id)
	if err != nil {
		return result, err
	}
	existing, metadata, existingError := library.openLocked(id, nil)
	if existingError == nil {
		existing.Close()
		return Asset{id, name, metadata}, nil
	}
	if _, err := regularFile(target); err != nil {
		return result, err
	}
	if _, err := os.Stat(target); err == nil {
		if !repair {
			return result, existingError
		}
		if err := os.Link(target, filepath.Join(library.Directory, ".corrupt-"+identifier()+".bak")); err != nil {
			return result, err
		}
		if err := os.Rename(temporary.Name(), target); err != nil {
			return result, err
		}
	} else if os.IsNotExist(err) {
		if err := os.Link(temporary.Name(), target); err != nil {
			return result, err
		}
	} else {
		return result, err
	}
	installed, metadata, err := library.openLocked(id, nil)
	if err != nil {
		return result, err
	}
	installed.Close()
	library.pinned[id] = true
	return Asset{id, name, metadata}, nil
}

func (library *Attachments) CopyTo(ctx context.Context, id, filename string) error {
	file, metadata, err := library.Open(id, nil)
	if err != nil {
		return err
	}
	defer file.Close()
	return AtomicFile(ctx, filename, func(writer io.Writer) error {
		digest := sha256.New()
		count, err := io.Copy(io.MultiWriter(writer, digest), contextReader{ctx, file})
		if err != nil {
			return err
		}
		if count != metadata.ByteLength || hex.EncodeToString(digest.Sum(nil)) != id[7:] {
			return fmt.Errorf("附件在保存期间发生变化")
		}
		return nil
	})
}

func (library *Attachments) Preview(id string, thumbnail bool) (map[string]any, error) {
	file, metadata, err := library.Open(id, nil)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	previewable := strings.HasPrefix(metadata.MediaType, "image/") && metadata.ByteLength <= int64(contracts.Limits.ImageBytes) && metadata.Width > 0 && metadata.Height > 0 && int64(metadata.Width) <= int64(contracts.Limits.ImagePixels)/int64(metadata.Height)
	result := map[string]any{"metadata": metadata, "previewable": previewable}
	if !previewable {
		return result, nil
	}
	var output bytes.Buffer
	mediaType := metadata.MediaType
	if thumbnail {
		decoded, _, err := image.Decode(file)
		if err != nil {
			return nil, fmt.Errorf("图片解码失败")
		}
		width, height := metadata.Width, metadata.Height
		if width > 800 || height > 800 {
			scale := max(width, height)
			width = max(1, width*800/scale)
			height = max(1, height*800/scale)
		}
		resized := image.NewRGBA(image.Rect(0, 0, width, height))
		draw.ApproxBiLinear.Scale(resized, resized.Bounds(), decoded, decoded.Bounds(), draw.Src, nil)
		if err := png.Encode(&output, resized); err != nil {
			return nil, err
		}
		mediaType = "image/png"
	} else if _, err := io.Copy(&output, file); err != nil {
		return nil, err
	}
	result["dataUrl"] = "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(output.Bytes())
	return result, nil
}

const uploadTimeout = 15 * time.Minute

func (upload *upload) stop() {
	upload.timer.Stop()
	upload.stopPageWatch()
}

func (library *Attachments) cancelUploadLocked(id string) {
	if upload := library.uploads[id]; upload != nil {
		delete(library.uploads, id)
		upload.stop()
		upload.file.Close()
		os.Remove(upload.file.Name())
	}
}

func (library *Attachments) expireUploadsLocked() {
	now := time.Now()
	for id, upload := range library.uploads {
		if upload.context.Err() != nil || !now.Before(upload.expires) {
			library.cancelUploadLocked(id)
		}
	}
}

func (library *Attachments) CancelUploads() {
	library.mu.Lock()
	defer library.mu.Unlock()
	for id := range library.uploads {
		library.cancelUploadLocked(id)
	}
}

// RecoverUploads runs after the application owns its single-instance lock.
func (library *Attachments) RecoverUploads() error {
	library.mu.Lock()
	defer library.mu.Unlock()
	if len(library.uploads) != 0 {
		return fmt.Errorf("附件传输仍在进行，无法恢复临时文件")
	}
	if err := privateDirectory(library.Directory); err != nil {
		return err
	}
	entries, err := os.ReadDir(library.Directory)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Type().IsRegular() && strings.HasPrefix(entry.Name(), ".upload-") && strings.HasSuffix(entry.Name(), ".tmp") {
			if err := os.Remove(filepath.Join(library.Directory, entry.Name())); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
	}
	return nil
}

func (library *Attachments) BeginUpload(ctx context.Context, id, name string, size int64) error {
	library.mu.Lock()
	defer library.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if !regexp.MustCompile(`^[a-zA-Z0-9_-]{1,100}$`).MatchString(id) || size < 0 || size > int64(contracts.Limits.AttachmentBytes) || !validAttachmentName(name) || strings.ContainsRune(name, 0) {
		return fmt.Errorf("附件传输参数无效")
	}
	library.expireUploadsLocked()
	if _, exists := library.uploads[id]; exists {
		return fmt.Errorf("附件传输标识重复")
	}
	var total int64
	for _, item := range library.uploads {
		total += item.size
	}
	if len(library.uploads) >= contracts.Limits.ImportFiles || total+size > int64(contracts.Limits.ImportBytes) {
		return fmt.Errorf("附件批次超过处理预算")
	}
	if err := privateDirectory(library.Directory); err != nil {
		return err
	}
	file, err := os.CreateTemp(library.Directory, ".upload-*.tmp")
	if err != nil {
		return err
	}
	item := &upload{file: file, name: name, size: size, expires: time.Now().Add(uploadTimeout), context: ctx}
	library.uploads[id] = item
	item.timer = time.AfterFunc(uploadTimeout, func() {
		library.mu.Lock()
		defer library.mu.Unlock()
		if library.uploads[id] == item {
			library.expireUploadsLocked()
		}
	})
	item.stopPageWatch = context.AfterFunc(ctx, func() {
		library.mu.Lock()
		defer library.mu.Unlock()
		if library.uploads[id] == item {
			library.cancelUploadLocked(id)
		}
	})
	return nil
}

func (library *Attachments) UploadChunk(id string, offset int64, encoded string) error {
	if len(encoded) > (contracts.Limits.OperationLimits.AttachmentChunkBytes+2)/3*4 {
		return fmt.Errorf("附件分块超过 1 MiB")
	}
	value, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return fmt.Errorf("附件分块无效")
	}
	library.mu.Lock()
	defer library.mu.Unlock()
	library.expireUploadsLocked()
	upload := library.uploads[id]
	if upload == nil || offset != upload.written || upload.written+int64(len(value)) > upload.size {
		return fmt.Errorf("附件传输偏移无效")
	}
	count, err := upload.file.Write(value)
	upload.written += int64(count)
	upload.expires = time.Now().Add(uploadTimeout)
	upload.timer.Reset(uploadTimeout)
	if err == nil && count != len(value) {
		return io.ErrShortWrite
	}
	return err
}

func (library *Attachments) FinishUpload(ctx context.Context, id string) (Asset, error) {
	library.mu.Lock()
	library.expireUploadsLocked()
	upload := library.uploads[id]
	if upload == nil || upload.written != upload.size {
		library.mu.Unlock()
		return Asset{}, fmt.Errorf("附件传输尚未完成")
	}
	delete(library.uploads, id)
	upload.stop()
	err := upload.file.Sync()
	upload.file.Close()
	library.mu.Unlock()
	defer os.Remove(upload.file.Name())
	if err != nil {
		return Asset{}, err
	}
	return library.Import(ctx, upload.file.Name(), upload.name, false)
}

func (library *Attachments) CancelUpload(id string) {
	library.mu.Lock()
	defer library.mu.Unlock()
	library.cancelUploadLocked(id)
}

func (library *Attachments) Scan(protected []string) (map[string]any, error) {
	library.mu.Lock()
	defer library.mu.Unlock()
	library.expireUploadsLocked()
	candidates, count, err := library.scanLocked(protected)
	if err != nil {
		return nil, err
	}
	ticket := identifier()
	ids := []string{}
	var size int64
	for _, item := range candidates {
		ids = append(ids, item.AssetID)
		size += item.ByteLength
	}
	library.scans = map[string]scanTicket{ticket: {ids: ids, expires: time.Now().Add(time.Minute)}}
	return map[string]any{"candidates": candidates, "protectedCount": count, "byteLength": size, "ticket": ticket}, nil
}

func (library *Attachments) scanLocked(protected []string) ([]Candidate, int, error) {
	if err := privateDirectory(library.Directory); err != nil {
		return nil, 0, err
	}
	protectedSet := map[string]bool{}
	for key := range library.pinned {
		protectedSet[key] = true
	}
	for _, id := range protected {
		if _, err := assetDigest(id); err != nil {
			return nil, 0, err
		}
		protectedSet[id] = true
	}
	parents, err := os.ReadDir(library.Directory)
	if err != nil {
		return nil, 0, err
	}
	candidates := []Candidate{}
	for _, parent := range parents {
		if !regexp.MustCompile(`^[a-f0-9]{2}$`).MatchString(parent.Name()) {
			continue
		}
		if !parent.IsDir() || parent.Type()&os.ModeSymlink != 0 {
			return nil, 0, fmt.Errorf("附件库结构无效，已停止清理")
		}
		entries, err := os.ReadDir(filepath.Join(library.Directory, parent.Name()))
		if err != nil {
			return nil, 0, err
		}
		for _, entry := range entries {
			id := "sha256:" + entry.Name()
			if _, err := assetDigest(id); err != nil || !strings.HasPrefix(entry.Name(), parent.Name()) || entry.Type()&os.ModeSymlink != 0 || entry.IsDir() {
				return nil, 0, fmt.Errorf("附件对象无效，已停止清理")
			}
			if protectedSet[id] {
				continue
			}
			info, err := entry.Info()
			if err != nil || !info.Mode().IsRegular() {
				return nil, 0, fmt.Errorf("附件对象无效")
			}
			candidates = append(candidates, Candidate{id, info.Size()})
		}
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].AssetID < candidates[j].AssetID })
	return candidates, len(protectedSet), nil
}

func (library *Attachments) Clean(protected []string, ticket string) (map[string]any, error) {
	library.mu.Lock()
	defer library.mu.Unlock()
	library.expireUploadsLocked()
	scan, exists := library.scans[ticket]
	delete(library.scans, ticket)
	if !exists || time.Now().After(scan.expires) || len(library.uploads) > 0 {
		return nil, fmt.Errorf("清理扫描已过期或有在途导入，请重新扫描")
	}
	candidates, _, err := library.scanLocked(protected)
	if err != nil {
		return nil, err
	}
	allowed := map[string]bool{}
	for _, id := range scan.ids {
		allowed[id] = true
	}
	quarantine := filepath.Join(library.Directory, "quarantine")
	if err := privateDirectory(quarantine); err != nil {
		return nil, err
	}
	moved, removed := 0, 0
	for _, item := range candidates {
		if !allowed[item.AssetID] {
			continue
		}
		source, err := library.objectPath(item.AssetID)
		if err != nil {
			return nil, err
		}
		target := filepath.Join(quarantine, item.AssetID[7:])
		if _, err := regularFile(target); err != nil {
			return nil, err
		}
		if err := os.Link(source, target); err != nil {
			if !os.IsExist(err) {
				return nil, err
			}
			file, err := openRegular(target)
			if err != nil {
				return nil, err
			}
			actual, _, err := inspectFile(file)
			file.Close()
			if err != nil || actual != item.AssetID {
				return nil, fmt.Errorf("%w：隔离区已有对象损坏，原件已保留", ErrAttachmentIntegrity)
			}
		}
		now := time.Now()
		if err := os.Chtimes(target, now, now); err != nil {
			return nil, err
		}
		if err := os.Remove(source); err != nil {
			return nil, err
		}
		moved++
	}
	protectedSet := map[string]bool{}
	for _, id := range protected {
		protectedSet[id] = true
	}
	for id := range library.pinned {
		protectedSet[id] = true
	}
	entries, err := os.ReadDir(quarantine)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		id := "sha256:" + entry.Name()
		if _, err := assetDigest(id); err != nil || entry.Type()&os.ModeSymlink != 0 || entry.IsDir() {
			return nil, fmt.Errorf("隔离区内容无效，已停止清理")
		}
		info, err := entry.Info()
		if err != nil {
			return nil, err
		}
		if !protectedSet[id] && time.Since(info.ModTime()) >= 30*24*time.Hour {
			if err := os.Remove(filepath.Join(quarantine, entry.Name())); err != nil {
				return nil, err
			}
			removed++
		}
	}
	return map[string]any{"moved": moved, "removed": removed}, nil
}
