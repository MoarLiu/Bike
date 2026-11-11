//go:build !mygo_frontend

package frontend

import (
	"fmt"
	"io/fs"
)

func Files() (fs.FS, error) {
	return nil, fmt.Errorf("build the embedded frontend with npm run mygo:build")
}
