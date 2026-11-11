//go:build !mygo_source_exporter

package sourceexport

import "fmt"

func payloadFiles() (map[string][]byte, error) {
	return nil, fmt.Errorf("source exporter resources were not built")
}
