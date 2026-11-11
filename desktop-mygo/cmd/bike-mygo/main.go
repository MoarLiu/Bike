package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/mcp"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/platform"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/product"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/sourceexport"
)

func run() error {
	version := flag.Bool("version", false, "print the product/build identity as JSON")
	fileMode := flag.Bool("mcp-file", false, "serve File MCP over stdio without launching the GUI")
	liveMode := flag.Bool("mcp-live", false, "serve authorized Live MCP over stdio")
	mode := flag.String("mode", "readonly", "File MCP authorization mode, readonly or write")
	workspace := flag.String("workspace", "", "explicit workspace JSON file for File MCP")
	discovery := flag.String("live-discovery", "", "explicit MyGO Live discovery file, normally selected from the channel profile")
	exportSource := flag.Bool("export-electron-profile", false, "export a closed Electron Bike 2.0.0 profile as a complete independent ZIP")
	electronApp := flag.String("electron-app", "", "explicit installed Electron Bike.app used only as a temporary source reader runtime")
	sourceProfile := flag.String("source-profile", "", "explicit closed Electron profile directory to snapshot without modifying it")
	output := flag.String("output", "", "destination full-copy ZIP")
	preferences := flag.Bool("include-preferences", false, "include supported theme, navigation and AI endpoint preferences")
	credentials := flag.Bool("include-credentials", false, "explicitly include the source AI API key")
	flag.Parse()
	sourceArguments := *electronApp != "" || *sourceProfile != "" || *output != "" || *preferences || *credentials
	if flag.NArg() != 0 || (*fileMode && *liveMode) || (*workspace != "" && !*fileMode) || (*discovery != "" && !*liveMode) || (*version && (*fileMode || *liveMode)) || (*mode != "readonly" && *mode != "write") || (*mode != "readonly" && !*fileMode) ||
		(*exportSource && (*fileMode || *liveMode || *version)) || (sourceArguments && !*exportSource) {
		return fmt.Errorf("invalid or conflicting command-line arguments")
	}
	info, err := product.Current()
	if err != nil {
		return err
	}
	if *version {
		return json.NewEncoder(os.Stdout).Encode(info)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *exportSource {
		result, err := sourceexport.Run(ctx, sourceexport.Options{ElectronApp: *electronApp, SourceProfile: *sourceProfile,
			Output: *output, Preferences: *preferences, Credentials: *credentials})
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(result)
	}
	if *fileMode {
		if *workspace == "" {
			return fmt.Errorf("--mcp-file requires --workspace to select an explicit JSON export")
		}
		return mcp.Run(ctx, mcp.NewFileStore(*workspace, *mode), info)
	}
	if *liveMode {
		if *discovery == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return err
			}
			*discovery = info.DiscoveryPath(home)
		}
		store, err := mcp.OpenLive(ctx, *discovery)
		if err != nil {
			return err
		}
		defer store.Close()
		return mcp.Run(ctx, store, info)
	}
	return platform.Run(info)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
