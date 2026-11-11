//go:build !unix

package mcp

import "os"

func ownedByCurrentUser(info os.FileInfo) bool { return false }
