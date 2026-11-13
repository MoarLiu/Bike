package services

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"time"
)

func CleanupOpenFiles() error {
	entries, err := os.ReadDir(os.TempDir())
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || !regexp.MustCompile(`^bike-(mygo-)?open-`).MatchString(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		stat := reflect.Indirect(reflect.ValueOf(info.Sys()))
		if stat.Kind() != reflect.Struct {
			continue
		}
		uid := stat.FieldByName("Uid")
		if !uid.IsValid() || uid.Uint() != uint64(os.Getuid()) {
			continue
		}
		if time.Since(info.ModTime()) >= 7*24*time.Hour {
			_ = os.RemoveAll(filepath.Join(os.TempDir(), entry.Name()))
		}
	}
	return nil
}

func CleanupTransferFiles(directory string) error {
	info, err := os.Lstat(directory)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return os.ErrInvalid
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.Type().IsRegular() || !regexp.MustCompile(`^[a-f0-9]{64}\.(part|json)$`).MatchString(entry.Name()) {
			continue
		}
		stat, err := entry.Info()
		if err != nil {
			return err
		}
		if time.Since(stat.ModTime()) >= 7*24*time.Hour {
			if err := os.Remove(filepath.Join(directory, entry.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}
