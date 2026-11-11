//go:build mygo_frontend

package frontend

import (
	"embed"
	"io/fs"
)

// dist is populated from the shared Vite build before compiling the app.
//
//go:embed all:dist
var files embed.FS

func Files() (fs.FS, error) {
	return fs.Sub(files, "dist")
}
