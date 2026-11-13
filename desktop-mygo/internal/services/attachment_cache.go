package services

import (
	"fmt"
	"os"
	"reflect"
)

type verifiedAttachment struct {
	fingerprint string
	metadata    Metadata
}

func attachmentFingerprint(info os.FileInfo) string {
	if info == nil || info.Sys() == nil {
		return ""
	}
	value := reflect.Indirect(reflect.ValueOf(info.Sys()))
	if value.Kind() != reflect.Struct {
		return ""
	}
	dev, ino := value.FieldByName("Dev"), value.FieldByName("Ino")
	changed := value.FieldByName("Ctimespec")
	if !changed.IsValid() {
		changed = value.FieldByName("Ctim")
	}
	if !dev.IsValid() || !ino.IsValid() || !changed.IsValid() {
		return ""
	}
	return fmt.Sprintf("%v:%v:%d:%d:%v", dev.Interface(), ino.Interface(), info.Size(), info.ModTime().UnixNano(), changed.Interface())
}
