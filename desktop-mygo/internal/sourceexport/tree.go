package sourceexport

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const snapshotBytes int64 = 16 * 1024 * 1024 * 1024
const snapshotFiles = 100000

func within(parent, child string) bool {
	relative, err := filepath.Rel(parent, child)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator))
}

// Fingerprint every entry, including symlink targets, without following them.
// Copies use fresh files. Source profiles cannot contain symlinks or devices.
func fingerprint(ctx context.Context, root string, allowLinks bool) (string, error) {
	hash := sha256.New()
	var total int64
	count := 0
	err := filepath.WalkDir(root, func(name string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		count++
		if count > snapshotFiles {
			return fmt.Errorf("源目录超过 100,000 项处理预算")
		}
		info, err := os.Lstat(name)
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(root, name)
		fmt.Fprintf(hash, "%s\x00%s\x00%d\x00%d\x00", relative, info.Mode(), info.Size(), info.ModTime().UnixNano())
		switch {
		case info.Mode().IsRegular():
			total += info.Size()
			if total > snapshotBytes {
				return fmt.Errorf("源目录超过 16 GiB 处理预算")
			}
			file, err := os.Open(name)
			if err != nil {
				return err
			}
			before, err := file.Stat()
			if err == nil && !os.SameFile(info, before) {
				err = fmt.Errorf("源文件在快照期间发生变化")
			}
			if err == nil {
				var copied int64
				copied, err = copyContext(ctx, hash, io.LimitReader(file, info.Size()+1))
				if err == nil && copied != info.Size() {
					err = fmt.Errorf("源文件长度在快照期间发生变化")
				}
			}
			after, statErr := file.Stat()
			file.Close()
			if err != nil {
				return err
			}
			if statErr != nil || !os.SameFile(info, after) || info.Size() != after.Size() || info.ModTime() != after.ModTime() {
				return fmt.Errorf("源文件在快照期间发生变化")
			}
		case info.IsDir():
		case info.Mode()&os.ModeSymlink != 0 && allowLinks:
			target, err := os.Readlink(name)
			if err != nil {
				return err
			}
			resolved, err := filepath.EvalSymlinks(name)
			if err != nil || !within(root, resolved) {
				return fmt.Errorf("运行时包含越界符号链接")
			}
			hash.Write([]byte(target))
		default:
			return fmt.Errorf("源目录包含符号链接、socket 或其他特殊文件，请先完全退出源应用")
		}
		hash.Write([]byte{0})
		return nil
	})
	return hex.EncodeToString(hash.Sum(nil)), err
}

func copyContext(ctx context.Context, destination io.Writer, source io.Reader) (int64, error) {
	buffer := make([]byte, 128*1024)
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		count, readErr := source.Read(buffer)
		if count != 0 {
			written, err := destination.Write(buffer[:count])
			total += int64(written)
			if err != nil {
				return total, err
			}
			if written != count {
				return total, io.ErrShortWrite
			}
		}
		if readErr == io.EOF {
			return total, nil
		}
		if readErr != nil {
			return total, readErr
		}
	}
}

func copyTree(ctx context.Context, source, destination string, runtimeCopy bool) error {
	var total int64
	count := 0
	return filepath.WalkDir(source, func(name string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		count++
		if count > snapshotFiles {
			return fmt.Errorf("源目录超过 100,000 项处理预算")
		}
		relative, _ := filepath.Rel(source, name)
		if runtimeCopy && (relative == "Contents/Resources/app.asar" || relative == "Contents/Resources/app.asar.unpacked" ||
			relative == "Contents/Resources/app" || relative == "Contents/Resources/app-update.yml") {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		target := filepath.Join(destination, relative)
		info, err := os.Lstat(name)
		if err != nil {
			return err
		}
		switch {
		case info.IsDir():
			return os.MkdirAll(target, 0700)
		case info.Mode().IsRegular():
			total += info.Size()
			if total > snapshotBytes {
				return fmt.Errorf("源目录超过 16 GiB 处理预算")
			}
			input, err := os.Open(name)
			if err != nil {
				return err
			}
			defer input.Close()
			opened, err := input.Stat()
			if err != nil || !os.SameFile(info, opened) {
				return fmt.Errorf("源文件在复制期间发生变化")
			}
			output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm()|0600)
			if err != nil {
				return err
			}
			copied, err := copyContext(ctx, output, io.LimitReader(input, info.Size()+1))
			closeErr := output.Close()
			if err != nil {
				return err
			}
			after, statErr := input.Stat()
			if statErr != nil || copied != info.Size() || after.Size() != info.Size() || after.ModTime() != info.ModTime() {
				return fmt.Errorf("源文件在复制期间发生变化")
			}
			return closeErr
		case runtimeCopy && info.Mode()&os.ModeSymlink != 0:
			link, err := os.Readlink(name)
			if err != nil {
				return err
			}
			resolved, err := filepath.EvalSymlinks(name)
			if err != nil || !within(source, resolved) || filepath.IsAbs(link) {
				return fmt.Errorf("运行时包含越界或绝对符号链接")
			}
			return os.Symlink(link, target)
		default:
			return fmt.Errorf("源目录包含活动进程或不支持的特殊文件")
		}
	})
}

func closedProfile(profile string) error {
	for _, name := range []string{"SingletonLock", "SingletonSocket", "SingletonCookie"} {
		_, err := os.Lstat(filepath.Join(profile, name))
		if !os.IsNotExist(err) {
			return fmt.Errorf("源 profile 存在 %s，请完全退出 Electron Bike 后重试", name)
		}
	}
	return nil
}
