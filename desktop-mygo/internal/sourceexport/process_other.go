//go:build !darwin && !linux

package sourceexport

import (
	"context"
	"fmt"
)

func runHelper(_ context.Context, _, _, _ string) error {
	return fmt.Errorf("installed Electron source export requires macOS")
}
