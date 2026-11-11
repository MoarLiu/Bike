package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

var errFileTargetChanged = errors.New("写入期间目标文件已变化，请重试")

func identifier() string {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		panic(err)
	}
	return hex.EncodeToString(value)
}

func privateDirectory(name string) error {
	if err := os.MkdirAll(name, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(name)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("目录无效或是符号链接")
	}
	return nil
}

func regularFile(name string) (os.FileInfo, error) {
	info, err := os.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("文件目标无效或是符号链接")
	}
	return info, nil
}

func openRegular(name string) (*os.File, error) {
	file, err := os.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, fmt.Errorf("所选内容不是普通文件")
	}
	return file, nil
}

// AtomicFile verifies the selected destination again before installing a fully
// flushed temporary file. A failed write never truncates an existing target.
func AtomicFile(ctx context.Context, name string, write func(io.Writer) error) error {
	original, err := regularFile(name)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(filepath.Join(filepath.Dir(name), ".bike-"+identifier()+".tmp"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	defer file.Close()
	if original != nil {
		if err := file.Chmod(original.Mode().Perm()); err != nil {
			return err
		}
	}
	if err := write(file); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	current, err := regularFile(name)
	if err != nil {
		return err
	}
	if (original == nil) != (current == nil) || original != nil && (!os.SameFile(original, current) || original.Size() != current.Size() || original.ModTime() != current.ModTime()) {
		return errFileTargetChanged
	}
	if err := os.Rename(temporary, name); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(name))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func writeBytes(name string, value []byte) error {
	return AtomicFile(context.Background(), name, func(writer io.Writer) error { _, err := writer.Write(value); return err })
}

func readBounded(name string, maximum int64) ([]byte, error) {
	file, err := openRegular(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if info.Size() > maximum {
		return nil, fmt.Errorf("文件超过读取预算")
	}
	value, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(value)) > maximum {
		return nil, fmt.Errorf("文件超过读取预算")
	}
	return value, nil
}

type contextReader struct {
	context context.Context
	source  io.Reader
}

func (reader contextReader) Read(value []byte) (int, error) {
	if err := reader.context.Err(); err != nil {
		return 0, err
	}
	return reader.source.Read(value)
}
