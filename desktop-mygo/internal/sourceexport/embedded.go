//go:build mygo_source_exporter

package sourceexport

import "embed"

// This is application code only. The user supplies the installed runtime.
//
//go:embed generated/*
var payload embed.FS

func payloadFiles() (map[string][]byte, error) {
	entries, err := payload.ReadDir("generated")
	if err != nil {
		return nil, err
	}
	result := map[string][]byte{}
	for _, entry := range entries {
		value, err := payload.ReadFile("generated/" + entry.Name())
		if err != nil {
			return nil, err
		}
		result[entry.Name()] = value
	}
	return result, nil
}
